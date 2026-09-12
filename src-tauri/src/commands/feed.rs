//! 订阅源抓取与解析：feed-rs 解析、条目内容种类识别、meta refresh 跟随、文章原文抓取
use super::error::CommandError;
use super::http::{
    cached_http_client, ensure_public_http_target, looks_like_html, root_cause_chain, ClientCache,
    ProxyConfig,
};
use super::state::{short_hash, to_iso_string, Article, MediaItem};
use feed_rs::parser;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub feed_id: String,
    pub feed_title: String,
    pub feed_description: Option<String>,
    pub feed_site_url: Option<String>,
    pub articles: Vec<Article>,
}

// ===== 条目内容种类识别 =====

/// 正文内容类型的短名（去掉 charset 等参数并小写）：text/html; charset=utf-8 → text/html
pub(crate) fn short_content_type(raw: &str) -> String {
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
pub(crate) fn build_article(
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
        preview: None,
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
///
/// 正文在这里直接落盘（更长者胜）并从返回值剥离：正文与元数据分离后不再过 IPC，
/// 前端按需读取（get_article_content）；返回的文章带纯文本预览。
#[tauri::command]
pub async fn fetch_feed(
    app: tauri::AppHandle,
    url: String,
    proxy: Option<ProxyConfig>,
    cache: tauri::State<'_, ClientCache>,
) -> Result<FetchResult, CommandError> {
    let client = cached_http_client(&cache, proxy.as_ref())?;
    let mut result = fetch_feed_with(&client, &url).await?;
    super::content_store::strip_and_persist_fetch(&app, &mut result);
    Ok(result)
}

/// 抓取并解析一个订阅源（客户端由调用方按代理配置构建，因此这里不依赖 Tauri 状态，便于直接测试）
pub async fn fetch_feed_with(client: &Client, url: &str) -> Result<FetchResult, CommandError> {
    let parsed_url = url::Url::parse(url).map_err(|_| CommandError::InvalidUrl(url.to_string()))?;
    ensure_public_http_target(&parsed_url)?;

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

const MAX_META_REFRESH_HOPS: usize = 3;

/// ASCII 大小写不敏感的子串查找（标签名 / 属性名大小写不定；中文内容不参与比较，按字节安全）
fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    let hay = haystack.as_bytes();
    let pat = needle.as_bytes();
    if pat.is_empty() || hay.len() < pat.len() {
        return None;
    }
    (0..=hay.len() - pat.len()).find(|&i| hay[i..i + pat.len()].eq_ignore_ascii_case(pat))
}

/// 从 meta 标签里取 `content="0;url=…"` 中的目标地址
fn meta_refresh_target(tag: &str) -> Option<&str> {
    let at = find_ignore_ascii_case(tag, "content")?;
    let rest = tag.get(at..)?;
    let eq = rest.find('=')?;
    let after = rest[eq + 1..].trim_start();
    let first = after.chars().next()?;
    let value = if first == '"' || first == '\'' {
        let inner = &after[1..];
        let end = inner.find(first)?;
        &inner[..end]
    } else {
        let end = after
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(after.len());
        &after[..end]
    };
    let url_at = find_ignore_ascii_case(value, "url")?;
    let tail = value.get(url_at + 3..)?.trim_start();
    let tail = tail.strip_prefix('=')?.trim_start();
    let tail = tail.trim_matches(|c| c == '"' || c == '\'');
    if tail.is_empty() {
        None
    } else {
        Some(tail)
    }
}

/// 从 HTML 里找 `<meta http-equiv="refresh" content="…;url=…">` 的目标（相对地址按 base 解析）。
///
/// 为什么需要它：这类跳转是 **HTTP 200 + 一个 meta 标签**，HTTP 客户端不会跟随，抓回来只是
/// 一张没有正文的跳转页 —— 例如 `diygod.cc/europe-travel` 会跳到 B 站视频页，
/// 不跟随的话「获取全文」在这种页面上必然什么都拿不到。
pub(crate) fn extract_meta_refresh(html: &str, base: &url::Url) -> Option<url::Url> {
    // 跳转页的 meta 一定在文档开头，只看前面一段（按字符截取，避免切坏 UTF-8）
    let head: String = html.chars().take(4096).collect();
    let mut cursor = 0;
    while let Some(rel) = find_ignore_ascii_case(&head[cursor..], "<meta") {
        let start = cursor + rel;
        let end = find_ignore_ascii_case(&head[start..], ">")
            .map(|e| start + e + 1)
            .unwrap_or(head.len());
        let tag = &head[start..end];
        if find_ignore_ascii_case(tag, "refresh").is_some() {
            if let Some(target) = meta_refresh_target(tag) {
                if let Ok(url) = base.join(target) {
                    return Some(url);
                }
            }
        }
        cursor = end;
    }
    None
}

/// 抓取文章原文 HTML（用于获取 RSS 摘要的完整正文）
#[tauri::command]
pub async fn fetch_article_html(
    url: String,
    proxy: Option<ProxyConfig>,
    cache: tauri::State<'_, ClientCache>,
) -> Result<String, CommandError> {
    let parsed_url = url::Url::parse(&url).map_err(|_| CommandError::InvalidUrl(url.clone()))?;
    ensure_public_http_target(&parsed_url)?;

    let client = cached_http_client(&cache, proxy.as_ref())?;
    let mut target = parsed_url;
    let mut body = String::new();

    for hop in 0..=MAX_META_REFRESH_HOPS {
        let response =
            client.get(target.clone()).send().await.map_err(|e| {
                CommandError::Network(format!("{}：{}", target, root_cause_chain(&e)))
            })?;

        let status = response.status();
        if !status.is_success() {
            return Err(CommandError::Network(format!(
                "HTTP 状态码 {}（{}）",
                status.as_u16(),
                target
            )));
        }

        body = response
            .text()
            .await
            .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;

        if hop == MAX_META_REFRESH_HOPS {
            break;
        }
        // HTTP 200 + meta refresh 的跳转页：跟到真正的页面，否则拿到的是没有正文的空壳
        // （跳转目标同样要过公网校验；内网目标不跟随，停在当前这跳）
        match extract_meta_refresh(&body, &target) {
            Some(next)
                if matches!(next.scheme(), "http" | "https")
                    && next != target
                    && ensure_public_http_target(&next).is_ok() =>
            {
                log::info!(
                    "fetch_article_html: 跟随 meta refresh {} → {}",
                    target,
                    next
                );
                target = next;
            }
            _ => break,
        }
    }

    Ok(body)
}
