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
    /// 文章正文内容。HTML / XHTML 直接是标记文本；text/plain 与 text/markdown 也按原文存，
    /// 由前端按 content_type 决定如何渲染。
    pub content: Option<String>,
    /// 正文的内容类型（MIME，如 text/html、text/plain、text/markdown）。
    /// 旧数据缺省为 None，前端按 HTML 处理。
    #[serde(default)]
    pub content_type: Option<String>,
    /// 正文之外另存的摘要文本（RSS 的 description 等）：正文可能只是摘要，
    /// 也可能是全文，保留它供列表预览与「正文即摘要」的提示使用。
    #[serde(default)]
    pub summary: Option<String>,
    /// 作者（多人以「、」连接）
    #[serde(default)]
    pub author: Option<String>,
    /// 文章标签 / 分类
    #[serde(default)]
    pub categories: Vec<String>,
    /// 文章缩略图地址（media:thumbnail / media:content 里的图片）
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// 媒体附件（RSS enclosure、MediaRSS、JSON Feed attachments、Atom 媒体链接）：
    /// 图片 / 音频 / 视频 / 文档等非正文内容。
    #[serde(default)]
    pub media: Vec<MediaItem>,
    /// 原文链接
    pub link: Option<String>,
    /// 发布日期（ISO 8601 时间戳）
    pub published_at: Option<String>,
    /// 是否已读
    pub read: bool,
    /// 是否收藏
    pub starred: bool,
}

/// 文章附带的媒体资源（按 content_type 分类展示；旧数据缺省为空）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaItem {
    /// 资源地址
    pub url: String,
    /// MIME 类型（可能缺失，前端按扩展名兜底判断）
    #[serde(default)]
    pub content_type: Option<String>,
    /// 资源标题（media:title / 链接 title）
    #[serde(default)]
    pub title: Option<String>,
    /// 字节大小（enclosure length / media:content size）
    #[serde(default)]
    pub size: Option<u64>,
    /// 时长（秒）
    #[serde(default)]
    pub duration_secs: Option<u64>,
    /// 宽度（像素）
    #[serde(default)]
    pub width: Option<u32>,
    /// 高度（像素）
    #[serde(default)]
    pub height: Option<u32>,
}

/// 当前状态文件结构版本；新增字段或改变语义时递增，并在 migrate_state 中处理旧版本
/// v2 起 Article 增加 entry_key（旧文章缺省为 None，重算 id 时前端按链接 / 标题兜底）
/// v3 起 Article 增加 content_type / summary / author / categories / thumbnail / media
///（旧文章这些字段缺省为空，渲染时按 HTML 正文处理，行为与 v2 一致）
/// v4 起 Feed 移除 etag / last_modified / peak_article_count——刷新一律全量抓取，
/// 不再做条件请求，也不需要「本地篇数是否被清理过」的水位线（旧值读取时被忽略）
pub const STATE_SCHEMA_VERSION: u32 = 4;

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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Path(e.to_string()))?;
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
fn cached_http_client(
    cache: &ClientCache,
    proxy: Option<&ProxyConfig>,
) -> Result<Client, CommandError> {
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

// ===== 条目内容种类识别 =====

/// 正文内容类型的短名（去掉 charset 等参数并小写）：text/html; charset=utf-8 → text/html
fn short_content_type(raw: &str) -> String {
    raw.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// 把链接的 media_type 转成 MIME 字符串
fn link_media_type(link: &feed_rs::model::Link) -> Option<String> {
    link.media_type.as_deref().map(short_content_type)
}

/// 链接是否为内容附件：JSON Feed 的 attachment（无 rel）或带媒体 MIME 的链接。
/// 排除 rel=alternate / self / via 这类「相关网页」链接，避免把原文页当成附件。
fn is_attachment_link(link: &feed_rs::model::Link) -> bool {
    if let Some(rel) = link.rel.as_deref() {
        if matches!(
            rel.to_ascii_lowercase().as_str(),
            "alternate" | "self" | "via" | "replies" | "hub"
        ) {
            return false;
        }
    }
    match link.media_type.as_deref().map(short_content_type) {
        Some(mime) if !mime.is_empty() && mime != "text/html" => true,
        // 无 media_type：只在 rel=enclosure（Atom 的附件关系）时当作附件
        None => link
            .rel
            .as_deref()
            .map(|rel| rel.eq_ignore_ascii_case("enclosure"))
            .unwrap_or(false),
        _ => false,
    }
}

/// 汇总一个条目的媒体资源：MediaRSS / enclosure / JSON Feed 附件 / Atom 媒体链接，
/// 以及正文以 src 外链形式给出的情况（content 无 body 但有 src）。
/// 按地址去重，保持 feed 声明的先后顺序。
fn collect_media(
    entry: &feed_rs::model::Entry,
    content_src: Option<&str>,
    thumbnail: Option<&str>,
) -> Vec<MediaItem> {
    let mut items: Vec<MediaItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let mut push = |item: MediaItem| {
        if item.url.is_empty() || !seen.insert(item.url.clone()) {
            return;
        }
        // 缩略图是同一张图时仍保留在附件里（正文顶部会展示缩略图，附件区据此判重）
        items.push(item);
    };

    for media in &entry.media {
        if media.content.is_empty() && media.thumbnails.is_empty() {
            continue;
        }
        let media_title = media.title.as_ref().map(|t| t.content.clone());
        // 媒体对象自身可能只有一个标题（media:group 包住多个 media:content）
        for content in &media.content {
            let Some(url) = content.url.as_ref().map(|u| u.to_string()) else {
                continue;
            };
            push(MediaItem {
                title: media_title.clone(),
                content_type: content
                    .content_type
                    .as_ref()
                    .map(|m| short_content_type(m.as_str())),
                size: content.size,
                duration_secs: content.duration.map(|d| d.as_secs()),
                width: content.width,
                height: content.height,
                url,
            });
        }
        // media:thumbnail：只有在正文没给缩略图时才作为附件展示
        for thumb in &media.thumbnails {
            let url = thumb.image.uri.clone();
            if Some(url.as_str()) == thumbnail {
                continue;
            }
            push(MediaItem {
                title: media_title.clone(),
                content_type: None,
                size: None,
                duration_secs: None,
                width: thumb.image.width,
                height: thumb.image.height,
                url,
            });
        }
    }

    for link in &entry.links {
        if !is_attachment_link(link) {
            continue;
        }
        push(MediaItem {
            url: link.href.clone(),
            content_type: link_media_type(link),
            title: link.title.clone(),
            size: link.length,
            duration_secs: None,
            width: None,
            height: None,
        });
    }

    // 正文以 src 外链给出（Atom content src）：把外链正文本身当作附件，
    // 前端可据此提示「正文为外部文件」并提供打开入口。
    if let Some(src) = content_src {
        push(MediaItem {
            url: src.to_string(),
            content_type: entry
                .content
                .as_ref()
                .map(|c| short_content_type(c.content_type.as_str())),
            title: None,
            size: entry.content.as_ref().and_then(|c| c.length),
            duration_secs: None,
            width: None,
            height: None,
        });
    }

    items
}

/// 条目缩略图：优先 media:thumbnail，其次 MediaRSS / 附件里第一张图片
fn pick_thumbnail(entry: &feed_rs::model::Entry) -> Option<String> {
    for media in &entry.media {
        if let Some(thumb) = media.thumbnails.first() {
            if !thumb.image.uri.is_empty() {
                return Some(thumb.image.uri.clone());
            }
        }
    }
    for media in &entry.media {
        for content in &media.content {
            let is_image = content
                .content_type
                .as_ref()
                .map(|m| m.as_str().to_ascii_lowercase().starts_with("image/"))
                .unwrap_or(false);
            if is_image {
                if let Some(url) = content.url.as_ref() {
                    return Some(url.to_string());
                }
            }
        }
    }
    for link in &entry.links {
        let is_image = link
            .media_type
            .as_deref()
            .map(|m| m.to_ascii_lowercase().starts_with("image/"))
            .unwrap_or(false);
        if is_image && !link.href.is_empty() {
            return Some(link.href.clone());
        }
    }
    None
}

/// 作者：条目作者优先，缺失时退到订阅源作者；多人以「、」连接
fn pick_author(entry: &feed_rs::model::Entry, feed: &feed_rs::model::Feed) -> Option<String> {
    let names: Vec<String> = if !entry.authors.is_empty() {
        entry.authors.iter().map(|p| p.name.clone()).collect()
    } else {
        feed.authors.iter().map(|p| p.name.clone()).collect()
    };
    let joined = names
        .iter()
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .collect::<Vec<_>>()
        .join("、");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// 标签 / 分类：取 label 优先，其次 term，去重后返回
fn collect_categories(entry: &feed_rs::model::Entry) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for category in &entry.categories {
        let name = category
            .label
            .clone()
            .unwrap_or_else(|| category.term.clone());
        let name = name.trim().to_string();
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        out.push(name);
    }
    out
}

/// 正文取值：HTML 家族的内容用 body；text/plain 与 markdown 原样保留；
/// body 缺失但带 src 时用外链地址兜底（前端按内容类型决定是嵌入还是给打开入口）
fn pick_content(entry: &feed_rs::model::Entry) -> (Option<String>, String) {
    if let Some(content) = entry.content.as_ref() {
        let mime = short_content_type(content.content_type.as_str());
        let body = content
            .body
            .as_ref()
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty());
        match body {
            Some(body) => return (Some(body), mime),
            // 无 body：外链正文，正文内容用链接占位，类型照实记录
            None => {
                if let Some(src) = content.src.as_ref().map(|l| l.href.clone()) {
                    return (Some(src), mime);
                }
            }
        }
    }
    if let Some(summary) = entry.summary.as_ref() {
        return (
            Some(summary.content.clone()),
            short_content_type(summary.content_type.as_str()),
        );
    }
    (None, "text/html".to_string())
}

/// 摘要字段：只有当正文并非直接取自 summary 时才重复保存一份摘要文本
fn pick_summary(entry: &feed_rs::model::Entry, content: &Option<String>) -> Option<String> {
    let summary = entry.summary.as_ref()?.content.trim();
    if summary.is_empty() {
        return None;
    }
    if content.as_deref() == Some(summary) {
        return None;
    }
    Some(summary.to_string())
}

/// 由 feed-rs 条目构造本地文章记录
fn build_article(
    feed: &feed_rs::model::Feed,
    feed_id: &str,
    entry: &feed_rs::model::Entry,
) -> Article {
    let entry_key = entry.id.as_str();
    let article_id = short_hash(&format!("{}:{}", feed_id, entry_key));

    let (content, content_type) = pick_content(entry);
    // 未声明类型时统一记为 text/html（与前端按 HTML 渲染的旧行为一致）
    let content_type = if content_type.is_empty() {
        "text/html".to_string()
    } else {
        content_type
    };

    // 正文外链（content src）：只有 body 缺失时 pick_content 才会返回链接
    let content_src = entry
        .content
        .as_ref()
        .filter(|c| c.body.is_none())
        .and_then(|c| c.src.as_ref().map(|l| l.href.clone()));
    let thumbnail = pick_thumbnail(entry);
    let media = collect_media(entry, content_src.as_deref(), thumbnail.as_deref());

    let published_at = entry
        .published
        .or(entry.updated)
        .map(|dt| to_iso_string(&dt));

    Article {
        id: article_id,
        entry_key: Some(entry_key.to_string()),
        feed_id: feed_id.to_string(),
        title: entry.title.as_ref().map(|t| t.content.clone()),
        summary: pick_summary(entry, &content),
        content,
        content_type: Some(content_type),
        author: pick_author(entry, feed),
        categories: collect_categories(entry),
        thumbnail,
        media,
        link: entry.links.first().map(|l| l.href.clone()),
        published_at,
        read: false,
        starred: false,
    }
}

/// 抓取并解析一个 RSS/Atom 订阅源。
/// 每次都是**全量抓取**：不带 `If-None-Match` / `If-Modified-Since`，304 也没有特殊含义
/// （不再有「订阅源未变化」这条分支），服务端返回 304 会按普通失败处理，避免静默拿到空结果。
#[tauri::command]
pub async fn fetch_feed(
    url: String,
    proxy: Option<ProxyConfig>,
    cache: tauri::State<'_, ClientCache>,
) -> Result<FetchResult, CommandError> {
    let client = cached_http_client(&cache, proxy.as_ref())?;
    fetch_feed_with(&client, &url).await
}

/// 抓取并解析一个订阅源（客户端由调用方按代理配置构建，因此这里不依赖 Tauri 状态，便于直接测试）
pub async fn fetch_feed_with(client: &Client, url: &str) -> Result<FetchResult, CommandError> {
    let parsed_url = url::Url::parse(url).map_err(|_| CommandError::InvalidUrl(url.to_string()))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(CommandError::InvalidUrl(url.to_string()));
    }

    let response =
        client.get(parsed_url.clone()).send().await.map_err(|e| {
            CommandError::Network(format!("{}：{}", parsed_url, root_cause_chain(&e)))
        })?;

    let status = response.status();
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

    let feed_id = short_hash(url);

    // 提取订阅源元信息
    let feed_title = feed
        .title
        .as_ref()
        .map(|t| t.content.clone())
        .unwrap_or_else(|| url.to_string());
    let feed_description = feed.description.as_ref().map(|d| d.content.clone());
    let feed_site_url = feed.links.first().map(|l| l.href.clone());

    // 提取文章（正文种类、作者、标签、缩略图与媒体附件统一在 build_article 里识别）
    let articles: Vec<Article> = feed
        .entries
        .iter()
        .map(|entry| build_article(&feed, &feed_id, entry))
        .collect();

    Ok(FetchResult {
        feed_id,
        feed_title,
        feed_description,
        feed_site_url,
        articles,
    })
}

/// 清空 WebView 的浏览数据：磁盘上的文章图片缓存（rssimg 响应，实测可达数百 MB）、Code Cache 等。
/// 供设置里的「清理缓存」使用——它**不碰文章数据**（文章在 state.json 里）。
///
/// 说明两点：
/// 1. WebView2 的缓存目录是本地应用数据目录下的 `EBWebView\Default\Cache`，由运行时管理，
///    不能直接删目录（文件被进程占用），只能在应用内通过这个 API 清；
/// 2. 该调用会连带清掉 WebView 的 localStorage，而界面偏好存在那里（见 src/lib/preferences.ts），
///    所以前端调用前先快照偏好、清完写回。
#[tauri::command]
pub async fn clear_webview_cache(app: AppHandle) -> Result<(), CommandError> {
    let Some(window) = app.get_webview_window("main") else {
        return Err(CommandError::Path("找不到主窗口".into()));
    };
    window
        .clear_all_browsing_data()
        .map_err(|e| CommandError::Network(format!("清理 WebView 缓存失败：{e}")))
}

/// 清理旧版本更新残留的临时目录，返回清掉的数量。
///
/// 背景：updater 插件把新版安装包解压到临时目录（`%TEMP%\<AppName>-<version>-updater-<rand>`），
/// 并**故意保留**这些文件——NSIS 安装包是启动后才在后台完成安装的，目录被删会打断安装，
/// 所以插件用的是 `TempDir::keep()`。代价是每升级一个版本就永久留下约 3 MB，
/// 用户升级多次后 `%TEMP%` 里会积一堆 `RSSReader-x.y.z-updater-*`。
///
/// 这里在应用启动时清一遍，但**保留版本号最新的一个**：
/// 最近的升级离当前启动最近，它的安装目录可能还在被卸载/安装流程使用。
#[tauri::command]
pub fn cleanup_old_updater_dirs(app: AppHandle) -> Result<u32, CommandError> {
    Ok(purge_stale_updater_dirs(
        &app.package_info().name,
        &std::env::temp_dir(),
    ))
}

/// `cleanup_old_updater_dirs` 的实现（纯函数，便于用临时目录直接测试）
fn purge_stale_updater_dirs(app_name: &str, temp_root: &std::path::Path) -> u32 {
    let prefix = format!("{app_name}-");
    let Ok(entries) = std::fs::read_dir(temp_root) else {
        return 0;
    };

    // 候选：目录名符合 "<AppName>-<版本>-updater-<随机>"，且版本能解析出来
    let mut candidates: Vec<(Vec<u32>, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let mut parts = rest.splitn(3, '-');
        let (Some(version), Some("updater"), Some(_rand)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Some(parsed) = parse_version(version) else {
            continue;
        };
        candidates.push((parsed, path));
    }

    if candidates.len() <= 1 {
        return 0;
    }
    // 版本号最大的留下（同版本时按路径排序取最后一个，保证结果稳定）
    candidates.sort();
    let keep = candidates.pop().map(|(_, path)| path);

    let mut removed = 0;
    for (_, path) in candidates {
        if Some(&path) == keep.as_ref() {
            continue;
        }
        // 删不掉（仍被占用 / 权限不足）就跳过，不影响启动
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 解析 "0.3.4" 这类版本号为可比较的数字序列；解析失败返回 None
fn parse_version(version: &str) -> Option<Vec<u32>> {
    if version.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for piece in version.split('.') {
        parts.push(piece.parse::<u32>().ok()?);
    }
    Some(parts)
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
    let response =
        client.get(parsed_url.clone()).send().await.map_err(|e| {
            CommandError::Network(format!("{}：{}", parsed_url, root_cause_chain(&e)))
        })?;

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
#[cfg(test)]
mod tests {
    use super::*;

    /// 解析一段 feed 并取出第一篇文章（测试里只关心内容种类识别）
    fn parse_first(xml: &str, url: &str) -> Article {
        let feed = parser::parse(xml.as_bytes()).expect("测试 feed 应能解析");
        build_article(&feed, &short_hash(url), &feed.entries[0])
    }

    #[test]
    fn rss2_content_encoded_and_enclosure() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
                 xmlns:media="http://search.yahoo.com/mrss/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/">
              <channel>
                <title>示例播客</title>
                <link>https://example.com</link>
                <description>频道描述</description>
                <item>
                  <title>第一期</title>
                  <link>https://example.com/ep1</link>
                  <guid>ep1</guid>
                  <description>这是摘要</description>
                  <content:encoded><![CDATA[<p>这是<strong>全文</strong></p>]]></content:encoded>
                  <category>科技</category>
                  <category>播客</category>
                  <dc:creator>张三</dc:creator>
                  <enclosure url="https://example.com/ep1.mp3" length="1024" type="audio/mpeg"/>
                  <media:thumbnail url="https://example.com/cover.jpg"/>
                </item>
              </channel>
            </rss>"#;

        let article = parse_first(xml, "https://example.com/feed.xml");
        assert_eq!(article.content_type.as_deref(), Some("text/html"));
        assert!(article
            .content
            .as_deref()
            .unwrap_or("")
            .contains("<strong>全文</strong>"));
        assert_eq!(article.summary.as_deref(), Some("这是摘要"));
        assert_eq!(article.author.as_deref(), Some("张三"));
        assert_eq!(
            article.categories,
            vec!["科技".to_string(), "播客".to_string()]
        );
        assert_eq!(
            article.thumbnail.as_deref(),
            Some("https://example.com/cover.jpg")
        );
        // 音频附件与封面（封面已在 thumbnail 里，附件列表不再重复）
        assert_eq!(article.media.len(), 1);
        assert_eq!(article.media[0].url, "https://example.com/ep1.mp3");
        assert_eq!(article.media[0].content_type.as_deref(), Some("audio/mpeg"));
        assert_eq!(article.media[0].size, Some(1024));
    }

    #[test]
    fn atom_plain_text_content() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>纯文本源</title>
              <id>urn:feed:1</id>
              <updated>2026-01-01T00:00:00Z</updated>
              <author><name>李四</name></author>
              <entry>
                <title>纯文本条目</title>
                <id>urn:entry:1</id>
                <updated>2026-01-02T00:00:00Z</updated>
                <link href="https://example.com/1"/>
                <content type="text">第一行
第二行</content>
              </entry>
            </feed>"#;

        let article = parse_first(xml, "https://example.com/atom.xml");
        assert_eq!(article.content_type.as_deref(), Some("text/plain"));
        assert_eq!(article.content.as_deref(), Some("第一行\n第二行"));
        // 条目没有作者时退到订阅源作者
        assert_eq!(article.author.as_deref(), Some("李四"));
    }

    #[test]
    fn atom_markdown_content_and_base64_image() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>Markdown 源</title>
              <id>urn:feed:2</id>
              <updated>2026-01-01T00:00:00Z</updated>
              <entry>
                <title>Markdown 条目</title>
                <id>urn:entry:2</id>
                <updated>2026-01-02T00:00:00Z</updated>
                <link href="https://example.com/2"/>
                <content type="text/markdown">## 标题

正文</content>
              </entry>
              <entry>
                <title>内联图片条目</title>
                <id>urn:entry:3</id>
                <updated>2026-01-03T00:00:00Z</updated>
                <link href="https://example.com/3"/>
                <content type="image/png">iVBORw0KGgo=</content>
              </entry>
            </feed>"#;

        let feed = parser::parse(xml.as_bytes()).expect("测试 feed 应能解析");
        let markdown = build_article(&feed, "f1", &feed.entries[0]);
        assert_eq!(markdown.content_type.as_deref(), Some("text/markdown"));
        assert!(markdown
            .content
            .as_deref()
            .unwrap_or("")
            .starts_with("## 标题"));

        let image = build_article(&feed, "f1", &feed.entries[1]);
        assert_eq!(image.content_type.as_deref(), Some("image/png"));
    }

    #[test]
    fn atom_content_src_becomes_external_media() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
            <feed xmlns="http://www.w3.org/2005/Atom">
              <title>外链正文源</title>
              <id>urn:feed:3</id>
              <updated>2026-01-01T00:00:00Z</updated>
              <entry>
                <title>外链条目</title>
                <id>urn:entry:4</id>
                <updated>2026-01-02T00:00:00Z</updated>
                <link href="https://example.com/4"/>
                <content type="text/html" src="https://example.com/posts/4.html"/>
              </entry>
            </feed>"#;

        let article = parse_first(xml, "https://example.com/atom3.xml");
        assert_eq!(article.content_type.as_deref(), Some("text/html"));
        // 无 body：正文退化为外链地址，同时作为附件给出打开入口
        assert_eq!(
            article.content.as_deref(),
            Some("https://example.com/posts/4.html")
        );
        assert!(article
            .media
            .iter()
            .any(|m| m.url == "https://example.com/posts/4.html"));
    }

    #[test]
    fn json_feed_attachments_and_tags() {
        let json = r#"{
          "version": "https://jsonfeed.org/version/1.1",
          "title": "JSON 源",
          "home_page_url": "https://example.com",
          "feed_url": "https://example.com/feed.json",
          "items": [
            {
              "id": "1",
              "url": "https://example.com/1",
              "title": "带附件的条目",
              "content_text": "纯文本正文",
              "date_published": "2026-01-02T00:00:00Z",
              "author": { "name": "王五" },
              "tags": ["标签一", "标签二"],
              "attachments": [
                { "url": "https://example.com/a.pdf", "mime_type": "application/pdf", "size_in_bytes": 2048 },
                { "url": "https://example.com/b.mp4", "mime_type": "video/mp4", "duration_in_seconds": 90 }
              ]
            }
          ]
        }"#;

        let article = parse_first(json, "https://example.com/feed.json");
        assert_eq!(article.content_type.as_deref(), Some("text/plain"));
        assert_eq!(article.content.as_deref(), Some("纯文本正文"));
        assert_eq!(article.author.as_deref(), Some("王五"));
        assert_eq!(
            article.categories,
            vec!["标签一".to_string(), "标签二".to_string()]
        );
        assert_eq!(article.media.len(), 2);
        assert_eq!(
            article.media[0].content_type.as_deref(),
            Some("application/pdf")
        );
        assert_eq!(article.media[0].size, Some(2048));
        // JSON Feed 的 duration_in_seconds 不会被 feed-rs 映射到链接上（只有 MediaRSS 的时长可取）
        assert_eq!(article.media[1].duration_secs, None);
    }

    #[test]
    fn content_type_normalised_without_parameters() {
        assert_eq!(short_content_type("text/HTML; charset=utf-8"), "text/html");
        assert_eq!(
            short_content_type("  application/xhtml+xml "),
            "application/xhtml+xml"
        );
    }

    // ===== 更新残留目录的清理 =====

    /// 在临时目录下造一棵结构可控的目录树，返回根路径。
    /// 每个用例传自己的 tag：cargo test 并行执行，共用根目录会互相踩（上一个刚删、下一个又建）。
    fn make_dirs(tag: &str, names: &[&str]) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("rss-purge-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for name in names {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        root
    }

    fn remaining(root: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn purge_keeps_newest_updater_dir() {
        let root = make_dirs(
            "keep",
            &[
                "RSSReader-0.2.1-updater-YFejpu",
                "RSSReader-0.3.0-updater-Np6SeK",
                "RSSReader-0.3.4-updater-6i2X52",
                "RSSReader-0.3.10-updater-abcdef", // 两位数版本：不能按字符串比大小
            ],
        );
        let removed = purge_stale_updater_dirs("RSSReader", &root);
        assert_eq!(removed, 3);
        assert_eq!(remaining(&root), vec!["RSSReader-0.3.10-updater-abcdef"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_ignores_unrelated_and_malformed_names() {
        let root = make_dirs(
            "unrelated",
            &[
                "RSSReader-0.3.4-updater-6i2X52",
                "RSSReader-notes",            // 不是 updater 目录
                "RSSReader-abc-updater-xyz",  // 版本号不可解析
                "OtherApp-0.1.0-updater-zzz", // 别的应用
                "unrelated-folder",           // 完全无关
            ],
        );
        let removed = purge_stale_updater_dirs("RSSReader", &root);
        assert_eq!(
            removed, 0,
            "只有一个合法残留目录时不该删（它是最近一次升级留下的）"
        );
        assert_eq!(
            remaining(&root),
            vec![
                "OtherApp-0.1.0-updater-zzz",
                "RSSReader-0.3.4-updater-6i2X52",
                "RSSReader-abc-updater-xyz",
                "RSSReader-notes",
                "unrelated-folder",
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn purge_handles_empty_temp_root() {
        let root = make_dirs("empty", &[]);
        assert_eq!(purge_stale_updater_dirs("RSSReader", &root), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_version_compares_numerically() {
        assert_eq!(parse_version("0.3.10"), Some(vec![0, 3, 10]));
        assert_eq!(parse_version("1.0"), Some(vec![1, 0]));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("v1"), None);
        assert!(parse_version("0.3.10") > parse_version("0.3.9"));
    }
}

/// 真实订阅源的联网抽查（默认忽略，手动运行）：
/// `cargo test --lib live_feeds -- --ignored --nocapture`
/// 目的：确认各种内容种类在真实 feed 上确实被识别出来（纯文本 / Markdown / 附件 / 作者 / 标签）。
#[cfg(test)]
mod live_tests {
    use super::*;

    fn classify(feed: &FetchResult) -> String {
        let mut kinds: HashMap<String, usize> = HashMap::new();
        let mut media = 0usize;
        let mut authors = 0usize;
        let mut tags = 0usize;
        for article in &feed.articles {
            let kind = article
                .content_type
                .clone()
                .unwrap_or_else(|| "（未记录）".to_string());
            *kinds.entry(kind).or_default() += 1;
            media += article.media.len();
            if article.author.is_some() {
                authors += 1;
            }
            if !article.categories.is_empty() {
                tags += 1;
            }
        }
        format!(
            "{} 篇 · 种类 {:?} · 附件 {} · 有作者 {} · 有标签 {}",
            feed.articles.len(),
            kinds,
            media,
            authors,
            tags
        )
    }

    #[test]
    #[ignore = "需要联网"]
    fn live_feeds() {
        const FEEDS: [&str; 6] = [
            "https://sspai.com/feed",
            "https://www.ruanyifeng.com/blog/atom.xml",
            "https://www.youtube.com/feeds/videos.xml?channel_id=UCAuUUnT6oDeKwE6v1NGQxug",
            "https://feeds.simplecast.com/54nAGcIl",
            "https://daringfireball.net/feeds/json",
            "https://github.blog/feed/",
        ];

        let client = build_http_client(None).expect("HTTP 客户端应能构建");
        for url in FEEDS {
            let result = tauri::async_runtime::block_on(fetch_feed_with(&client, url));
            match result {
                Ok(feed) => {
                    println!("✓ {url}\n   {} → {}", feed.feed_title, classify(&feed));
                    for article in feed.articles.iter().take(30) {
                        if article.media.is_empty() {
                            continue;
                        }
                        println!(
                            "   · [{}] {} 附件 {} 个：{}",
                            article.content_type.as_deref().unwrap_or("-"),
                            article
                                .title
                                .as_deref()
                                .unwrap_or("（无标题）")
                                .chars()
                                .take(28)
                                .collect::<String>(),
                            article.media.len(),
                            article
                                .media
                                .iter()
                                .take(4)
                                .map(|m| format!(
                                    "{} ({})",
                                    m.content_type.as_deref().unwrap_or("无类型"),
                                    m.size
                                        .map(|s| format!("{s}B"))
                                        .unwrap_or_else(|| "-".into())
                                ))
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        break;
                    }
                }
                Err(e) => println!("✗ {url} → {e}"),
            }
        }
    }
}
