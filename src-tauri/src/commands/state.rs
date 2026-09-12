//! 状态持久化：数据模型、state.json 读写、备份 / 还原与 OPML 导入导出的文件命令
use super::error::CommandError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
    /// 上次**成功**刷新时间（ISO 8601）。None = 从未成功刷新过。
    #[serde(default)]
    pub last_success_at: Option<String>,
    /// 最近一次刷新的失败原因。None = 当前没有错误（成功过或还没抓过）。
    #[serde(default)]
    pub last_error: Option<String>,
    /// **连续**失败次数：成功一次就清零。
    ///
    /// 为什么要计数而不是「一失败就标记」：单次失败常常只是网络抖动 / 站点临时 503，
    /// 拿它当「坏订阅源」会让用户一键清掉一大批正常源。要求连续失败若干次才算坏源。
    #[serde(default)]
    pub fail_count: u32,
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
    ///
    /// v5 起正文与元数据分离：这个字段只存在于内存与备份文件里，state.json 一律为 None
    ///（正文落盘在 articles/<feed_id>/<article_id>，见 content_store）。
    pub content: Option<String>,
    /// 正文纯文本预览（前 300 字符，正文落盘时生成）。
    /// 供列表预览与搜索兜底使用，随元数据一起轻量保存。
    #[serde(default)]
    pub preview: Option<String>,
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
pub const STATE_SCHEMA_VERSION: u32 = 5;

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
pub(crate) fn migrate_state(mut state: AppState) -> AppState {
    if state.schema_version < STATE_SCHEMA_VERSION {
        state.schema_version = STATE_SCHEMA_VERSION;
    }
    state
}

pub(crate) fn short_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

/// 获取应用数据目录下的状态文件路径
pub(crate) fn state_file(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Path(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(CommandError::Io)?;
    Ok(dir.join("state.json"))
}

/// 原子写入：先写同目录临时文件再改名，避免写入中途崩溃损坏状态文件
pub(crate) fn write_atomically(path: &std::path::Path, bytes: &[u8]) -> Result<(), CommandError> {
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
pub(crate) fn to_iso_string(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.to_rfc3339()
}

/// 浏览器风格 User-Agent，避免站点对非浏览器 UA 的拦截

// ===== 状态命令 =====

/// 加载本地持久化状态（订阅源 + 文章元数据）。
/// 文件读取与 JSON 解析放进阻塞线程池，不能占着异步运行时的线程
///（抓取、图片代理都跑在同一个执行器上）。
#[tauri::command]
pub async fn load_state(app: AppHandle) -> Result<AppState, CommandError> {
    let file = state_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<AppState, CommandError> {
        if !file.exists() {
            return Ok(AppState::default());
        }
        // read + from_slice：比 read_to_string + from_str 少一次整份内容的字符串拷贝
        let raw = std::fs::read(&file).map_err(CommandError::Io)?;
        let mut state: AppState = serde_json::from_slice(&raw).map_err(CommandError::Json)?;
        // v4 及之前的 state.json 把正文内嵌在文章里：迁到内容文件并剥离（一次性），
        // 剥离过就立即回写瘦身后的元数据，下次启动不再携带几十 MB 的正文
        let root = super::content_store::articles_dir(&app)?;
        let stripped = super::content_store::strip_article_contents(&root, &mut state.articles);
        let state = migrate_state(state);
        if stripped {
            let raw = serde_json::to_vec(&state).map_err(CommandError::Json)?;
            write_atomically(&file, &raw)?;
        }
        Ok(state)
    })
    .await
    .map_err(|e| CommandError::Network(format!("加载状态任务执行失败：{e}")))?
}

/// 保存本地持久化状态（订阅源 + 文章元数据，不含正文）。
/// 用紧凑 JSON；序列化（to_vec，省掉 to_string 的整份字符串拷贝）与落盘都放进阻塞线程池。
/// 若传入的文章带有正文（老前端 / 异常路径），同样剥离进内容文件，元数据永远轻量。
#[tauri::command]
pub async fn save_state(app: AppHandle, mut state: AppState) -> Result<(), CommandError> {
    let file = state_file(&app)?;
    state.schema_version = STATE_SCHEMA_VERSION;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), CommandError> {
        let root = super::content_store::articles_dir(&app)?;
        super::content_store::strip_article_contents(&root, &mut state.articles);
        let raw = serde_json::to_vec(&state).map_err(CommandError::Json)?;
        write_atomically(&file, &raw)
    })
    .await
    .map_err(|e| CommandError::Network(format!("保存状态任务执行失败：{e}")))?
}

/// HTTP 客户端缓存：按代理配置复用 Client，连接池与 TLS 会话可跨请求复用。
/// 图片抓取（同一 CDN 多张图）与订阅源抓取共享同一批连接，避免每次请求重新握手。

// ===== 文件导入导出的路径门禁 =====
//
// backup / restore / OPML 导入导出 / 文章另存走下面四条命令，路径由前端传入。
// 路径正常来自系统文件对话框，但 webview 内的代码（一旦出现 XSS）也能直接调这些命令
// 读写任意路径 —— 因此在后端加一道门禁：只放行对话框会选出的文档类扩展名，
// 并拒绝应用数据目录（state.json、translate-config.json 含翻译 API Key，不能被读走或覆盖）。
fn guard_document_path(
    app: &AppHandle,
    raw_path: &str,
    allowed_extensions: &[&str],
) -> Result<(), CommandError> {
    let path = std::path::Path::new(raw_path);
    if !path.is_absolute() {
        return Err(CommandError::Path("只允许绝对路径".into()));
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(CommandError::Path("路径不允许包含 ..".into()));
    }
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| allowed_extensions.iter().any(|a| e.eq_ignore_ascii_case(a)))
        .unwrap_or(false);
    if !ext_ok {
        return Err(CommandError::Path(format!(
            "只允许 {} 类型的文件",
            allowed_extensions.join(" / ")
        )));
    }

    // 应用数据目录先建好再规范化，保证两侧都是规范路径（Windows 下 canonicalize 带 \\?\ 前缀）
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Path(e.to_string()))?;
    std::fs::create_dir_all(&data_dir).map_err(CommandError::Io)?;
    let data_dir = data_dir.canonicalize().map_err(CommandError::Io)?;

    // 已存在的文件按真实路径比对（顺带解掉符号链接：伪装成文档的链接一样拦住）；
    // 尚不存在的写入目标比对其父目录
    let probe = if path.exists() {
        path.canonicalize().map_err(CommandError::Io)?
    } else {
        let parent = path.parent().unwrap_or(path);
        let parent = parent.canonicalize().map_err(CommandError::Io)?;
        parent.join(path.file_name().unwrap_or_default())
    };
    if probe.starts_with(&data_dir) {
        return Err(CommandError::Path("不允许访问应用数据目录内的文件".into()));
    }
    Ok(())
}

/// 备份：把当前状态写入指定文件（JSON，保留可读缩进）。
/// 备份是「完整状态」：正文从内容文件读回来填进备份，旧版本应用也能直接还原。
/// 前端传来的只有元数据，正文由本命令负责回填；序列化与落盘走阻塞线程池。
#[tauri::command]
pub async fn backup_state(
    app: AppHandle,
    target_path: String,
    mut state: AppState,
) -> Result<(), CommandError> {
    guard_document_path(&app, &target_path, &["json"])?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), CommandError> {
        let root = super::content_store::articles_dir(&app)?;
        super::content_store::restore_article_contents(&root, &mut state.articles);
        let raw = serde_json::to_vec_pretty(&state).map_err(CommandError::Json)?;
        write_atomically(std::path::Path::new(&target_path), &raw)
    })
    .await
    .map_err(|e| CommandError::Network(format!("备份任务执行失败：{e}")))?
}

/// 还原：从指定文件读取 JSON（完整状态，含正文），正文写进内容文件，
/// 返回剥离后的元数据状态（由前端调用 save_state 持久化）
#[tauri::command]
pub async fn restore_state(app: AppHandle, source_path: String) -> Result<AppState, CommandError> {
    guard_document_path(&app, &source_path, &["json"])?;
    tauri::async_runtime::spawn_blocking(move || -> Result<AppState, CommandError> {
        let raw = std::fs::read(&source_path).map_err(CommandError::Io)?;
        let mut state: AppState = serde_json::from_slice(&raw).map_err(CommandError::Json)?;
        let root = super::content_store::articles_dir(&app)?;
        super::content_store::strip_article_contents(&root, &mut state.articles);
        Ok(migrate_state(state))
    })
    .await
    .map_err(|e| CommandError::Network(format!("还原任务执行失败：{e}")))?
}

/// 读取文本文件（用于 OPML 导入）
#[tauri::command]
pub async fn read_file_text(app: AppHandle, source_path: String) -> Result<String, CommandError> {
    guard_document_path(&app, &source_path, &["opml", "xml"])?;
    std::fs::read_to_string(&source_path).map_err(CommandError::Io)
}

/// 写入文本到指定文件（用于 OPML 导出、文章另存 Markdown / 文本）
#[tauri::command]
pub async fn write_file_text(
    app: AppHandle,
    target_path: String,
    content: String,
) -> Result<(), CommandError> {
    guard_document_path(&app, &target_path, &["opml", "xml", "md", "txt"])?;
    write_atomically(std::path::Path::new(&target_path), content.as_bytes())
}
