/*
 * 文件名: deep_link.rs
 * 描述: 深链（feed:// / rssreader://）解析与分发。
 *       RSSHub Radar 的「本地阅读器」会打开 feed://<去掉协议头的地址>；
 *       rssreader://subscribe?url=<percent-encoded> 是本应用的专用入口。
 *       地址归一化后通过 feed-link 事件推给前端；冷启动时 webview 还没加载，
 *       事件会丢，因此同时暂存一份，前端挂载后调用 take_pending_feed_link 取走。
 */

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

/// 前端监听的事件名，payload 为归一化后的 http(s) 地址
pub const FEED_LINK_EVENT: &str = "feed-link";

/// 冷启动暂存的深链地址（取走即清空）
#[derive(Default)]
pub struct PendingFeedLink(pub Mutex<Option<String>>);

/// 是否为可抓取的 http(s) 地址
fn is_http_url(raw: &str) -> bool {
    Url::parse(raw)
        .map(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        .unwrap_or(false)
}

/// 把深链归一化为 http(s) 订阅地址；无法识别时返回 None。
///
/// 支持的形式：
/// - `feed://host/path?query` → `https://host/path?query`
/// - `feed:https://host/path` / `feed:http://host/path` → 原样
/// - `rssreader://subscribe?url=<percent-encoded>` → 解码后的地址
pub fn normalize_deep_link(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let parsed = Url::parse(raw).ok()?;
    match parsed.scheme() {
        "feed" => {
            let rest = raw.strip_prefix("feed:")?;
            // feed://host/... 去掉双斜杠后按 https 处理；feed:https://... 原样保留
            let candidate = match rest.strip_prefix("//") {
                Some(rest) => format!("https://{rest}"),
                None => rest.to_string(),
            };
            let target = Url::parse(&candidate).ok()?;
            if matches!(target.scheme(), "http" | "https") && target.host_str().is_some() {
                Some(target.to_string())
            } else {
                None
            }
        }
        "rssreader" => parsed
            .query_pairs()
            .find(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .filter(|value| is_http_url(value)),
        _ => None,
    }
}

/// 把一个或多个深链地址交给前端：暂存一份（防冷启动丢失）并发出事件
pub fn dispatch(app: &AppHandle, raw_urls: &[Url]) {
    for url in raw_urls {
        let Some(address) = normalize_deep_link(url.as_str()) else {
            continue;
        };
        if let Some(state) = app.try_state::<PendingFeedLink>() {
            if let Ok(mut pending) = state.0.lock() {
                *pending = Some(address.clone());
            }
        }
        let _ = app.emit(FEED_LINK_EVENT, address);
    }
}

/// 前端启动后取走暂存的深链地址（取走即清空，避免重复弹窗）
#[tauri::command]
pub fn take_pending_feed_link(state: tauri::State<'_, PendingFeedLink>) -> Option<String> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[cfg(test)]
mod tests {
    use super::normalize_deep_link;

    #[test]
    fn feed_scheme_with_host() {
        assert_eq!(
            normalize_deep_link("feed://rsshub.woodland.cafe/javdb/rankings").as_deref(),
            Some("https://rsshub.woodland.cafe/javdb/rankings")
        );
    }

    #[test]
    fn feed_scheme_keeps_query_and_fragment() {
        assert_eq!(
            normalize_deep_link("feed://example.com/feed?limit=20").as_deref(),
            Some("https://example.com/feed?limit=20")
        );
    }

    #[test]
    fn feed_scheme_embedded_url() {
        assert_eq!(
            normalize_deep_link("feed:https://example.com/rss.xml").as_deref(),
            Some("https://example.com/rss.xml")
        );
        assert_eq!(
            normalize_deep_link("feed:http://example.com/rss.xml").as_deref(),
            Some("http://example.com/rss.xml")
        );
    }

    #[test]
    fn rssreader_scheme() {
        assert_eq!(
            normalize_deep_link("rssreader://subscribe?url=https%3A%2F%2Fexample.com%2Ffeed.xml")
                .as_deref(),
            Some("https://example.com/feed.xml")
        );
    }

    #[test]
    fn rejects_unsupported_input() {
        assert!(normalize_deep_link("https://example.com/feed.xml").is_none());
        assert!(normalize_deep_link("feed:ftp://example.com/feed").is_none());
        assert!(normalize_deep_link("rssreader://subscribe?url=ftp%3A%2F%2Fexample.com").is_none());
        assert!(normalize_deep_link("rssreader://subscribe").is_none());
        assert!(normalize_deep_link("").is_none());
        assert!(normalize_deep_link("feed://").is_none());
    }
}
