//! 文章图片本地代理协议（rssimg）：webview 内经此协议请求图片，由 Rust 侧统一抓取
//! （带浏览器 UA + 应用代理），绕开防盗链 Referer 校验与 http 图片的混合内容拦截
use super::http::{
    cached_direct_client, cached_http_client, ensure_public_http_target, root_cause_chain,
    ClientCache, ProxySetting,
};
use reqwest::Client;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

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
        return img_response(
            400,
            "text/plain; charset=utf-8",
            b"missing url param".to_vec(),
        );
    };
    let parsed = match url::Url::parse(&target) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
        _ => {
            eprintln!("[rssimg] 无效图片地址: {target}");
            return img_response(400, "text/plain; charset=utf-8", b"invalid url".to_vec());
        }
    };
    // 字面内网 IP 直接拒绝（域名主机的内网拦截由客户端上的 PublicOnlyResolver 在连接时保证）
    if let Err(e) = ensure_public_http_target(&parsed) {
        eprintln!("[rssimg] 拒绝访问内网地址: {parsed}");
        return img_response(400, "text/plain; charset=utf-8", e.to_string().into_bytes());
    }

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
            return img_response(
                502,
                "text/plain; charset=utf-8",
                format!("{e}").into_bytes(),
            );
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
            return img_response(
                413,
                "text/plain; charset=utf-8",
                b"image too large".to_vec(),
            );
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
                return img_response(
                    413,
                    "text/plain; charset=utf-8",
                    b"image too large".to_vec(),
                );
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
