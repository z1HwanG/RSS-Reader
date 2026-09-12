//! 网络层：HTTP 客户端构建（UA / 代理 / 超时）、SSRF 防护、代理配置与连通性测试
use super::error::CommandError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, RwLock};

/// 代理配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProxyConfig {
    /// 是否启用代理
    pub enabled: bool,
    /// 代理主机
    pub host: Option<String>,
    /// 代理端口
    pub port: Option<u16>,
    /// 代理类型：None/"http" = HTTP 代理，"socks5" = SOCKS5 代理
    #[serde(default)]
    pub kind: Option<String>,
}

pub(crate) const BROWSER_USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
    "AppleWebKit/537.36 (KHTML, like Gecko) ",
    "Chrome/124.0.0.0 Safari/537.36",
);

/// 粗略判断响应字节是否更像 HTML 网页（用于给出"填了网页而非订阅源"的提示）
pub(crate) fn looks_like_html(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    s.contains("<!doctype html")
        || s.contains("<html")
        || (s.contains("<head") && s.contains("<body"))
}

/// 提取错误的底层原因链。reqwest 顶层 Display 只有 "error sending request for url (...)"，
/// 真实原因（连接拒绝 / 超时 / 证书错误等）在 source() 链里，逐层取出便于用户定位。
pub(crate) fn root_cause_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut source = e.source();
    while let Some(err) = source {
        parts.push(err.to_string());
        source = err.source();
    }
    if parts.is_empty() {
        e.to_string()
    } else {
        parts.join(" → ")
    }
}

/// 规范化代理主机：剥离误填的 scheme 前缀与结尾斜杠（如 "http://127.0.0.1/"）
pub(crate) fn normalize_proxy_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// 代理协议：默认 HTTP；kind = "socks5" 时走 socks5h（域名交由代理解析，规避本地 DNS 污染）
pub(crate) fn proxy_scheme(cfg: &ProxyConfig) -> &'static str {
    if cfg.kind.as_deref() == Some("socks5") {
        "socks5h"
    } else {
        "http"
    }
}

pub struct ClientCache(Mutex<HashMap<String, Client>>);

impl ClientCache {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl Default for ClientCache {
    fn default() -> Self {
        Self::new()
    }
}

/// 直连（显式 no_proxy）客户端缓存键
const DIRECT_CLIENT_KEY: &str = "direct-noproxy";

/// 客户端缓存键：代理配置签名（直连 / 指定代理）
fn proxy_signature(proxy: Option<&ProxyConfig>) -> String {
    match proxy {
        Some(cfg) if cfg.enabled => match (&cfg.host, cfg.port) {
            (Some(host), Some(port)) => {
                format!(
                    "{}://{}:{}",
                    proxy_scheme(cfg),
                    normalize_proxy_host(host),
                    port
                )
            }
            _ => "direct".to_string(),
        },
        _ => "direct".to_string(),
    }
}

/// 取缓存客户端；未命中时构建并写回（缓存上限 4 个，代理配置变更极少）
fn cached_client_with<F>(cache: &ClientCache, key: &str, build: F) -> Result<Client, CommandError>
where
    F: FnOnce() -> Result<Client, CommandError>,
{
    if let Ok(map) = cache.0.lock() {
        if let Some(client) = map.get(key) {
            return Ok(client.clone());
        }
    }
    let client = build()?;
    if let Ok(mut map) = cache.0.lock() {
        if map.len() >= 4 {
            map.clear();
        }
        map.insert(key.to_string(), client.clone());
    }
    Ok(client)
}

/// 按代理配置复用客户端
pub(crate) fn cached_http_client(
    cache: &ClientCache,
    proxy: Option<&ProxyConfig>,
) -> Result<Client, CommandError> {
    cached_client_with(cache, &proxy_signature(proxy), || build_http_client(proxy))
}

// ===== SSRF 防护 =====
//
// 订阅源地址、文章正文里的图片 / 原文链接都来自订阅内容（作者可控）。
// 若不加限制，恶意订阅源可以让应用去请求 http://127.0.0.1:* 、内网管理页、
// 云元数据地址（169.254.169.254）并把响应带回 webview —— 即内网探测。
// 防护分两层：
// 1. 请求前校验目标 URL（ensure_public_http_target）：字面 IP 主机直接判公网性；
// 2. 连接时校验（PublicOnlyResolver 挂在出站客户端上）：域名在真正发起连接前解析，
//    解析结果含任何内网 IP 就拒绝连接。重定向、meta refresh 的每一跳用的都是同一个
//    客户端，因此自动被覆盖；「校验的地址」与「实际连接的地址」是同一个解析结果，
//    不存在 DNS 换绑（rebinding）窗口。

/// 是否为可直连的公网 IP：回环、私网、链路本地、CGNAT、文档 / 基准测试段等一律视为内网
pub(crate) fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || a == 0                              // 0.0.0.0/8 「本网络」段
                || (a == 100 && (b & 0xC0) == 64)      // 100.64.0.0/10 运营商级 NAT
                || (a == 192 && b == 0 && c == 0)      // 192.0.0.0/24 IETF 协议分配
                || (a == 192 && b == 0 && c == 2)      // 192.0.2.0/24 TEST-NET-1
                || (a == 198 && (b == 18 || b == 19))  // 198.18.0.0/15 网络基准测试
                || (a == 198 && b == 51 && c == 100)   // 198.51.100.0/24 TEST-NET-2
                || (a == 203 && b == 0 && c == 113)    // 203.0.113.0/24 TEST-NET-3
                || a >= 240) // 240.0.0.0/4 保留段 + 广播
        }
        std::net::IpAddr::V6(v6) => {
            // ::ffff:x.y.z.w 形式的 IPv4 映射地址按 IPv4 规则再判一次，防止用伪装绕过
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xFFC0) == 0xFE80         // fe80::/10 链路本地
                || (seg[0] & 0xFE00) == 0xFC00         // fc00::/7 唯一本地地址（ULA）
                || (seg[0] == 0x2001 && seg[1] == 0x0DB8)) // 2001:db8::/32 文档专用
        }
    }
}

/// 请求前的目标校验：仅 http(s)，且字面 IP 主机必须是公网地址。
/// 域名主机的内网拦截由 PublicOnlyResolver 在连接时保证（代理链路下域名由代理解析，
/// 本机拦截不到，这是已知边界：代理本身是用户配置的可信设施）。
pub(crate) fn ensure_public_http_target(parsed: &url::Url) -> Result<(), CommandError> {
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::InvalidUrl(parsed.to_string()));
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) if !is_public_ip(std::net::IpAddr::V4(ip)) => {
            return Err(CommandError::InvalidUrl(format!(
                "{parsed}：拒绝访问内网地址（防内网探测）"
            )));
        }
        Some(url::Host::Ipv6(ip)) if !is_public_ip(std::net::IpAddr::V6(ip)) => {
            return Err(CommandError::InvalidUrl(format!(
                "{parsed}：拒绝访问内网地址（防内网探测）"
            )));
        }
        _ => {}
    }
    Ok(())
}

/// 只放行公网解析结果的 DNS 解析器：挂在 RSS 抓取 / 图片抓取的出站客户端上，
/// 任何一次连接（含重定向后的目标）在发起前都要经过这里。
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?
                .collect();
            if let Some(addr) = addrs.iter().find(|addr| !is_public_ip(addr.ip())) {
                let err: Box<dyn std::error::Error + Send + Sync> = format!(
                    "域名 {host} 解析到内网地址 {}，已拒绝请求（防内网探测）",
                    addr.ip()
                )
                .into();
                return Err(err);
            }
            if addrs.is_empty() {
                let err: Box<dyn std::error::Error + Send + Sync> =
                    format!("域名 {host} 未解析到任何地址").into();
                return Err(err);
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// 单次请求总超时（订阅源抓取与图片抓取共用，两条链路行为保持一致）
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 直连客户端（图片抓取在代理链路失败时的兜底），超时与代理链路一致
pub(crate) fn cached_direct_client(cache: &ClientCache) -> Result<Client, CommandError> {
    cached_client_with(cache, DIRECT_CLIENT_KEY, || {
        Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .no_proxy()
            .dns_resolver(std::sync::Arc::new(PublicOnlyResolver))
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| CommandError::Network(root_cause_chain(&e)))
    })
}

/// 构建带浏览器 UA + 代理的 HTTP 客户端
pub(crate) fn build_http_client(proxy: Option<&ProxyConfig>) -> Result<Client, CommandError> {
    let mut client_builder = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .dns_resolver(std::sync::Arc::new(PublicOnlyResolver))
        .timeout(REQUEST_TIMEOUT);

    if let Some(cfg) = proxy {
        if cfg.enabled {
            if let (Some(host), Some(port)) = (&cfg.host, cfg.port) {
                let host = normalize_proxy_host(host);
                let proxy_url = format!("{}://{}:{}", proxy_scheme(cfg), host, port);
                let proxy = reqwest::Proxy::all(&proxy_url).map_err(|e| {
                    CommandError::Network(format!("代理配置无效（{proxy_url}）: {e}"))
                })?;
                client_builder = client_builder.proxy(proxy);
            }
        }
    }

    client_builder
        .build()
        .map_err(|e| CommandError::Network(e.to_string()))
}

/// 代理连通性测试结果
#[derive(Debug, Clone, Serialize)]
pub struct ProxyTestResult {
    /// 往返耗时（毫秒）
    pub latency_ms: u64,
    /// 成功命中的探测目标 URL
    pub target: String,
}

/// 测试代理连通性：通过代理请求轻量探测地址，返回往返耗时
#[tauri::command]
pub async fn test_proxy(
    host: String,
    port: u16,
    kind: Option<String>,
) -> Result<ProxyTestResult, CommandError> {
    let host = normalize_proxy_host(&host);
    if host.is_empty() {
        return Err(CommandError::InvalidUrl("代理主机不能为空".into()));
    }

    let cfg = ProxyConfig {
        enabled: true,
        host: Some(host),
        port: Some(port),
        kind,
    };
    let proxy_url = format!(
        "{}://{}:{}",
        proxy_scheme(&cfg),
        cfg.host.as_deref().unwrap_or_default(),
        cfg.port.unwrap_or_default()
    );
    let proxy = reqwest::Proxy::all(&proxy_url)
        .map_err(|e| CommandError::Network(format!("代理配置无效（{proxy_url}）: {e}")))?;
    let client = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .proxy(proxy)
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;

    // 探测目标列表，任一成功即视为代理可用。不用单一目标：
    // 部分网络环境对特定域名存在 DNS 污染 / 分流规则（例如 msftconnecttest.com 被解析到
    // Akamai 节点，TLS 证书不匹配造成"代理坏了"的误报）。google / cloudflare 验证代理的
    // 出境能力，baidu 验证代理链路本身。
    const PROBE_TARGETS: [&str; 3] = [
        "https://www.google.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
        "https://www.baidu.com/favicon.ico",
    ];

    let mut failures: Vec<String> = Vec::new();
    for target in PROBE_TARGETS {
        let start = std::time::Instant::now();
        match client.get(target).send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    // 读掉响应体，保证计时覆盖完整往返（204 无 body，favicon 很小）
                    let _ = response.bytes().await;
                    return Ok(ProxyTestResult {
                        latency_ms: start.elapsed().as_millis() as u64,
                        target: target.to_string(),
                    });
                }
                failures.push(format!("{} → HTTP {}", target, status.as_u16()));
            }
            Err(e) => failures.push(format!("{} → {}", target, root_cause_chain(&e))),
        }
    }

    Err(CommandError::Network(format!(
        "所有探测目标均失败：{}",
        failures.join("；")
    )))
}

/// 应用级代理配置（由前端通过 update_proxy_setting 同步），
/// 供 rssimg 协议等没有 IPC 参数上下文的请求读取。
pub struct ProxySetting(pub RwLock<Option<ProxyConfig>>);

/// 同步代理配置到 Rust 侧（None = 不启用）
#[tauri::command]
pub fn update_proxy_setting(
    state: tauri::State<'_, ProxySetting>,
    proxy: Option<ProxyConfig>,
) -> Result<(), CommandError> {
    let mut guard = state
        .0
        .write()
        .map_err(|_| CommandError::Network("代理状态读取失败".into()))?;
    *guard = proxy.filter(|cfg| cfg.enabled);
    Ok(())
}
