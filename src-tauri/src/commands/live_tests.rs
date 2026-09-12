use super::*;
/// 真实订阅源的联网抽查（默认忽略，手动运行）：
/// `cargo test --lib live_feeds -- --ignored --nocapture`
/// 目的：确认各种内容种类在真实 feed 上确实被识别出来（纯文本 / Markdown / 附件 / 作者 / 标签）。
use std::collections::HashMap;

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

/// 腾讯翻译的联网实测（默认忽略，手动运行）：
/// `cargo test --lib live_tencent_translate -- --ignored --nocapture`
///
/// 签名对不对、语言码/地域合不合、响应结构有没有变，只有真调一次才知道。
/// 密钥对从本机应用配置里读（不在命令行里写密钥，免得进 shell 历史）。
#[test]
#[ignore = "需要腾讯云密钥对，且要联网"]
fn live_tencent_translate() {
    let path = match std::env::var("APPDATA") {
        Ok(dir) => format!("{dir}\\com.rssreader.app\\translate-config.json"),
        Err(_) => return,
    };
    let Ok(config) = std::fs::read_to_string(&path) else {
        println!("跳过：读不到 {path}");
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&config) else {
        println!("跳过：配置不是合法 JSON");
        return;
    };
    let Some(credential) = json["providers"]
        .as_array()
        .and_then(|list| list.iter().find(|p| p["protocol"] == "tencent-tmt"))
        .and_then(|p| p["api_key"].as_str())
        .filter(|k| !k.trim().is_empty())
    else {
        println!("跳过：配置里没有腾讯翻译的密钥对");
        return;
    };
    let Ok((id, key, region)) = parse_tencent_credentials(credential) else {
        println!("跳过：配置里的密钥对格式不对");
        return;
    };
    let client = build_http_client(None).expect("HTTP 客户端应能构建");
    // 故意多发几段：腾讯云默认限流 5 次/秒，12 段连着发正好能试出「限速 + 撞限流重试」
    // 是否真的管用（每次都成功、且耗时约 12 × 220ms 以上，说明在按节奏发）
    let texts: Vec<String> = (1..=12).map(|i| format!("Paragraph number {i}.")).collect();
    let started = std::time::Instant::now();
    match tauri::async_runtime::block_on(tencent_translate(
        &client, &id, &key, &region, &texts, None, "zh",
    )) {
        Ok(out) => println!(
            "✓ 腾讯翻译：{} 段用时 {:?}\n  {:?}",
            out.len(),
            started.elapsed(),
            out
        ),
        Err(e) => println!("✗ 腾讯翻译：{e}"),
    }
}

/// 免密钥通道的联网实测（默认忽略，手动运行）：
/// `cargo test --lib live_keyless_translate -- --ignored --nocapture`
///
/// 这两条是**未公开接口**，只在真机上跑才有意义：单元测试只能验证解析与拼装，
/// 端点是否还在、结构有没有变，只有联网试一次才知道。
#[test]
#[ignore = "需要联网"]
fn live_keyless_translate() {
    let client = build_http_client(None).expect("HTTP 客户端应能构建");

    // 微软：Edge 通道（先换令牌，再用与官方 v3 一样的请求体）
    match tauri::async_runtime::block_on(keyless_microsoft(
        &client,
        &["Hello, world".to_string(), "Good morning".to_string()],
        None,
        "zh-Hans",
    )) {
        Ok(out) => println!("✓ 微软免密钥：{:?}", out),
        Err(e) => println!("✗ 微软免密钥：{e}"),
    }

    // 谷歌：网页版 clients5 translate_a/t（一次请求带多段）
    match tauri::async_runtime::block_on(keyless_google(
        &client,
        &["Hello, world".to_string(), "Good morning".to_string()],
        None,
        "zh-CN",
    )) {
        Ok(out) => println!("✓ 谷歌免密钥：{:?}", out),
        Err(e) => println!("✗ 谷歌免密钥：{e}"),
    }
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
