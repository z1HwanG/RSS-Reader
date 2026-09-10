/*
 * 文件名: rss.rs
 * 描述: RSS 阅读器核心命令：状态持久化、订阅源抓取与解析、打开外部链接
 */
use feed_rs::parser;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock, RwLock};
use tauri::{AppHandle, Manager};
use thiserror::Error;

// ===== 错误类型 =====

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 序列化失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("网络请求失败: {0}")]
    Network(String),
    #[error("订阅源解析失败: {0}")]
    Parse(String),
    #[error("无效的 URL: {0}")]
    InvalidUrl(String),
    #[error("路径解析失败: {0}")]
    Path(String),
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

// ===== 数据模型 =====

/// 订阅源分组
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    /// 分组唯一 ID
    pub id: String,
    /// 分组名称
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Feed {
    /// 订阅源唯一 ID（URL 的 sha256 前 16 字符）
    pub id: String,
    /// 订阅源 URL
    pub url: String,
    /// 订阅源标题
    pub title: String,
    /// 订阅源描述
    pub description: Option<String>,
    /// 站点首页链接
    pub site_url: Option<String>,
    /// 订阅时间（ISO 8601 时间戳）
    pub added_at: String,
    /// 所属分组 ID（无分组为 None）
    #[serde(default)]
    pub group_id: Option<String>,
    /// 分组内排序序号
    #[serde(default)]
    pub sort_order: u32,
    /// 文章打开方式：None=内部阅读，Some("external")=外部浏览器
    #[serde(default)]
    pub open_method: Option<String>,
    /// 上次抓取响应的 ETag（条件请求用）
    #[serde(default)]
    pub etag: Option<String>,
    /// 上次抓取响应的 Last-Modified（条件请求用）
    #[serde(default)]
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Article {
    /// 文章唯一 ID（feed_id + entry 标识的 sha256 前 16 字符）
    pub id: String,
    /// 生成 id 用的 entry 标识（feed-rs 的 entry.id）。
    /// 订阅源 URL 变更后 id 需要按新 feed_id 重算，没有它就无法回溯原始标识；
    /// 旧数据缺该字段时为 None，前端退化为按链接 / 标题匹配。
    #[serde(default)]
    pub entry_key: Option<String>,
    /// 所属订阅源 ID
    pub feed_id: String,
    /// 文章标题
    pub title: Option<String>,
    /// 文章正文内容（HTML）
    pub content: Option<String>,
    /// 原文链接
    pub link: Option<String>,
    /// 发布日期（ISO 8601 时间戳）
    pub published_at: Option<String>,
    /// 是否已读
    pub read: bool,
    /// 是否收藏
    pub starred: bool,
}

/// 当前状态文件结构版本；新增字段或改变语义时递增，并在 migrate_state 中处理旧版本
/// v2 起 Article 增加 entry_key（旧文章缺省为 None，重算 id 时前端按链接 / 标题兜底）
pub const STATE_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppState {
    /// 状态文件结构版本（旧文件缺省为 0）
    #[serde(default)]
    pub schema_version: u32,
    pub feeds: Vec<Feed>,
    pub articles: Vec<Article>,
    #[serde(default)]
    pub groups: Vec<Group>,
}

/// 旧版本状态升级：当前只需补齐版本号，后续迁移逻辑集中写在这里
fn migrate_state(mut state: AppState) -> AppState {
    if state.schema_version < STATE_SCHEMA_VERSION {
        state.schema_version = STATE_SCHEMA_VERSION;
    }
    state
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub feed_id: String,
    pub feed_title: String,
    pub feed_description: Option<String>,
    pub feed_site_url: Option<String>,
    pub articles: Vec<Article>,
    /// 本次响应的 ETag（供下次条件请求）
    #[serde(default)]
    pub etag: Option<String>,
    /// 本次响应的 Last-Modified（供下次条件请求）
    #[serde(default)]
    pub last_modified: Option<String>,
    /// 订阅源未变化（304）：articles 为空
    #[serde(default)]
    pub not_modified: bool,
}

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

// ===== 工具函数 =====

/// 计算字符串的 sha256 哈希，返回前 16 个十六进制字符
fn short_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

/// 获取应用数据目录下的状态文件路径
fn state_file(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app.path().app_data_dir().map_err(|e| CommandError::Path(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(CommandError::Io)?;
    Ok(dir.join("state.json"))
}

/// 原子写入：先写同目录临时文件再改名，避免写入中途崩溃损坏状态文件
fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> Result<(), CommandError> {
    // 临时文件名 = 原文件名 + ".tmp"。不能用 with_extension("tmp")：那会把扩展名替换掉，
    // 使 backup.json 与 backup.opml 同时落到 backup.tmp 上互相覆盖。
    let tmp = path.with_file_name(match path.file_name() {
        Some(name) => format!("{}.tmp", name.to_string_lossy()),
        None => return Err(CommandError::Path(format!("无效路径: {}", path.display()))),
    });
    std::fs::write(&tmp, bytes).map_err(CommandError::Io)?;
    if let Err(rename_err) = std::fs::rename(&tmp, path) {
        // 个别文件系统在目标存在时拒绝覆盖：退化为先删后改名
        std::fs::remove_file(path).ok();
        std::fs::rename(&tmp, path).map_err(|_| CommandError::Io(rename_err))?;
    }
    Ok(())
}

/// 将 chrono 时间转换为 ISO 8601 字符串
fn to_iso_string(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339()
}

/// 浏览器风格 User-Agent，避免站点对非浏览器 UA 的拦截
const BROWSER_USER_AGENT: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
    "AppleWebKit/537.36 (KHTML, like Gecko) ",
    "Chrome/124.0.0.0 Safari/537.36",
);

/// 粗略判断响应字节是否更像 HTML 网页（用于给出"填了网页而非订阅源"的提示）
fn looks_like_html(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(1024)];
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    s.contains("<!doctype html")
        || s.contains("<html")
        || (s.contains("<head") && s.contains("<body"))
}

/// 提取错误的底层原因链。reqwest 顶层 Display 只有 "error sending request for url (...)"，
/// 真实原因（连接拒绝 / 超时 / 证书错误等）在 source() 链里，逐层取出便于用户定位。
fn root_cause_chain(e: &(dyn std::error::Error + 'static)) -> String {
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
fn normalize_proxy_host(host: &str) -> String {
    host.trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// 代理协议：默认 HTTP；kind = "socks5" 时走 socks5h（域名交由代理解析，规避本地 DNS 污染）
fn proxy_scheme(cfg: &ProxyConfig) -> &'static str {
    if cfg.kind.as_deref() == Some("socks5") {
        "socks5h"
    } else {
        "http"
    }
}

// ===== 命令实现 =====

/// 加载本地持久化状态（订阅源 + 文章）
/// 注意：async 命令在异步运行时执行，同步命令会阻塞主线程（UI 卡顿）
#[tauri::command]
pub async fn load_state(app: AppHandle) -> Result<AppState, CommandError> {
    let file = state_file(&app)?;
    if !file.exists() {
        return Ok(AppState::default());
    }
    let raw = std::fs::read_to_string(file).map_err(CommandError::Io)?;
    let state: AppState = serde_json::from_str(&raw).map_err(CommandError::Json)?;
    Ok(migrate_state(state))
}

/// 保存本地持久化状态
/// 用紧凑 JSON：状态可能含数万篇文章的正文，pretty 输出体积约大 30%、序列化也更慢
#[tauri::command]
pub async fn save_state(app: AppHandle, mut state: AppState) -> Result<(), CommandError> {
    let file = state_file(&app)?;
    state.schema_version = STATE_SCHEMA_VERSION;
    let raw = serde_json::to_string(&state).map_err(CommandError::Json)?;
    write_atomically(&file, raw.as_bytes())
}

/// HTTP 客户端缓存：按代理配置复用 Client，连接池与 TLS 会话可跨请求复用。
/// 图片抓取（同一 CDN 多张图）与订阅源抓取共享同一批连接，避免每次请求重新握手。
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
                format!("{}://{}:{}", proxy_scheme(cfg), normalize_proxy_host(host), port)
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
fn cached_http_client(cache: &ClientCache, proxy: Option<&ProxyConfig>) -> Result<Client, CommandError> {
    cached_client_with(cache, &proxy_signature(proxy), || build_http_client(proxy))
}

/// 单次请求总超时（订阅源抓取与图片抓取共用，两条链路行为保持一致）
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 直连客户端（图片抓取在代理链路失败时的兜底），超时与代理链路一致
fn cached_direct_client(cache: &ClientCache) -> Result<Client, CommandError> {
    cached_client_with(cache, DIRECT_CLIENT_KEY, || {
        Client::builder()
            .user_agent(BROWSER_USER_AGENT)
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| CommandError::Network(root_cause_chain(&e)))
    })
}

/// 构建带浏览器 UA + 代理的 HTTP 客户端
fn build_http_client(proxy: Option<&ProxyConfig>) -> Result<Client, CommandError> {
    let mut client_builder = Client::builder()
        .user_agent(BROWSER_USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(REQUEST_TIMEOUT);

    if let Some(cfg) = proxy {
        if cfg.enabled {
            if let (Some(host), Some(port)) = (&cfg.host, cfg.port) {
                let host = normalize_proxy_host(host);
                let proxy_url = format!("{}://{}:{}", proxy_scheme(cfg), host, port);
                let proxy = reqwest::Proxy::all(&proxy_url)
                    .map_err(|e| CommandError::Network(format!("代理配置无效（{proxy_url}）: {e}")))?;
                client_builder = client_builder.proxy(proxy);
            }
        }
    }

    client_builder
        .build()
        .map_err(|e| CommandError::Network(e.to_string()))
}

/// 抓取并解析一个 RSS/Atom 订阅源
#[tauri::command]
pub async fn fetch_feed(
    url: String,
    proxy: Option<ProxyConfig>,
    cache: tauri::State<'_, ClientCache>,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<FetchResult, CommandError> {
    let parsed_url = url::Url::parse(&url).map_err(|_| CommandError::InvalidUrl(url.clone()))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(CommandError::InvalidUrl(url));
    }

    let client = cached_http_client(&cache, proxy.as_ref())?;

    // 条件请求：带上上次的 ETag / Last-Modified，未变化时服务端返回 304
    let mut request = client.get(parsed_url.clone());
    if let Some(tag) = etag.as_deref().filter(|t| !t.is_empty()) {
        request = request.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    if let Some(since) = last_modified.as_deref().filter(|t| !t.is_empty()) {
        request = request.header(reqwest::header::IF_MODIFIED_SINCE, since);
    }

    let response = request
        .send()
        .await
        .map_err(|e| CommandError::Network(format!("{}：{}", parsed_url, root_cause_chain(&e))))?;

    let status = response.status();
    let resp_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let resp_last_modified = response
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // 304：订阅源未变化，直接返回，省掉下载与解析
    if status == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(FetchResult {
            feed_id: short_hash(&url),
            feed_title: String::new(),
            feed_description: None,
            feed_site_url: None,
            articles: Vec::new(),
            etag: resp_etag.or(etag),
            last_modified: resp_last_modified.or(last_modified),
            not_modified: true,
        });
    }

    if !status.is_success() {
        return Err(CommandError::Network(format!(
            "HTTP 状态码 {}（{}）",
            status.as_u16(),
            parsed_url
        )));
    }

    // 记录 Content-Type，用于识别"填了网页而非订阅源"的情况
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = response
        .bytes()
        .await
        .map_err(|e| CommandError::Network(format!("{}：{}", parsed_url, root_cause_chain(&e))))?;

    // 解析 feed（支持 RSS 2.0/1.0、Atom、JSON Feed）
    let feed = match parser::parse(bytes.as_ref()) {
        Ok(feed) => feed,
        Err(e) => {
            // 若返回的是网页，多半用户填了站点首页而非订阅源地址
            if content_type.contains("text/html") || looks_like_html(&bytes) {
                return Err(CommandError::Parse(
                    "返回的是网页而不是 RSS/Atom 订阅源。请检查地址是否为订阅源（一般以 .xml、/feed 或 /atom.xml 结尾）。".into(),
                ));
            }
            return Err(CommandError::Parse(format!("{}：{}", parsed_url, e)));
        }
    };

    let feed_id = short_hash(&url);

    // 提取订阅源元信息
    let feed_title = feed.title.as_ref()
        .map(|t| t.content.clone())
        .unwrap_or_else(|| url.clone());
    let feed_description = feed.description.as_ref().map(|d| d.content.clone());
    let feed_site_url = feed.links.first().map(|l| l.href.clone());

    // 提取文章
    let mut articles = Vec::new();
    for entry in &feed.entries {
        // entry.id 是 String（parser 保证非空，缺省时自动哈希生成）
        let entry_key = entry.id.as_str();

        // 文章 ID = feed_id + entry 标识的哈希
        let article_id = short_hash(&format!("{}:{}", feed_id, entry_key));

        // 提取正文内容（优先 content，其次 summary），and_then 展平嵌套 Option
        let content = entry.content.as_ref()
            .and_then(|c| c.body.clone())
            .or_else(|| entry.summary.as_ref().map(|s| s.content.clone()));

        // 提取发布日期
        let published_at = entry.published
            .or(entry.updated)
            .map(|dt| to_iso_string(&dt));

        articles.push(Article {
            id: article_id,
            entry_key: Some(entry_key.to_string()),
            feed_id: feed_id.clone(),
            title: entry.title.as_ref().map(|t| t.content.clone()),
            content,
            link: entry.links.first().map(|l| l.href.clone()),
            published_at,
            read: false,
            starred: false,
        });
    }

    Ok(FetchResult {
        feed_id,
        feed_title,
        feed_description,
        feed_site_url,
        articles,
        etag: resp_etag,
        last_modified: resp_last_modified,
        not_modified: false,
    })
}

/// 备份：把当前状态写入指定文件（JSON，保留可读缩进）
/// 状态由前端直接传入，避免再从磁盘读一遍整份 state.json
#[tauri::command]
pub async fn backup_state(target_path: String, state: AppState) -> Result<(), CommandError> {
    let raw = serde_json::to_string_pretty(&state).map_err(CommandError::Json)?;
    write_atomically(std::path::Path::new(&target_path), raw.as_bytes())
}

/// 还原：从指定文件读取 JSON 并返回完整状态（由前端调用 save_state 持久化）
#[tauri::command]
pub async fn restore_state(source_path: String) -> Result<AppState, CommandError> {
    let raw = std::fs::read_to_string(&source_path).map_err(CommandError::Io)?;
    let state: AppState = serde_json::from_str(&raw).map_err(CommandError::Json)?;
    Ok(migrate_state(state))
}

/// 读取任意文本文件（用于 OPML 导入等）
#[tauri::command]
pub async fn read_file_text(source_path: String) -> Result<String, CommandError> {
    std::fs::read_to_string(&source_path).map_err(CommandError::Io)
}

/// 写入文本到指定文件（用于 OPML 导出等）
#[tauri::command]
pub async fn write_file_text(target_path: String, content: String) -> Result<(), CommandError> {
    write_atomically(std::path::Path::new(&target_path), content.as_bytes())
}

/// 抓取文章原文 HTML（用于获取 RSS 摘要的完整正文）
#[tauri::command]
pub async fn fetch_article_html(
    url: String,
    proxy: Option<ProxyConfig>,
    cache: tauri::State<'_, ClientCache>,
) -> Result<String, CommandError> {
    let parsed_url = url::Url::parse(&url).map_err(|_| CommandError::InvalidUrl(url.clone()))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(CommandError::InvalidUrl(url));
    }

    let client = cached_http_client(&cache, proxy.as_ref())?;
    let response = client
        .get(parsed_url.clone())
        .send()
        .await
        .map_err(|e| CommandError::Network(format!("{}：{}", parsed_url, root_cause_chain(&e))))?;

    let status = response.status();
    if !status.is_success() {
        return Err(CommandError::Network(format!(
            "HTTP 状态码 {}（{}）",
            status.as_u16(),
            parsed_url
        )));
    }

    response
        .text()
        .await
        .map_err(|e| CommandError::Network(root_cause_chain(&e)))
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

// ===== 文章图片本地代理协议（rssimg） =====

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

/// 构造图片协议响应
fn img_response(status: u16, content_type: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", content_type);
    // 仅成功响应写长缓存；失败响应不能被浏览器缓存，否则修复后仍显示破图
    if status == 200 {
        builder = builder.header("Cache-Control", "public, max-age=604800");
    }
    builder.body(body).unwrap_or_else(|_| {
        tauri::http::Response::builder()
            .status(500)
            .body(Vec::new())
            .expect("static response always builds")
    })
}

/// GitHub Pages 用户站点（user.github.io）的图片常只存在于仓库、不随 Pages 发布，
/// 站点页面自身用 jsdelivr 镜像加载。这里生成等价的 jsdelivr 候选地址（master / main 分支）。
fn github_pages_mirror(target: &url::Url) -> Vec<url::Url> {
    let Some(host) = target.host_str() else {
        return Vec::new();
    };
    let Some(owner) = host.strip_suffix(".github.io") else {
        return Vec::new();
    };
    if owner.is_empty() || owner.contains('.') {
        return Vec::new();
    }
    let repo = format!("{owner}.github.io");
    let path = target.path();
    ["master", "main"]
        .iter()
        .filter_map(|branch| {
            url::Url::parse(&format!(
                "https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}{path}"
            ))
            .ok()
        })
        .collect()
}

/// 图片请求失败信息（保留状态码，供重试阶梯判断）
struct ImageAttemptError {
    status: Option<u16>,
    message: String,
}

/// 单次图片请求；referer 为 None 时不带 Referer
async fn request_image(
    client: &Client,
    target: &url::Url,
    referer: Option<&str>,
) -> Result<reqwest::Response, ImageAttemptError> {
    let mut request = client.get(target.clone());
    if let Some(value) = referer {
        request = request.header(reqwest::header::REFERER, value);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if status.is_success() {
                Ok(response)
            } else {
                Err(ImageAttemptError {
                    status: Some(status.as_u16()),
                    message: format!("HTTP {}", status.as_u16()),
                })
            }
        }
        Err(e) => Err(ImageAttemptError {
            status: None,
            message: root_cause_chain(&e),
        }),
    }
}

/// 需要携带 Referer 的图床主机集合：首次遇到 403 后记住，
/// 之后同一图床的首个请求就直接带 Referer，省掉一次注定失败的往返。
fn referer_hosts() -> &'static Mutex<HashSet<String>> {
    static HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn host_needs_referer(host: &str) -> bool {
    referer_hosts()
        .lock()
        .map(|set| set.contains(host))
        .unwrap_or(false)
}

fn remember_referer_host(host: &str) {
    if let Ok(mut set) = referer_hosts().lock() {
        // 上限保护：异常情况下避免集合无限增长
        if set.len() < 256 {
            set.insert(host.to_string());
        }
    }
}

/// 抓取图片的重试阶梯：
/// 1) 当前链路：空 Referer（多数防盗链对空 Referer 放行）；已知需要 Referer 的图床直接带 Referer；
/// 2) 403 时带文章页 Referer 重试（sspai 等 CDN 要求请求携带自身站点 Referer）并记住该主机；
/// 3) 启用代理时，直连重试（CDN 可能拒绝代理出口 IP，或代理分流误伤）；
/// 4) GitHub Pages 站点改走 jsdelivr 镜像重试（图片未随 Pages 发布时原地址恒为 404）。
///    镜像优先走当前链路（cdn.jsdelivr.net 在国内直连常不可用），失败后才退直连。
async fn fetch_image(
    client: &Client,
    direct_client: Option<&Client>,
    target: &url::Url,
    referer: Option<String>,
) -> Result<reqwest::Response, String> {
    let host = target.host_str().unwrap_or_default().to_string();
    let known_referer_host = host_needs_referer(&host);

    // Referer 优先用文章页地址；缺失时退化为图片自身的站点根。
    // HeaderValue 只接受可见 ASCII，非 ASCII 时退化为站点根。
    let referer_value = match referer {
        Some(value) if value.is_ascii() => value,
        _ => format!("{}/", target.origin().ascii_serialization()),
    };

    // 第 1 步：已知需要 Referer 的图床直接带上，否则先试空 Referer
    let first = if known_referer_host {
        request_image(client, target, Some(referer_value.as_str())).await
    } else {
        request_image(client, target, None).await
    };
    let (mut last_error, first_status) = match first {
        Ok(response) => return Ok(response),
        Err(err) => {
            let status = err.status;
            // 第 2 步：403 防盗链 → 带 Referer 重试并记住该主机
            if status == Some(403) && !known_referer_host {
                eprintln!("[rssimg] 403，携带 Referer 重试 {target}");
                match request_image(client, target, Some(referer_value.as_str())).await {
                    Ok(response) => {
                        remember_referer_host(&host);
                        return Ok(response);
                    }
                    Err(retry_err) => (
                        format!("带 Referer 重试后仍失败：{}", retry_err.message),
                        status,
                    ),
                }
            } else {
                (format!("上游返回 {}", err.message), status)
            }
        }
    };

    // GitHub Pages 的 404 直接交给镜像兜底，不必再直连重复请求同一个死地址
    let mirror_candidates = github_pages_mirror(target);
    let skip_direct_retry = first_status == Some(404) && !mirror_candidates.is_empty();

    // 第 3 步：启用代理时改直连重试
    if let Some(direct) = direct_client {
        if !skip_direct_retry {
            eprintln!("[rssimg] 直连重试 {target}");
            match request_image(direct, target, Some(referer_value.as_str())).await {
                Ok(response) => return Ok(response),
                Err(err) => last_error = format!("直连重试后仍失败：{}", err.message),
            }
        }
    }

    // 第 4 步：GitHub Pages 镜像兜底。优先用当前链路（cdn.jsdelivr.net 在国内直连常不可用），
    // 当前链路失败时再用直连重试一次。
    let mut mirror_clients: Vec<&Client> = vec![client];
    if let Some(direct) = direct_client {
        mirror_clients.push(direct);
    }
    for mirror in &mirror_candidates {
        eprintln!("[rssimg] 原地址不可用，尝试 jsdelivr 镜像 {mirror}");
        for mirror_client in &mirror_clients {
            match request_image(mirror_client, mirror, Some(referer_value.as_str())).await {
                Ok(response) => return Ok(response),
                Err(err) => last_error = format!("镜像重试后仍失败：{}", err.message),
            }
        }
    }

    Err(last_error)
}


/// 处理 rssimg 协议请求：查询参数 url 指向真实图片地址，由 Rust 侧统一抓取
/// （带浏览器 UA + 应用代理），绕开防盗链 Referer 校验与 http 图片的混合内容拦截。
pub async fn handle_rssimg_request(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let query = request.uri().query().unwrap_or("");
    let mut target: Option<String> = None;
    let mut ref_param: Option<String> = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "url" if target.is_none() => target = Some(value.into_owned()),
            "ref" if ref_param.is_none() => ref_param = Some(value.into_owned()),
            _ => {}
        }
    }

    let Some(target) = target else {
        eprintln!("[rssimg] 请求缺少 url 参数");
        return img_response(400, "text/plain; charset=utf-8", b"missing url param".to_vec());
    };
    let parsed = match url::Url::parse(&target) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
        _ => {
            eprintln!("[rssimg] 无效图片地址: {target}");
            return img_response(400, "text/plain; charset=utf-8", b"invalid url".to_vec());
        }
    };

    let proxy_cfg = app
        .state::<ProxySetting>()
        .0
        .read()
        .ok()
        .and_then(|guard| guard.clone());

    // 复用缓存客户端：同一图床的多张图片共享连接池与 TLS 会话
    let cache = app.state::<ClientCache>();
    let client = match cached_http_client(&cache, proxy_cfg.as_ref()) {
        Ok(client) => client,
        Err(e) => {
            eprintln!("[rssimg] HTTP 客户端构建失败: {e}");
            return img_response(502, "text/plain; charset=utf-8", format!("{e}").into_bytes());
        }
    };

    // 启用代理时准备一个直连客户端，供 CDN 拒绝代理出口 IP 时兜底
    let direct_client = if proxy_cfg.is_some() {
        cached_direct_client(&cache).ok()
    } else {
        None
    };

    let response = match fetch_image(&client, direct_client.as_ref(), &parsed, ref_param).await {
        Ok(response) => response,
        Err(reason) => {
            eprintln!("[rssimg] 抓取失败 {}: {}", parsed, reason);
            return img_response(
                502,
                "text/plain; charset=utf-8",
                format!("抓取图片失败: {}", reason).into_bytes(),
            );
        }
    };

    // 先看 Content-Length：超限直接拒绝，不必把整张图完整下载下来
    const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
    if let Some(len) = response.content_length() {
        if len > MAX_IMAGE_BYTES {
            eprintln!("[rssimg] 图片过大（{len} 字节）{parsed}");
            return img_response(413, "text/plain; charset=utf-8", b"image too large".to_vec());
        }
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    match response.bytes().await {
        Ok(bytes) => {
            if bytes.len() > 50 * 1024 * 1024 {
                return img_response(413, "text/plain; charset=utf-8", b"image too large".to_vec());
            }
            img_response(200, &content_type, bytes.to_vec())
        }
        Err(e) => {
            let reason = root_cause_chain(&e);
            eprintln!("[rssimg] 读取失败 {}: {}", parsed, reason);
            img_response(
                502,
                "text/plain; charset=utf-8",
                format!("读取图片失败: {}", reason).into_bytes(),
            )
        }
    }
}