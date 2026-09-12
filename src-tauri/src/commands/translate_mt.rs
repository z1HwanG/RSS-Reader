//! 机器翻译通道：微软 / 谷歌网页版免密钥接口、DeepL 官方接口、腾讯云 TMT（TC3-HMAC-SHA256 签名）
use super::error::CommandError;
use super::http::root_cause_chain;
use super::translate::{translate_http_client, truncate_for_error, TranslateProvider};
use reqwest::Client;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

// ===== 机器翻译接口（微软翻译 / 谷歌翻译 / DeepL）=====
//
// 与上面三种大模型协议并列的第三条路。这三家是**专用翻译接口**：不需要模型、不需要提示词，
// 一次请求可以带多段文本并按顺序返回译文 —— 对「逐段双语对照」来说比大模型更合适：
// 段落对应关系由接口保证（不存在「模型弄丢分隔标记」「把标题当题目自己写一篇」），
// 速度也快一个量级（没有逐请求的思考过程）。

/// 语言名 → 各家的语言代码：(应用里的语言名, 微软, 谷歌, DeepL)。
/// 表外的语言名原样透传（DeepL 转大写），想直接写 "en-US" / "ZH-HANS" 也可以。
const MT_LANGUAGE_TABLE: &[(&str, &str, &str, &str, &str)] = &[
    ("简体中文", "zh-Hans", "zh-CN", "ZH", "zh"),
    ("繁体中文", "zh-Hant", "zh-TW", "ZH-HANT", "zh-TW"),
    ("English", "en", "en", "EN", "en"),
    ("日本語", "ja", "ja", "JA", "ja"),
    ("한국어", "ko", "ko", "KO", "ko"),
    ("Français", "fr", "fr", "FR", "fr"),
    ("Deutsch", "de", "de", "DE", "de"),
    ("Español", "es", "es", "ES", "es"),
    ("Русский", "ru", "ru", "RU", "ru"),
];

/// 目标 / 源语言代码。返回 None = 不传这个参数（源语言「自动检测」时交给服务端判断）。
pub(crate) fn mt_language_code(protocol: &str, name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name == "自动检测" {
        return None;
    }
    for (label, microsoft, google, deepl, tencent) in MT_LANGUAGE_TABLE {
        if *label == name {
            return Some(
                match protocol {
                    "microsoft-translator" => *microsoft,
                    "google-translate" => *google,
                    "deepl" => *deepl,
                    "tencent-tmt" => *tencent,
                    _ => name,
                }
                .to_string(),
            );
        }
    }
    Some(if protocol == "deepl" {
        name.to_uppercase()
    } else {
        name.to_string()
    })
}

/// 查询串里的百分号编码：只放行 URL 里安全的字符，其余按 UTF-8 逐字节转义。
fn query_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// 从地址的查询串里取 `key=…`（谷歌允许把密钥放进 URL）。
/// 给了就不再用请求头 —— 一次请求带两份凭据只会让人搞不清哪份生效。
pub(crate) fn query_api_key(base: &str) -> Option<String> {
    let query = base.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        let value = value.trim();
        (name.trim().eq_ignore_ascii_case("key") && !value.is_empty()).then(|| value.to_string())
    })
}

/// 机器翻译接口的端点：用户常只填服务根地址，这里按协议补全官方路径。
/// 带查询串的地址只取路径部分（微软的 api-version 由我们统一拼，避免出现两个 `?`）。
pub(crate) fn mt_endpoint(
    protocol: &str,
    base: &str,
    target: &str,
    source: Option<&str>,
) -> Result<String, CommandError> {
    let raw = base;
    let cut = base
        .find('?')
        .or_else(|| base.find('#'))
        .unwrap_or(base.len());
    let base = base[..cut].trim_end_matches('/');
    match protocol {
        // 微软：POST /translate?api-version=3.0&to=zh-Hans[&from=en]
        "microsoft-translator" => {
            let path = if base.ends_with("/translate") {
                base.to_string()
            } else {
                format!("{base}/translate")
            };
            let mut url = format!("{path}?api-version=3.0&to={}", query_encode(target));
            if let Some(src) = source {
                url.push_str(&format!("&from={}", query_encode(src)));
            }
            Ok(url)
        }
        // 谷歌：POST /language/translate/v2（密钥默认走请求头；写在地址里也认）
        "google-translate" => {
            let path = if base.ends_with("/v2") {
                base.to_string()
            } else {
                format!("{base}/language/translate/v2")
            };
            Ok(match query_api_key(raw) {
                Some(key) => format!("{path}?key={}", query_encode(&key)),
                None => path,
            })
        }
        // DeepL：POST /v2/translate（免费版 api-free.deepl.com，专业版 api.deepl.com）
        "deepl" => Ok(if base.ends_with("/v2/translate") {
            base.to_string()
        } else if base.ends_with("/v2") {
            format!("{base}/translate")
        } else {
            format!("{base}/v2/translate")
        }),
        other => Err(CommandError::InvalidUrl(format!("不支持的协议：{other}"))),
    }
}

/// DeepL 的端点必须与**密钥类型**匹配，否则一律 403。
///
/// 免费版密钥以 `:fx` 结尾，只能打 api-free.deepl.com；打到专业版端点时 DeepL 直接回
/// 「Wrong endpoint. Use https://api-free.deepl.com」（专业版密钥打免费端点同样不通）。
/// 两个域名长得几乎一样，用户在设置里手填极易选错，所以这里按密钥替他选对端点。
/// 只认官方这两个域名：自建 / 反代地址一律原样保留，不动用户自己的部署。
pub(crate) fn deepl_base_for_key(base: &str, api_key: &str) -> String {
    if api_key.trim().is_empty() {
        return base.to_string();
    }
    let (from, to) = if api_key.trim().ends_with(":fx") {
        ("https://api.deepl.com", "https://api-free.deepl.com")
    } else {
        ("https://api-free.deepl.com", "https://api.deepl.com")
    };
    match base.trim_end_matches('/').strip_prefix(from) {
        // rest 通常是 "" 或 "/v2/translate"：换掉域名，路径原样带上
        Some(rest) => format!("{to}{rest}"),
        None => base.to_string(),
    }
}

/// 三家的请求体（都是 JSON）。共同点：**一次可以带多段**，返回的译文顺序与入参一致。
pub(crate) fn mt_build_body(
    protocol: &str,
    texts: &[String],
    source: Option<&str>,
    target: &str,
) -> Result<serde_json::Value, CommandError> {
    match protocol {
        // 微软：请求体是数组，每项 { "Text": "..." }（字段名首字母大写，官方如此）
        "microsoft-translator" => Ok(serde_json::Value::Array(
            texts
                .iter()
                .map(|t| serde_json::json!({ "Text": t }))
                .collect(),
        )),
        // 谷歌：q 可以是字符串数组；format=text 表示按纯文本处理
        "google-translate" => {
            let mut body = serde_json::json!({ "q": texts, "target": target, "format": "text" });
            if let Some(src) = source {
                body["source"] = serde_json::json!(src);
            }
            Ok(body)
        }
        // DeepL：text 是数组；preserve_formatting 保住原文的换行与大小写
        "deepl" => {
            let mut body = serde_json::json!({
                "text": texts,
                "target_lang": target,
                "preserve_formatting": true,
            });
            if let Some(src) = source {
                body["source_lang"] = serde_json::json!(src);
            }
            Ok(body)
        }
        other => Err(CommandError::InvalidUrl(format!("不支持的协议：{other}"))),
    }
}

/// 三家的鉴权头（都不是 Bearer）
fn mt_auth_header(protocol: &str, api_key: &str) -> Option<(&'static str, String)> {
    match protocol {
        "microsoft-translator" => Some(("ocp-apim-subscription-key", api_key.to_string())),
        "google-translate" => Some(("x-goog-api-key", api_key.to_string())),
        "deepl" => Some(("authorization", format!("DeepL-Auth-Key {api_key}"))),
        _ => None,
    }
}

/// HTML 实体还原（谷歌的译文会被转义；微软免密钥通道则是我们自己转义的，收回来要还原）。
/// 只认这几个常见实体，且 `&amp;` 放最后 —— 否则 `&amp;quot;` 会被解成引号。
pub(crate) fn unescape_entities(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = raw.to_string();
    for (from, to) in [
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&amp;", "&"),
    ] {
        out = out.replace(from, to);
    }
    out
}

/// 从三家的响应里取出译文数组（顺序与请求一致）。
pub(crate) fn mt_parse_response(
    protocol: &str,
    value: &serde_json::Value,
) -> Result<Vec<String>, CommandError> {
    let items: Vec<String> = match protocol {
        // 微软：[{ detectedLanguage: {...}, translations: [{ text, to }] }]
        "microsoft-translator" => value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|item| {
                        item.get("translations")
                            .and_then(|t| t.get(0))
                            .and_then(|t| t.get("text"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        // 谷歌：{ data: { translations: [{ translatedText }] } }
        "google-translate" => value
            .pointer("/data/translations")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|item| {
                        unescape_entities(
                            item.get("translatedText")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        // DeepL：{ translations: [{ detected_source_language, text }] }
        "deepl" => value
            .get("translations")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|item| {
                        item.get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        other => return Err(CommandError::InvalidUrl(format!("不支持的协议：{other}"))),
    };
    if items.is_empty() {
        return Err(CommandError::Network(format!(
            "翻译服务未返回译文内容：{}",
            truncate_for_error(&value.to_string(), 200)
        )));
    }
    Ok(items)
}

/// 三家的错误体各不相同（微软 / 谷歌 `{ error: { message } }`、DeepL `{ message }`），统一取一句人话。
pub(crate) fn mt_error_message(value: &serde_json::Value) -> Option<String> {
    let message = value
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("message").and_then(|v| v.as_str()))?;
    if message.trim().is_empty() {
        None
    } else {
        Some(message.to_string())
    }
}

/// HTTP 状态码的补充说明：这几家的报错体常常很含糊，密钥 / 额度 / 限流是最常见的三种。
/// （现在只有 DeepL 走密钥这条路：微软 / 谷歌是免密钥专用的，不会出现 401。）
pub(crate) fn mt_http_hint(status: u16) -> &'static str {
    match status {
        401 => "（API 密钥不对或没生效）",
        403 => "（密钥没开通这个翻译接口、免费额度用尽，或端点与密钥类型不匹配 —— DeepL 免费版密钥必须配 api-free.deepl.com）",
        429 => "（触发限流：等一会儿再试，或在文章页面换成别的服务商）",
        _ => "",
    }
}

/// 发一次机器翻译请求：一次带多段，返回与入参一一对应的译文。
#[allow(clippy::too_many_arguments)]
async fn perform_mt_translate(
    client: &Client,
    protocol: &str,
    endpoint: &str,
    api_key: &str,
    texts: &[String],
    source_code: Option<&str>,
    target_code: &str,
) -> Result<Vec<String>, CommandError> {
    let body = mt_build_body(protocol, texts, source_code, target_code)?;
    let payload = serde_json::to_string(&body).map_err(CommandError::Json)?;

    let mut req = client
        .post(endpoint)
        // 微软官方文档写明的取值就是 application/json; charset=UTF-8，照它发
        .header(
            reqwest::header::CONTENT_TYPE,
            if protocol == "microsoft-translator" {
                "application/json; charset=UTF-8"
            } else {
                "application/json"
            },
        );
    // 谷歌允许把密钥写在地址里（?key=…）：已经带了就不再发请求头
    let key_in_url = protocol == "google-translate" && endpoint.contains("key=");
    if !key_in_url {
        if let Some((name, value)) = mt_auth_header(protocol, api_key) {
            if !value.is_empty() {
                req = req.header(name, value);
            }
        }
    }
    let response = req.body(payload).send().await.map_err(|e| {
        CommandError::Network(format!(
            "翻译请求失败（{}）：{}",
            endpoint,
            root_cause_chain(&e)
        ))
    })?;

    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;
    if !status.is_success() {
        return Err(CommandError::Network(format!(
            "翻译服务返回 HTTP {}：{}{}",
            status.as_u16(),
            truncate_for_error(&raw, 300),
            mt_http_hint(status.as_u16())
        )));
    }

    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CommandError::Parse(format!("翻译响应解析失败：{}", root_cause_chain(&e))))?;
    if let Some(message) = mt_error_message(&value) {
        return Err(CommandError::Network(format!("翻译服务错误：{message}")));
    }
    let out = mt_parse_response(protocol, &value)?;
    // 段数对不上就不能按顺序对号入座：宁可整批报错，也不能把第 3 段的译文贴到第 2 段下面
    if out.len() != texts.len() {
        return Err(CommandError::Network(format!(
            "译文条数与原文不一致（原文 {} 段，返回 {} 段）",
            texts.len(),
            out.len()
        )));
    }
    if out.iter().all(|t| t.trim().is_empty()) {
        return Err(CommandError::Network(
            "翻译服务未返回译文内容（返回的都是空文本）".to_string(),
        ));
    }
    Ok(out)
}

// ===== 免密钥通道（微软 / 谷歌的网页版接口）=====
//
// 这两个服务是**免密钥专用**：不需要、也不接受 API 密钥（官方接口那条路已废弃，
// 设置页里也不再显示它们，只在文章页面的翻译器里供选择）。
// 走的是**网页版/浏览器自带的接口**，不是给第三方用的公开 API：
//   - 微软：edge.microsoft.com/translate/translatetext（Edge 浏览器翻译用的那条，无需任何令牌）。
//     2026-07 官方撤掉了老的「先 GET /translate/auth 换令牌、再调 api-edge…」那条路
//     （那个地址现在直接 404），改成这个不带鉴权的端点；请求体也从 [{"Text": …}] 变成纯字符串数组。
//     响应结构仍与官方 v3 一致，所以解析可以共用。
//   - 谷歌：网页版 clients5 的 translate_a/t（client=dict-chrome-ex）。一次可以带多段
//     （重复 q 参数，返回顺序一致），所以整批一个请求就够。
//     注意别换回 translate_a/single?client=gtx：那个端点按客户端指纹拦非浏览器请求，
//     本应用用 reqwest(rustls)，打它必得 429（实测直连 / 代理 / HTTP1.1 全一样）。
// 两家都没有文档、按 IP 限流、随时可能改动或失效（微软这条就刚改过一次）。
// 所以它们只当「零配置的现成选项」：要稳定、要额度就换 DeepL 或自己配一个大模型服务商。

/// 这几家的协议支持「不填密钥也能用」的网页版通道；DeepL 没有，必须填密钥
pub(crate) fn is_keyless_capable(protocol: &str) -> bool {
    matches!(protocol, "microsoft-translator" | "google-translate")
}

/// 微软免密钥通道（无需令牌；老地址 edge.microsoft.com/translate/auth 已被官方撤掉）
pub(crate) const EDGE_WEB_TRANSLATE_URL: &str =
    "https://edge.microsoft.com/translate/translatetext";

/// 谷歌网页版通道（dict-chrome-ex）。
///
/// 不用更常见的 `translate_a/single?client=gtx`：那个端点按客户端指纹拦截非浏览器请求，
/// 本应用这套 reqwest(rustls) 打它**必得 429**（详见 keyless_google 的说明）。
pub(crate) const GOOGLE_WEB_ENDPOINT: &str = "https://clients5.google.com/translate_a/t";

/// 把 `&` `<` `>` 转成实体再发出去。
/// 微软这条端点每次都会跑一遍 HTML 标签对齐：正文里光秃秃的 `<` 会和后面的文字拼成假标签
/// （「a < b 且 c > d」会变成「<B和C> d」）。转义之后原样往返，收到再还原一次。
pub(crate) fn escape_entities(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 微软免密钥：不需要令牌，一次可带多段（请求体是纯字符串数组）。
pub(crate) async fn keyless_microsoft(
    client: &Client,
    texts: &[String],
    source_code: Option<&str>,
    target_code: &str,
) -> Result<Vec<String>, CommandError> {
    let endpoint = format!(
        "{}?from={}&to={}&isEnterpriseClient=false",
        EDGE_WEB_TRANSLATE_URL,
        // 源语言留空 = 交给服务端自动判断；不能用 "auto"（这条端点不认）
        query_encode(source_code.unwrap_or("")),
        query_encode(target_code)
    );
    let escaped: Vec<String> = texts.iter().map(|t| escape_entities(t)).collect();
    let payload = serde_json::to_string(&escaped).map_err(CommandError::Json)?;

    let response = client
        .post(&endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|e| {
            CommandError::Network(format!(
                "免密钥通道翻译请求失败（{}）：{}。{}",
                EDGE_WEB_TRANSLATE_URL,
                root_cause_chain(&e),
                keyless_hint("microsoft-translator")
            ))
        })?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;
    if !status.is_success() {
        return Err(CommandError::Network(format!(
            "免密钥通道返回 HTTP {}：{}。{}",
            status.as_u16(),
            truncate_for_error(&raw, 300),
            keyless_hint("microsoft-translator")
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CommandError::Parse(format!("翻译响应解析失败：{}", root_cause_chain(&e))))?;
    if let Some(message) = mt_error_message(&value) {
        return Err(CommandError::Network(format!("翻译服务错误：{message}")));
    }
    // 响应结构与官方 v3 一致：[{ translations: [{ text }] }]
    let out = mt_parse_response("microsoft-translator", &value)?;
    if out.len() != texts.len() {
        return Err(CommandError::Network(format!(
            "译文条数与原文不一致（原文 {} 段，返回 {} 段）",
            texts.len(),
            out.len()
        )));
    }
    Ok(out.iter().map(|t| unescape_entities(t)).collect())
}

/// 谷歌网页版响应的解析：`[["译文","en"],["译文2","en"]]` —— 一项对应一个 q（顺序一致）。
/// 单段时同样是这个形状（长度 1 的数组）。实体会还原（接口会给 `&#39;` 这类转义）。
pub(crate) fn google_web_parse(value: &serde_json::Value) -> Result<Vec<String>, CommandError> {
    let items = value.as_array().ok_or_else(|| {
        CommandError::Network(format!(
            "网页版翻译返回了意料之外的结构：{}",
            truncate_for_error(&value.to_string(), 200)
        ))
    })?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        // 一项一段，形状固定是 ["译文", "en"]。不认识就报错（附上原文，便于对照接口变化）
        let text = item.get(0).and_then(|v| v.as_str()).ok_or_else(|| {
            CommandError::Network(format!(
                "网页版翻译返回了意料之外的条目：{}",
                truncate_for_error(&item.to_string(), 200)
            ))
        })?;
        out.push(unescape_entities(text).trim().to_string());
    }
    if out.is_empty() || out.iter().all(|t| t.is_empty()) {
        return Err(CommandError::Network(
            "网页版翻译没有返回译文内容".to_string(),
        ));
    }
    Ok(out)
}

/// 谷歌免密钥：**一次请求带多段**（重复 q 参数），返回顺序与入参一致。
///
/// 端点选择有讲究：更常见的 `translate.googleapis.com/translate_a/single?client=gtx`
/// 会按**客户端指纹**拒掉非浏览器请求 —— 用本应用这套 reqwest(rustls) 打它，无论直连、
/// 走代理、强制 HTTP/1.1 还是去掉 Accept-Encoding，**一律 429**（拿到的是 Google 的
/// 「Sorry...」拦截页），而同一台机器上换个 HTTP 客户端就正常。本应用用的正是 rustls，
/// 所以那个端点在这里根本不可用；换成下面这个 clients5 端点实测正常，而且支持一次多段。
pub(crate) async fn keyless_google(
    client: &Client,
    texts: &[String],
    source_code: Option<&str>,
    target_code: &str,
) -> Result<Vec<String>, CommandError> {
    let mut url = format!(
        "{}?client=dict-chrome-ex&sl={}&tl={}",
        GOOGLE_WEB_ENDPOINT,
        // 源语言留空 = 自动检测；这个端点认 "auto"
        query_encode(source_code.unwrap_or("auto")),
        query_encode(target_code)
    );
    for text in texts {
        url.push_str(&format!("&q={}", query_encode(text)));
    }
    let response = client.get(&url).send().await.map_err(|e| {
        CommandError::Network(format!(
            "免密钥通道翻译请求失败（{}）：{}。{}",
            GOOGLE_WEB_ENDPOINT,
            root_cause_chain(&e),
            keyless_hint("google-translate")
        ))
    })?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;
    if !status.is_success() {
        return Err(CommandError::Network(format!(
            "免密钥通道返回 HTTP {}：{}。{}",
            status.as_u16(),
            truncate_for_error(&raw, 300),
            keyless_hint("google-translate")
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CommandError::Parse(format!("翻译响应解析失败：{}", root_cause_chain(&e))))?;
    if let Some(message) = mt_error_message(&value) {
        return Err(CommandError::Network(format!("翻译服务错误：{message}")));
    }
    let out = google_web_parse(&value)?;
    // 段数对不上就不能按顺序对号入座（宁可整批报错，也不能把第 3 段的译文贴到第 2 段下面）
    if out.len() != texts.len() {
        return Err(CommandError::Network(format!(
            "译文条数与原文不一致（原文 {} 段，返回 {} 段）",
            texts.len(),
            out.len()
        )));
    }
    Ok(out)
}

// ===== 腾讯云机器翻译（TMT）=====
//
// 和前几家不一样：腾讯云要求 **TC3-HMAC-SHA256 签名**，凭据是一对 SecretId / SecretKey
// （不是单个 API Key），一次请求只翻一段（TextTranslate），错误也放在 200 响应的 body 里。
// 这里自己实现签名而不引 SDK：算法是固定的，官方文档给了完整步骤和可校验的中间值，
// 测试里就照那两个哈希值钉住了实现（见 tests::tencent_signature_matches_documented_vector）。

const TENCENT_HOST: &str = "tmt.tencentcloudapi.com";
const TENCENT_SERVICE: &str = "tmt";
const TENCENT_ACTION: &str = "TextTranslate";
const TENCENT_VERSION: &str = "2018-03-21";
const TENCENT_CONTENT_TYPE: &str = "application/json; charset=utf-8";
/// 腾讯云要求带地域。用户没写就用广州（官方示例同款），需要别的在密钥串末尾加一段。
const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";

/// HMAC-SHA256（key 在前、消息在后，与腾讯云示例一致）。
/// 自己实现是为了不新增依赖：sha2 本来就在用，HMAC 只是在它外面套两层异或。
pub(crate) fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(BLOCK + msg.len());
    let mut outer = Vec::with_capacity(BLOCK + 32);
    for byte in key_block {
        inner.push(byte ^ 0x36);
        outer.push(byte ^ 0x5c);
    }
    inner.extend_from_slice(msg);
    outer.extend_from_slice(&Sha256::digest(&inner));
    Sha256::digest(&outer).to_vec()
}

pub(crate) fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// 解析腾讯云凭据：`SecretId:SecretKey`，末尾可再加一段地域（`SecretId:SecretKey:ap-beijing`）。
pub(crate) fn parse_tencent_credentials(
    raw: &str,
) -> Result<(String, String, String), CommandError> {
    let parts: Vec<&str> = raw.trim().split(':').map(str::trim).collect();
    let bad_format = || {
        CommandError::Network(
            "腾讯翻译要填腾讯云的密钥对，格式 SecretId:SecretKey（可选再加一段地域，如 \
             SecretId:SecretKey:ap-beijing）。到腾讯云控制台「访问管理 → API 密钥管理」新建。"
                .to_string(),
        )
    };
    let (id, key) = match parts.as_slice() {
        [id, key, ..] if !id.is_empty() && !key.is_empty() => (*id, *key),
        _ => return Err(bad_format()),
    };
    let region = match parts.get(2) {
        Some(r) if !r.is_empty() => (*r).to_string(),
        _ => TENCENT_DEFAULT_REGION.to_string(),
    };
    Ok((id.to_string(), key.to_string(), region))
}

/// 规范请求串（POST + 固定路径 + 三个参与签名的头部）。
/// 单独抽出来是为了能用官方文档给出的中间值（HashedCanonicalRequest）把拼装格式钉住 ——
/// 少一个换行、头部没转小写，签名都会变成另一种结果，而那种错在测试里最难看出来。
pub(crate) fn tencent_canonical_request(host: &str, action: &str, payload: &str) -> String {
    let canonical_headers = format!(
        "content-type:{TENCENT_CONTENT_TYPE}\nhost:{host}\nx-tc-action:{}\n",
        action.to_lowercase()
    );
    format!(
        "POST\n/\n\n{canonical_headers}\ncontent-type;host;x-tc-action\n{}",
        sha256_hex(payload)
    )
}

/// TC3-HMAC-SHA256 的 Authorization 头（腾讯云签名 v3）。
/// 注意：规范请求串里头部 key 与 value **都要转小写**，所以 x-tc-action 的值取小写。
fn tencent_authorization(
    secret_id: &str,
    secret_key: &str,
    timestamp: i64,
    payload: &str,
) -> String {
    let date = chrono::DateTime::from_timestamp(timestamp, 0)
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%d")
        .to_string();
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = tencent_canonical_request(TENCENT_HOST, TENCENT_ACTION, payload);
    let scope = format!("{date}/{TENCENT_SERVICE}/tc3_request");
    let string_to_sign = format!(
        "TC3-HMAC-SHA256\n{timestamp}\n{scope}\n{}",
        sha256_hex(&canonical_request)
    );
    let secret_date = hmac_sha256(format!("TC3{secret_key}").as_bytes(), date.as_bytes());
    let secret_service = hmac_sha256(&secret_date, TENCENT_SERVICE.as_bytes());
    let secret_signing = hmac_sha256(&secret_service, b"tc3_request");
    let signature = hex::encode(hmac_sha256(&secret_signing, string_to_sign.as_bytes()));
    format!(
        "TC3-HMAC-SHA256 Credential={secret_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// 腾讯云的错误放在 200 响应的 Response.Error 里（签名错也是 200），必须显式判。
/// 这里把几个常见错误码翻成人话 —— 报错体本身只有一句英文/中文短句。
pub(crate) fn tencent_error_message(value: &serde_json::Value) -> Option<String> {
    let err = value.get("Response")?.get("Error")?;
    let code = err.get("Code").and_then(|v| v.as_str()).unwrap_or("");
    let message = err.get("Message").and_then(|v| v.as_str()).unwrap_or("");
    Some(match code {
        "AuthFailure.SignatureFailure"
        | "AuthFailure.SecretIdNotFound"
        | "AuthFailure.InvalidSecretId" => {
            format!("{code}：{message}（密钥对或签名不对：确认填的是 SecretId:SecretKey，顺序别弄反）")
        }
        "AuthFailure.UnauthorizedOperation" | "FailedOperation.NotEnterpriseUser" => {
            format!("{code}：{message}（这把密钥没开通机器翻译，或账号未完成实名 / 企业认证）")
        }
        "RequestLimitExceeded" => format!(
            "{code}：{message}（腾讯云默认按 5 次/秒限流，已自动重试仍超限：稍后再试，或一次少翻几段）"
        ),
        _ => format!("{code}：{message}"),
    })
}

/// 这个响应是不是「触发限流」——限流是瞬时的，等一下重试通常就过去了。
pub(crate) fn tencent_is_rate_limited(value: &serde_json::Value) -> bool {
    value
        .get("Response")
        .and_then(|r| r.get("Error"))
        .and_then(|e| e.get("Code"))
        .and_then(|c| c.as_str())
        == Some("RequestLimitExceeded")
}

/// 腾讯云机器翻译：一次请求翻一段，逐段发。
///
/// 两个与限流有关的细节（都是实测撞出来的：默认配额是 **5 次/秒**）：
/// 1. 请求之间留出最小间隔，按 ~4.5 次/秒 发，避免自己顶到上限；
/// 2. 万一还是撞上 `RequestLimitExceeded`，退避重试而不是当场失败 ——
///    否则一整篇翻译会因为某一秒多打了一个请求而整批标成「未翻译」。
pub(crate) async fn tencent_translate(
    client: &Client,
    secret_id: &str,
    secret_key: &str,
    region: &str,
    texts: &[String],
    source_code: Option<&str>,
    target_code: &str,
) -> Result<Vec<String>, CommandError> {
    /// 两次请求之间的最小间隔：限流是 5 次/秒，这里按 ~4.5 次/秒 发，留一点余量。
    const MIN_INTERVAL: std::time::Duration = std::time::Duration::from_millis(220);
    /// 撞上限流后的重试次数与首次等待（之后按倍数退避）
    const MAX_RETRY: usize = 3;
    const RETRY_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);

    let endpoint = format!("https://{TENCENT_HOST}");
    let mut out = Vec::with_capacity(texts.len());
    for (index, text) in texts.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(MIN_INTERVAL).await;
        }
        let payload = serde_json::json!({
            "SourceText": text,
            // 源语言「自动检测」时不传具体语言，交给腾讯判断
            "Source": source_code.unwrap_or("auto"),
            "Target": target_code,
            "ProjectId": 0,
        })
        .to_string();
        let mut attempt = 0;
        loop {
            let timestamp = chrono::Utc::now().timestamp();
            let authorization = tencent_authorization(secret_id, secret_key, timestamp, &payload);
            let response = client
                .post(&endpoint)
                .header(reqwest::header::CONTENT_TYPE, TENCENT_CONTENT_TYPE)
                .header("host", TENCENT_HOST)
                .header("x-tc-action", TENCENT_ACTION)
                .header("x-tc-version", TENCENT_VERSION)
                .header("x-tc-region", region)
                .header("x-tc-timestamp", timestamp.to_string())
                .header("authorization", authorization)
                .body(payload.clone())
                .send()
                .await
                .map_err(|e| {
                    CommandError::Network(format!(
                        "翻译请求失败（{endpoint}）：{}",
                        root_cause_chain(&e)
                    ))
                })?;
            let status = response.status();
            let raw = response
                .text()
                .await
                .map_err(|e| CommandError::Network(root_cause_chain(&e)))?;
            if !status.is_success() {
                return Err(CommandError::Network(format!(
                    "翻译服务返回 HTTP {}：{}",
                    status.as_u16(),
                    truncate_for_error(&raw, 300)
                )));
            }
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
                CommandError::Parse(format!("翻译响应解析失败：{}", root_cause_chain(&e)))
            })?;
            // 触发限流：退避后重试（1s / 2s / 3s），别再往上顶
            if tencent_is_rate_limited(&value) && attempt < MAX_RETRY {
                attempt += 1;
                tokio::time::sleep(RETRY_WAIT * attempt as u32).await;
                continue;
            }
            if let Some(message) = tencent_error_message(&value) {
                return Err(CommandError::Network(format!("翻译服务错误：{message}")));
            }
            let target = value
                .get("Response")
                .and_then(|r| r.get("TargetText"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    CommandError::Network(format!(
                        "翻译响应里没有译文：{}",
                        truncate_for_error(&raw, 200)
                    ))
                })?;
            out.push(target.to_string());
            break;
        }
    }
    Ok(out)
}

/// 免密钥通道出问题时的建议：这类接口本来就没有保障，说清退路
/// （注意不能再让用户「去填密钥」—— 这两个服务已经没有密钥这条路了）
pub(crate) fn keyless_hint(protocol: &str) -> &'static str {
    match protocol {
        "microsoft-translator" => "这是免密钥通道（Edge 网页接口，未公开），可能被限流或改动：稍后再试，或换用别的翻译服务（DeepL / 大模型服务商）",
        _ => "这是免密钥通道（网页版接口，未公开）：国内需要先配代理，也可能被限流；稍后再试，或换用别的翻译服务（DeepL / 大模型服务商）",
    }
}

/// 免密钥通道的入口（按协议分发）
async fn perform_keyless_translate(
    client: &Client,
    protocol: &str,
    texts: &[String],
    source_code: Option<&str>,
    target_code: &str,
) -> Result<Vec<String>, CommandError> {
    match protocol {
        "microsoft-translator" => keyless_microsoft(client, texts, source_code, target_code).await,
        "google-translate" => keyless_google(client, texts, source_code, target_code).await,
        other => Err(CommandError::InvalidUrl(format!(
            "{} 没有免密钥通道，请在设置里填 API 密钥",
            other
        ))),
    }
}

/// 机器翻译接口的完整一次调用：校验 → 语言代码 → 端点 → 请求。
/// `translate_text`（单段）与 `translate_texts`（多段）都走这里。
///
/// 微软 / 谷歌是免密钥专用，一律走网页版通道；DeepL 必须填密钥、走官方接口。
pub(crate) async fn run_machine_translate(
    app: &AppHandle,
    provider: &TranslateProvider,
    texts: Vec<String>,
    source: &str,
    target: &str,
) -> Result<Vec<String>, CommandError> {
    if texts.is_empty() {
        return Err(CommandError::Network("没有要翻译的内容".to_string()));
    }
    let api_key = provider.api_key.clone().unwrap_or_default();
    // DeepL 的端点跟着密钥类型走：免费版密钥（以 :fx 结尾）配专业版端点只会得到 403
    let base_owned = if provider.protocol == "deepl" {
        deepl_base_for_key(provider.api_url.trim(), &api_key)
    } else {
        provider.api_url.trim().to_string()
    };
    let base = base_owned.trim().trim_end_matches('/');

    let protocol = provider.protocol.as_str();
    // 报错要点名是哪个服务商：机器翻译的报错体都很含糊（401 / 403 + 一句英文），
    // 不写清楚用户根本不知道是自己填错密钥，还是选错了服务商。
    let name = if provider.display_name.trim().is_empty() {
        provider.provider_id.clone()
    } else {
        provider.display_name.trim().to_string()
    };
    let target_code = mt_language_code(protocol, target).ok_or_else(|| {
        CommandError::Network("请先选择目标语言（机器翻译接口必须指明译成哪种语言）".to_string())
    })?;
    let source_code = mt_language_code(protocol, source);
    let client = translate_http_client(app)?;

    // 微软 / 谷歌是**免密钥专用**：一律走各自的网页版通道。这两个服务在设置页里已经不出现、
    // 没有密钥可填，所以旧配置里残留的密钥（以及地址里写死的 key=）在这里一并忽略
    // —— 否则同一个服务会留下「有时走官方接口、有时走网页通道」两条行为不同的路径。
    if is_keyless_capable(protocol) {
        return perform_keyless_translate(
            &client,
            protocol,
            &texts,
            source_code.as_deref(),
            &target_code,
        )
        .await
        .map_err(|e| CommandError::Network(format!("{name}：{e}")));
    }

    // 腾讯云：签名 + 固定域名，走自己的那条路（地址不由用户填，也不用通用端点拼装）
    if protocol == "tencent-tmt" {
        if api_key.trim().is_empty() {
            return Err(CommandError::Network(format!(
                "{name} 还没填密钥对：请在「设置 → 翻译」里按 SecretId:SecretKey 的格式填上"
            )));
        }
        let (secret_id, secret_key, region) = parse_tencent_credentials(&api_key)?;
        return tencent_translate(
            &client,
            &secret_id,
            &secret_key,
            &region,
            &texts,
            source_code.as_deref(),
            &target_code,
        )
        .await
        .map_err(|e| CommandError::Network(format!("{name}：{e}")));
    }

    // 其余（DeepL）必须填密钥：明确报错，别让用户看着一句干巴巴的 401 猜
    if api_key.trim().is_empty() {
        return Err(CommandError::Network(format!(
            "{name} 还没填 API 密钥：请在「设置 → 翻译」里填好这个服务商的密钥"
        )));
    }
    let parsed = url::Url::parse(base)
        .map_err(|_| CommandError::InvalidUrl("翻译服务地址不是合法 URL".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandError::InvalidUrl(
            "翻译服务地址必须是 http/https".to_string(),
        ));
    }
    let endpoint = mt_endpoint(protocol, base, &target_code, source_code.as_deref())?;
    perform_mt_translate(
        &client,
        protocol,
        &endpoint,
        api_key.trim(),
        &texts,
        source_code.as_deref(),
        &target_code,
    )
    .await
    .map_err(|e| CommandError::Network(format!("{name}：{e}")))
}
