use super::*;
use feed_rs::parser;

/// 公网性判定：内网段全部拒绝，公网段放行；IPv4 映射的 IPv6 不给伪装绕过的机会
#[test]
fn public_ip_classification() {
    let public = [
        "1.2.3.4",
        "8.8.8.8",
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
    ];
    let internal = [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",
        "198.18.0.1",
        "192.0.2.1",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12:3456::1",
        "2001:db8::1",
        "::ffff:127.0.0.1",
        "::ffff:192.168.1.1",
    ];
    for ip in public {
        let parsed: std::net::IpAddr = ip.parse().unwrap();
        assert!(is_public_ip(parsed), "{ip} 应判定为公网");
    }
    for ip in internal {
        let parsed: std::net::IpAddr = ip.parse().unwrap();
        assert!(!is_public_ip(parsed), "{ip} 应判定为内网");
    }
}

/// 目标校验：非 http(s) 与字面内网 IP 拒绝，公网地址与域名放行
#[test]
fn target_guard_rejects_internal_hosts() {
    assert!(
        ensure_public_http_target(&url::Url::parse("https://example.com/feed.xml").unwrap())
            .is_ok()
    );
    assert!(ensure_public_http_target(&url::Url::parse("http://1.2.3.4/x").unwrap()).is_ok());
    for bad in [
        "http://127.0.0.1:8080/",
        "http://192.168.1.1/admin",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/",
        "file:///etc/passwd",
        "ftp://example.com/",
    ] {
        let parsed = url::Url::parse(bad).unwrap();
        assert!(
            ensure_public_http_target(&parsed).is_err(),
            "{bad} 应被拒绝"
        );
    }
}

/// 解析一段 feed 并取出第一篇文章（测试里只关心内容种类识别）
fn parse_first(xml: &str, url: &str) -> Article {
    let feed = parser::parse(xml.as_bytes()).expect("测试 feed 应能解析");
    build_article(&feed, &short_hash(url), &feed.entries[0])
}

/// 旧配置的模型目录是纯字符串数组：必须能读出来，否则用户已存好的 Provider 会整个加载失败。
#[test]
fn legacy_string_model_catalog_still_loads() {
    let json = r#"{
            "providers": [{
                "provider_id": "deepseek",
                "display_name": "DeepSeek",
                "api_url": "https://api.deepseek.com",
                "protocol": "openai-completions",
                "api_key": "sk-x",
                "model": "deepseek-chat",
                "models": ["deepseek-chat", "deepseek-reasoner"],
                "is_active": true
            }],
            "active_provider_id": "deepseek",
            "target_lang": "简体中文"
        }"#;
    let config: TranslateConfig = serde_json::from_str(json).expect("旧配置应能解析");
    let models = &config.providers[0].models;
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "deepseek-chat");
    assert_eq!(models[1].id, "deepseek-reasoner");
    // 旧配置没有参数：补默认值而不是丢弃条目
    assert_eq!(models[0].display_name, "");
    assert_eq!(models[0].context_window, 0);
    assert_eq!(models[0].max_output_tokens, 0);
}

/// 新配置的对象数组要原样保留显示名与能力参数。
#[test]
fn structured_model_catalog_keeps_params() {
    let json = r#"{
            "providers": [{
                "provider_id": "gw",
                "display_name": "网关",
                "api_url": "https://gateway.example/v1",
                "protocol": "anthropic-messages",
                "model": "claude-sonnet",
                "models": [{
                    "id": "claude-sonnet",
                    "display_name": "Sonnet",
                    "context_window": 1048576,
                    "max_output_tokens": 32768
                }]
            }]
        }"#;
    let config: TranslateConfig = serde_json::from_str(json).expect("新配置应能解析");
    let m = &config.providers[0].models[0];
    assert_eq!(m.id, "claude-sonnet");
    assert_eq!(m.display_name, "Sonnet");
    assert_eq!(m.context_window, 1_048_576);
    assert_eq!(m.max_output_tokens, 32_768);
    // 缺省字段（active_provider_id / target_lang）不该让整个配置解析失败
    assert!(config.active_provider_id.is_none());
    assert!(config.target_lang.is_none());
}

/// 最大输出 token 只认「目录里选中模型自己填的值」：没填或模型不在目录里就不发该参数。
#[test]
fn selected_max_output_uses_selected_model_only() {
    let model = |id: &str, max: u32| TranslateModel {
        id: id.into(),
        display_name: String::new(),
        context_window: 0,
        max_output_tokens: max,
    };
    let provider = |model_id: &str, models: Vec<TranslateModel>| TranslateProvider {
        provider_id: "p".into(),
        display_name: "p".into(),
        api_url: "https://example.com".into(),
        protocol: "openai-completions".into(),
        api_key: None,
        model: model_id.into(),
        models,
        is_active: true,
        disable_thinking: false,
    };

    // 选中模型没填 → 不发
    assert_eq!(
        selected_max_output(&provider("a", vec![model("a", 0)])),
        None
    );
    // 选中模型填了 → 原样发出
    assert_eq!(
        selected_max_output(&provider("a", vec![model("a", 4096)])),
        Some(4096)
    );
    // 目录里另一个模型填了、但选中的那个没填 → 不发（只看选中项）
    assert_eq!(
        selected_max_output(&provider("a", vec![model("a", 0), model("b", 8192)])),
        None
    );
    // 选中的模型不在目录里 → 不发
    assert_eq!(
        selected_max_output(&provider("missing", vec![model("a", 4096)])),
        None
    );
}

/// 关闭思考模式：只有显式打开时才在 OpenAI 兼容请求体里带 `thinking:{type:"disabled"}`。
/// 这个字段名是 serde 手写的（`type` 是 Rust 关键字，走 rename），且默认必须**不发** ——
/// 别的 OpenAI 兼容网关不认识它，误发会直接 400。所以两头都钉住。
#[test]
fn chat_request_sends_thinking_only_when_disabled_explicitly() {
    let body = |disable_thinking: bool| {
        let req = ChatRequest {
            model: "deepseek-flash",
            messages: vec![ChatMessage {
                role: "user",
                content: "Hello".into(),
            }],
            temperature: Some(0.3),
            max_tokens: None,
            thinking: disable_thinking.then_some(ThinkingParam { kind: "disabled" }),
            stream: None,
        };
        serde_json::to_value(&req).expect("ChatRequest 应能序列化")
    };

    // 默认（不干预）：请求体里没有 thinking 字段
    let off = body(false);
    assert!(off.get("thinking").is_none(), "默认不应发送 thinking 字段");

    // 显式关闭：字段名与结构必须与 DeepSeek 文档一致
    let on = body(true);
    assert_eq!(
        on.get("thinking"),
        Some(&serde_json::json!({ "type": "disabled" }))
    );
}

/// SSE 行取值：`data:` 前缀 + 一个可选空格，其它字段一律不吃。
#[test]
fn sse_payload_only_takes_data_lines() {
    assert_eq!(sse_data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
    // 规范允许冒号后无空格
    assert_eq!(sse_data_payload("data:{\"a\":1}"), Some("{\"a\":1}"));
    assert_eq!(sse_data_payload("event: message_start"), None);
    assert_eq!(sse_data_payload(": heartbeat"), None);
    assert_eq!(sse_data_payload(""), None);
}

/// 三种协议的增量提取：各自的结构不同，且**思考增量必须被忽略**（不能显示成译文）。
#[test]
fn sse_delta_text_handles_all_three_protocols() {
    // openai-completions：choices[0].delta.content
    assert_eq!(
        sse_delta_text(
            "openai-completions",
            r#"{"choices":[{"delta":{"content":"你好"}}]}"#
        ),
        Some("你好".to_string())
    );
    // 首个 chunk 只有 role，没有 content → 跳过
    assert_eq!(
        sse_delta_text(
            "openai-completions",
            r#"{"choices":[{"delta":{"role":"assistant"}}]}"#
        ),
        None
    );
    // 结束标记
    assert_eq!(sse_delta_text("openai-completions", "[DONE]"), None);
    // 思考增量（reasoning_content）不在 content 里 → 天然跳过
    assert_eq!(
        sse_delta_text(
            "openai-completions",
            r#"{"choices":[{"delta":{"reasoning_content":"让我想想"}}]}"#
        ),
        None
    );

    // openai-responses：靠 type 区分，delta 是字符串
    assert_eq!(
        sse_delta_text(
            "openai-responses",
            r#"{"type":"response.output_text.delta","delta":"世界"}"#
        ),
        Some("世界".to_string())
    );
    assert_eq!(
        sse_delta_text("openai-responses", r#"{"type":"response.created"}"#),
        None
    );

    // anthropic-messages：delta 是对象，取 .text
    assert_eq!(
        sse_delta_text(
            "anthropic-messages",
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"世界"}}"#
        ),
        Some("世界".to_string())
    );
    // 思考增量（thinking_delta）同样是 content_block_delta，但 delta.text 为空 → 跳过
    assert_eq!(
        sse_delta_text(
            "anthropic-messages",
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"嗯"}}"#
        ),
        None
    );

    // 坏 JSON 不能 panic，按「不是增量」处理
    assert_eq!(sse_delta_text("openai-completions", "{不是 json"), None);
}

/// 扩写判定：真扩写要抓到，正常译文（含括注、稍长）不能误判。
#[test]
fn looks_expanded_is_not_trigger_happy() {
    // 正常译文：短原文配一个稍长的正常译文 → 不重试
    assert!(!looks_expanded(
        "Real-world randomness",
        "现实世界中的随机性（randomness）"
    ));
    // 原文不短（超过 SHORT_FRAGMENT_CHARS）→ 这个启发式不适用（长篇本该长译）
    let long_source = "a ".repeat(60);
    assert!(!looks_expanded(&long_source, &"译".repeat(5000)));
    // 真正的扩写（短标题被写成一整篇清单）仍然要抓到
    assert!(looks_expanded("Randomness", &"译".repeat(400)));
}

/// 推理模型把思考写进 content 时必须剥掉，只留 </think> 之后的译文
/// （否则整段英文思考会被当成译文显示出来）。
#[test]
fn thinking_is_stripped_from_translation_output() {
    // 真实形态：一长段英文思考 + 闭标签 + 真正的中文译文
    let raw = "We are given a query: \"Title\". We need to translate this into Chinese.\n\
                   The query is about real-world applications. </think> 随机性在现实中的应用场景";
    assert_eq!(strip_thinking(raw), "随机性在现实中的应用场景");

    // 有多个闭标签时以最后一个为准（思考里可能引用过 </think>）
    assert_eq!(
        strip_thinking("思考 A </think> 中间 </think> 真正的译文"),
        "真正的译文"
    );

    // 只有开标签：整段都是思考，剥完为空（调用方据此报错提示换模型）
    assert_eq!(strip_thinking("<think>想了半天没写译文"), "");

    // 普通模型：原样返回（顺带去掉首尾空白）
    assert_eq!(strip_thinking("  普通译文  "), "普通译文");
}

/// 模型「用原文语言回答原文」必须被识别出来（真实踩过：把反问句回成 Yes, that's a valid idea）。
#[test]
fn answering_instead_of_translating_is_detected() {
    let src = "Wouldn't it be nice if we could wield controlled presentational randomness?";
    // 目标中文却全是英文 → 判为没翻
    assert!(looks_untranslated(
            "简体中文",
            src,
            "Yes, that's a valid idea. Keeping presentation control within CSS allows for dynamic visual adjustments."
        ));
    // 正常的中文译文 → 通过
    assert!(!looks_untranslated(
        "简体中文",
        src,
        "如果能在展示层掌控这种随机性，岂不是很好？"
    ));
    // 目标不是 CJK 语言时，用「与原文是否相同」判定
    assert!(looks_untranslated("English", "你好", "你好"));
    assert!(!looks_untranslated("English", "你好", "Hello"));
    // 空译文也算没翻
    assert!(looks_untranslated("简体中文", src, "   "));
}

/// 多段合并送翻时，提示词必须明确要求保留分隔标记（否则译文切不回各段）。
#[test]
fn batch_marker_instruction_is_included() {
    let prompt = build_translate_system(
        "简体中文",
        "自动检测",
        Some("某文章"),
        "第一段\n@@@RSS-SEG@@@\n第二段",
        Some("@@@RSS-SEG@@@"),
        false,
    );
    assert!(prompt.contains("@@@RSS-SEG@@@"));
    assert!(prompt.contains("原样保留"));
    // 单段请求（没有标记）时不应出现这段要求
    let single = build_translate_system(
        "简体中文",
        "自动检测",
        Some("某文章"),
        "一段话",
        None,
        false,
    );
    assert!(!single.contains("RSS-SEG"));
}

/// 旧 state.json 的订阅源没有刷新状态字段（那时还没这功能）：必须能照常解析，
/// 缺省成「没有错误、从未成功刷新过」，而不是让整个状态读不出来。
/// 这是存量用户升级路径，读不出来等于订阅全丢。
#[test]
fn feed_without_refresh_status_still_parses() {
    let json = r#"{
            "id": "abc",
            "url": "https://example.com/feed.xml",
            "title": "示例源",
            "description": null,
            "site_url": null,
            "added_at": "2026-01-01T00:00:00Z",
            "group_id": null,
            "sort_order": 0,
            "open_method": null
        }"#;
    let feed: Feed = serde_json::from_str(json).expect("旧订阅源应能解析");
    assert_eq!(feed.last_success_at, None);
    assert_eq!(feed.last_error, None);
    assert_eq!(feed.fail_count, 0);
}

/// 带刷新状态的订阅源要原样往返（save_state 是「前端对象 → Rust 结构 → JSON」，
/// 字段漏在结构里就会被静默丢掉）。
#[test]
fn feed_refresh_status_round_trips() {
    let json = r#"{
            "id": "abc",
            "url": "https://example.com/feed.xml",
            "title": "示例源",
            "description": null,
            "site_url": null,
            "added_at": "2026-01-01T00:00:00Z",
            "group_id": null,
            "sort_order": 0,
            "open_method": null,
            "last_success_at": "2026-02-01T00:00:00Z",
            "last_error": "HTTP 状态码 503",
            "fail_count": 4
        }"#;
    let feed: Feed = serde_json::from_str(json).expect("应能解析");
    assert_eq!(
        feed.last_success_at.as_deref(),
        Some("2026-02-01T00:00:00Z")
    );
    assert_eq!(feed.last_error.as_deref(), Some("HTTP 状态码 503"));
    assert_eq!(feed.fail_count, 4);
    // 再序列化回去，三个字段都还在
    let back = serde_json::to_value(&feed).expect("应能序列化");
    assert_eq!(back["fail_count"], 4);
    assert_eq!(back["last_error"], "HTTP 状态码 503");
    assert_eq!(back["last_success_at"], "2026-02-01T00:00:00Z");
}

/// 短标题被模型当成题目扩写成一篇，要能被识别。
#[test]
fn expanded_title_is_detected() {
    let title = "Real-world use cases for randomness";
    let expanded = format!(
        "随机性在现实生活中有着广泛的应用。以下是一些常见场景：{}",
        "1.游戏与娱乐 2.加密与安全 3.天气预测 4.金融交易 5.科学研究 6.艺术创作 7.日常生活 "
            .repeat(3)
    );
    assert!(looks_expanded(title, &expanded));
    // 正常长度的译文不要误判
    assert!(!looks_expanded(title, "随机性在现实中的应用场景"));
    // 长原文不受这条规则约束（长文本来就该是长译文）
    assert!(!looks_expanded(&"a".repeat(200), &"译".repeat(400)));
}

/// 三种机器翻译协议要能被识别出来（否则会被当成大模型协议，去要一个不存在的模型）。
#[test]
fn machine_translate_protocols_are_detected() {
    assert!(is_machine_translate("microsoft-translator"));
    assert!(is_machine_translate("google-translate"));
    assert!(is_machine_translate("deepl"));
    assert!(!is_machine_translate("openai-completions"));
    assert!(!is_machine_translate("anthropic-messages"));
}

/// 应用里的语言名要翻成三家各自要的语言代码；「自动检测」不传；
/// 表外的语言名原样透传（DeepL 转大写），方便直接写 en-US 这类代码。
#[test]
fn language_names_map_to_each_provider_codes() {
    assert_eq!(
        mt_language_code("microsoft-translator", "简体中文").as_deref(),
        Some("zh-Hans")
    );
    assert_eq!(
        mt_language_code("google-translate", "简体中文").as_deref(),
        Some("zh-CN")
    );
    assert_eq!(mt_language_code("deepl", "简体中文").as_deref(), Some("ZH"));
    assert_eq!(
        mt_language_code("deepl", "繁体中文").as_deref(),
        Some("ZH-HANT")
    );
    assert_eq!(mt_language_code("deepl", "English").as_deref(), Some("EN"));
    assert_eq!(
        mt_language_code("microsoft-translator", "日本語").as_deref(),
        Some("ja")
    );
    // 源语言「自动检测」= 不传该参数，交给服务端判断
    assert_eq!(mt_language_code("deepl", "自动检测"), None);
    assert_eq!(mt_language_code("deepl", "  "), None);
    // 表外：原样透传（DeepL 要求大写）
    assert_eq!(
        mt_language_code("google-translate", "pt-BR").as_deref(),
        Some("pt-BR")
    );
    assert_eq!(mt_language_code("deepl", "pt-BR").as_deref(), Some("PT-BR"));
}

/// DeepL 端点必须与密钥类型匹配：免费版密钥（以 :fx 结尾）打专业版端点只会得到 403
/// 「Wrong endpoint. Use https://api-free.deepl.com」，所以这里按密钥把端点纠过来。
/// 只动官方这两个域名，自建 / 反代地址一律不碰。
#[test]
fn deepl_base_follows_key_kind() {
    let free = "9e837803-a15a-434d-90d2-72f64be5d18f:fx";
    let pro = "9e837803-a15a-434d-90d2-72f64be5d18f";
    // 免费版密钥 + 专业版端点 → 纠成免费版端点
    assert_eq!(
        deepl_base_for_key("https://api.deepl.com", free),
        "https://api-free.deepl.com"
    );
    // 带路径 / 结尾斜杠也照样纠，路径保留
    assert_eq!(
        deepl_base_for_key("https://api.deepl.com/v2/translate", free),
        "https://api-free.deepl.com/v2/translate"
    );
    // 专业版密钥 + 免费版端点 → 纠成专业版端点
    assert_eq!(
        deepl_base_for_key("https://api-free.deepl.com", pro),
        "https://api.deepl.com"
    );
    // 已经配对：原样返回
    assert_eq!(
        deepl_base_for_key("https://api-free.deepl.com", free),
        "https://api-free.deepl.com"
    );
    // 自建 / 反代地址不动（哪怕密钥类型对不上）
    assert_eq!(
        deepl_base_for_key("https://deepl.internal.example/api", free),
        "https://deepl.internal.example/api"
    );
    // 没填密钥时不做判断
    assert_eq!(
        deepl_base_for_key("https://api.deepl.com", "   "),
        "https://api.deepl.com"
    );
}

/// 端点补全：用户只填服务根地址时要拼出官方路径；已经填全的不要重复拼。
#[test]
fn mt_endpoint_completes_paths() {
    assert_eq!(
            mt_endpoint(
                "microsoft-translator",
                "https://api.cognitive.microsofttranslator.com",
                "zh-Hans",
                Some("en")
            )
            .unwrap(),
            "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans&from=en"
        );
    // 目标语言里的 - 是 URL 安全字符，不该被转义
    assert_eq!(
        mt_endpoint(
            "google-translate",
            "https://translation.googleapis.com",
            "zh-CN",
            None
        )
        .unwrap(),
        "https://translation.googleapis.com/language/translate/v2"
    );
    assert_eq!(
        mt_endpoint("deepl", "https://api-free.deepl.com", "ZH", None).unwrap(),
        "https://api-free.deepl.com/v2/translate"
    );
    assert_eq!(
        mt_endpoint("deepl", "https://api.deepl.com/v2", "ZH", None).unwrap(),
        "https://api.deepl.com/v2/translate"
    );
    // 已经填全的地址原样使用
    assert_eq!(
        mt_endpoint(
            "deepl",
            "https://api-free.deepl.com/v2/translate",
            "ZH",
            None
        )
        .unwrap(),
        "https://api-free.deepl.com/v2/translate"
    );
    assert_eq!(
        mt_endpoint(
            "google-translate",
            "https://translation.googleapis.com/language/translate/v2",
            "ZH",
            None
        )
        .unwrap(),
        "https://translation.googleapis.com/language/translate/v2"
    );
    // 带查询串的地址：路径之外的都丢掉，由我们统一拼（避免出现两个 ?）
    assert_eq!(
        mt_endpoint(
            "microsoft-translator",
            "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0",
            "zh-Hans",
            None
        )
        .unwrap(),
        "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans"
    );
    // 源语言未知时不拼 from（自动检测）
    assert!(
        !mt_endpoint("microsoft-translator", "https://x.example", "ZH", None)
            .unwrap()
            .contains("from=")
    );
}

/// HMAC-SHA256 是自己实现的（为了不新增依赖），拿 RFC 4231 的标准向量钉住：
/// 普通 key 与「超过一个分组」的 key 各一条。
#[test]
fn hmac_sha256_matches_rfc4231() {
    assert_eq!(
        hex::encode(hmac_sha256(&[0x0b; 20], b"Hi There")),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );
    assert_eq!(
        hex::encode(hmac_sha256(
            &[0xaa; 131],
            b"Test Using Larger Than Block-Size Key - Hash Key First"
        )),
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
    );
}

/// 腾讯云签名的拼装格式用官方《签名方法 v3》示例里的两个中间值校验：
/// 请求体哈希与规范请求串哈希。签名本身依赖 SecretKey，文档里打码了，所以钉这两个。
#[test]
fn tencent_signature_matches_documented_vector() {
    let payload =
        r#"{"Limit": 1, "Filters": [{"Values": ["\u672a\u547d\u540d"], "Name": "instance-name"}]}"#;
    assert_eq!(
        sha256_hex(payload),
        "35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064"
    );
    let canonical =
        tencent_canonical_request("cvm.tencentcloudapi.com", "DescribeInstances", payload);
    assert_eq!(
        canonical,
        "POST\n/\n\n\
             content-type:application/json; charset=utf-8\n\
             host:cvm.tencentcloudapi.com\n\
             x-tc-action:describeinstances\n\n\
             content-type;host;x-tc-action\n\
             35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064"
    );
    assert_eq!(
        sha256_hex(&canonical),
        "7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84"
    );
}

/// 腾讯云的凭据是**一对**（SecretId:SecretKey），不是单个 key；地域可选。
#[test]
fn tencent_credentials_are_a_pair() {
    let (id, key, region) = parse_tencent_credentials("AKIDabcdef:Gu5t9xGARNpq86cd98joQY").unwrap();
    assert_eq!(id, "AKIDabcdef");
    assert_eq!(key, "Gu5t9xGARNpq86cd98joQY");
    assert_eq!(region, "ap-guangzhou");

    // 末尾可选地域
    let (_, _, region) =
        parse_tencent_credentials("AKIDabcdef:Gu5t9xGARNpq86cd98joQY:ap-beijing").unwrap();
    assert_eq!(region, "ap-beijing");

    // 只给一个值 / 空的：明确报错，别发出去等一个看不懂的签名失败
    assert!(parse_tencent_credentials("AKIDabcdef").is_err());
    assert!(parse_tencent_credentials(":Gu5t9x").is_err());
    assert!(parse_tencent_credentials("AKIDabcdef:").is_err());
    assert!(parse_tencent_credentials("").is_err());
}

/// 腾讯云的限流错误要认出来（认出来才会退避重试，而不是把整批标成「未翻译」）。
#[test]
fn tencent_rate_limit_is_detected() {
    let limited: serde_json::Value = serde_json::from_str(
            r#"{"Response":{"Error":{"Code":"RequestLimitExceeded","Message":"Your current request times equals to `6` in a second, which exceeds the frequency limit `5`"},"RequestId":"x"}}"#,
        )
        .unwrap();
    assert!(tencent_is_rate_limited(&limited));
    // 提示里要说清是限流、以及会自动重试
    let message = tencent_error_message(&limited).expect("应能识别错误");
    assert!(message.contains("5 次/秒"), "{message}");
    assert!(message.contains("重试"), "{message}");
    // 其它错误不该被当成限流（否则会白等几秒再报同样的错）
    assert!(!tencent_is_rate_limited(
        &serde_json::json!({"Response":{"Error":{"Code":"AuthFailure.SignatureFailure"}}})
    ));
    assert!(!tencent_is_rate_limited(
        &serde_json::json!({"Response":{"TargetText":"你好"}})
    ));
}

/// 腾讯云把错误塞在 200 响应的 Response.Error 里，必须显式判并翻成人话。
#[test]
fn tencent_errors_are_read_from_response() {
    let value: serde_json::Value = serde_json::from_str(
            r#"{"Response":{"Error":{"Code":"AuthFailure.SignatureFailure","Message":"The signature is expired"},"RequestId":"x"}}"#,
        )
        .unwrap();
    let message = tencent_error_message(&value).expect("应能识别错误");
    assert!(message.contains("签名"), "{message}");
    // 正常响应不该被当成错误
    assert!(tencent_error_message(
        &serde_json::json!({"Response":{"TargetText":"你好","RequestId":"x"}})
    )
    .is_none());
}

/// 腾讯翻译的语言代码与前几家不同（简体中文是 zh、繁体是 zh-TW）。
#[test]
fn tencent_language_codes() {
    assert_eq!(
        mt_language_code("tencent-tmt", "简体中文").as_deref(),
        Some("zh")
    );
    assert_eq!(
        mt_language_code("tencent-tmt", "繁体中文").as_deref(),
        Some("zh-TW")
    );
    assert_eq!(
        mt_language_code("tencent-tmt", "English").as_deref(),
        Some("en")
    );
    // 自动检测：不传语言码
    assert!(mt_language_code("tencent-tmt", "自动检测").is_none());
    assert!(is_machine_translate("tencent-tmt"));
    assert!(!is_keyless_capable("tencent-tmt"));
}

/// 免密钥通道：只有微软 / 谷歌有网页版接口可走，DeepL / 腾讯翻译必须填密钥。
#[test]
fn keyless_channel_is_limited_to_microsoft_and_google() {
    assert!(is_keyless_capable("microsoft-translator"));
    assert!(is_keyless_capable("google-translate"));
    assert!(!is_keyless_capable("deepl"));
    assert!(!is_keyless_capable("openai-completions"));
    // 两家的提示都要说清「未公开接口」这件事
    assert!(keyless_hint("microsoft-translator").contains("未公开"));
    assert!(keyless_hint("google-translate").contains("未公开"));
    // 这两个服务已经不再有密钥那条路：提示里不能再去让用户「填密钥」，
    // 只能指向别的翻译服务（DeepL / 大模型服务商）
    for protocol in ["microsoft-translator", "google-translate"] {
        let hint = keyless_hint(protocol);
        assert!(
            !hint.contains("API 密钥"),
            "{protocol} 的提示不该再让用户去填密钥：{hint}"
        );
        assert!(
            hint.contains("DeepL"),
            "{protocol} 的提示该给出退路：{hint}"
        );
    }
    // 谷歌在国内需要代理：提示里要写出来，否则用户只看到一句超时
    assert!(keyless_hint("google-translate").contains("代理"));
}

/// 谷歌网页版响应是 `[["译文","en"], …]`：一项对应一个 q，顺序一致；
/// 要还原 HTML 转义；结构不对 / 空译文要报错，而不是返回空串当译文。
#[test]
fn google_web_response_maps_one_per_segment() {
    // 多段：一项一段，顺序与请求的 q 参数一致
    let multi: serde_json::Value =
        serde_json::from_str(r#"[["你好，世界","en"],["再见","en"]]"#).unwrap();
    assert_eq!(
        google_web_parse(&multi).unwrap(),
        vec!["你好，世界".to_string(), "再见".to_string()]
    );

    // 单段：同样的形状，长度 1
    let single: serde_json::Value = serde_json::from_str(r#"[["你好","en"]]"#).unwrap();
    assert_eq!(google_web_parse(&single).unwrap(), vec!["你好".to_string()]);

    // 实体要还原
    let escaped: serde_json::Value = serde_json::from_str(r#"[["it&#39;s fine","en"]]"#).unwrap();
    assert_eq!(
        google_web_parse(&escaped).unwrap(),
        vec!["it's fine".to_string()]
    );

    // 结构不对 / 全空：明确报错（顶层字符串数组也算形状不对 —— 别把 ["译文","en"] 当成两段）
    assert!(google_web_parse(&serde_json::json!({"error": "x"})).is_err());
    assert!(google_web_parse(&serde_json::json!([[["", "a"]]])).is_err());
    assert!(google_web_parse(&serde_json::json!([[123]])).is_err());
    assert!(google_web_parse(&serde_json::json!(["译文", "en"])).is_err());
}

/// 免密钥通道用的是网页版端点，别把它和官方端点（要密钥那条）搞混。
#[test]
fn keyless_endpoints_are_the_web_ones() {
    // 老地址（换令牌那条）已被官方撤掉，别再写回去
    assert_eq!(
        EDGE_WEB_TRANSLATE_URL,
        "https://edge.microsoft.com/translate/translatetext"
    );
    assert!(!EDGE_WEB_TRANSLATE_URL.contains("/translate/auth"));
    // 谷歌这边必须用 clients5 的 dict-chrome-ex 端点：`translate_a/single?client=gtx`
    // 会按客户端指纹拒掉本应用（reqwest/rustls）的请求，一律 429。
    assert_eq!(
        GOOGLE_WEB_ENDPOINT,
        "https://clients5.google.com/translate_a/t"
    );
    assert!(!GOOGLE_WEB_ENDPOINT.contains("translate_a/single"));
}

/// 微软免密钥通道每次都会跑 HTML 标签对齐：正文里的 `<` `>` 会拼成假标签，
/// 所以发出去前转义、收到后还原（顺序不能反，否则 &amp;quot; 会被解成引号）。
#[test]
fn microsoft_keyless_escapes_angle_brackets() {
    let raw = "a < b 且 c > d & e";
    let escaped = escape_entities(raw);
    assert_eq!(escaped, "a &lt; b 且 c &gt; d &amp; e");
    assert_eq!(unescape_entities(&escaped), raw);
    // 原文里本来就写着实体：转义再还原必须一模一样
    let literal = "it&#39;s &quot;ok&quot;";
    assert_eq!(unescape_entities(&escape_entities(literal)), literal);
}

/// 谷歌允许把密钥写进地址（?key=…）：写了就保留在端点里，且不再另发请求头。
#[test]
fn google_endpoint_keeps_key_from_url() {
    assert_eq!(
        mt_endpoint(
            "google-translate",
            "https://translation.googleapis.com?key=abc123",
            "zh-CN",
            None
        )
        .unwrap(),
        "https://translation.googleapis.com/language/translate/v2?key=abc123"
    );
    assert_eq!(
        mt_endpoint(
            "google-translate",
            "https://translation.googleapis.com/language/translate/v2?key=abc123",
            "zh-CN",
            None
        )
        .unwrap(),
        "https://translation.googleapis.com/language/translate/v2?key=abc123"
    );
    // 没写 key 的地址不带查询串（密钥走请求头，不进 URL）
    assert_eq!(
        mt_endpoint(
            "google-translate",
            "https://translation.googleapis.com",
            "zh-CN",
            None
        )
        .unwrap(),
        "https://translation.googleapis.com/language/translate/v2"
    );
    assert_eq!(
        query_api_key("https://x.example?key=abc123").as_deref(),
        Some("abc123")
    );
    // 只能认 key 这个参数名，别的参数不能当成密钥
    assert_eq!(query_api_key("https://x.example?api-version=3.0"), None);
    assert_eq!(query_api_key("https://x.example?token=abc"), None);
    assert_eq!(query_api_key("https://x.example"), None);
}

/// 请求体：三家都要把**多段**一起带上（这正是「逐段对应」的保证），字段名按各家要求。
#[test]
fn mt_bodies_carry_all_segments() {
    let texts = vec!["one".to_string(), "two".to_string()];
    let ms = mt_build_body("microsoft-translator", &texts, Some("en"), "zh-Hans").unwrap();
    assert_eq!(ms[0]["Text"], "one");
    assert_eq!(ms[1]["Text"], "two");
    let google = mt_build_body("google-translate", &texts, None, "zh-CN").unwrap();
    assert_eq!(google["q"], serde_json::json!(["one", "two"]));
    assert_eq!(google["target"], "zh-CN");
    assert_eq!(google["format"], "text");
    // 源语言「自动检测」时不发 source 字段，交给服务端判断
    assert!(google.get("source").is_none());
    let deepl = mt_build_body("deepl", &texts, Some("EN"), "ZH").unwrap();
    assert_eq!(deepl["text"], serde_json::json!(["one", "two"]));
    assert_eq!(deepl["target_lang"], "ZH");
    assert_eq!(deepl["source_lang"], "EN");
    assert_eq!(deepl["preserve_formatting"], true);
    assert!(mt_build_body("openai-completions", &texts, None, "ZH").is_err());
}

/// 响应解析：三家结构各不相同，都要按顺序取出译文。
#[test]
fn mt_responses_are_parsed_in_order() {
    let ms: serde_json::Value = serde_json::from_str(
            r#"[{"detectedLanguage":{"language":"en"},"translations":[{"text":"一","to":"zh-Hans"}]},
                {"detectedLanguage":{"language":"en"},"translations":[{"text":"二","to":"zh-Hans"}]}]"#,
        )
        .unwrap();
    assert_eq!(
        mt_parse_response("microsoft-translator", &ms).unwrap(),
        vec!["一".to_string(), "二".to_string()]
    );

    let google: serde_json::Value = serde_json::from_str(
        r#"{"data":{"translations":[{"translatedText":"一"},{"translatedText":"二"}]}}"#,
    )
    .unwrap();
    assert_eq!(
        mt_parse_response("google-translate", &google).unwrap(),
        vec!["一".to_string(), "二".to_string()]
    );

    let deepl: serde_json::Value = serde_json::from_str(
        r#"{"translations":[{"detected_source_language":"EN","text":"一"},
                {"detected_source_language":"EN","text":"二"}]}"#,
    )
    .unwrap();
    assert_eq!(
        mt_parse_response("deepl", &deepl).unwrap(),
        vec!["一".to_string(), "二".to_string()]
    );
}

/// 谷歌会把引号等字符 HTML 转义，必须还原 —— 否则正文里显示成 &#39;。
#[test]
fn google_translation_unescapes_html_entities() {
    let value: serde_json::Value = serde_json::from_str(
            r#"{"data":{"translations":[{"translatedText":"it&#39;s &quot;ok&quot; &lt;b&gt; &amp;quot;"}]}}"#,
        )
        .unwrap();
    assert_eq!(
        mt_parse_response("google-translate", &value).unwrap(),
        vec!["it's \"ok\" <b> &quot;".to_string()]
    );
    // 没有实体的译文原样返回
    assert_eq!(unescape_entities("普通译文"), "普通译文");
}

/// 三家的错误体各不相同，都要能被取出来提示用户；空响应要明确报错而不是当成空译文。
#[test]
fn mt_error_and_empty_responses_are_reported() {
    let ms_error: serde_json::Value =
        serde_json::from_str(r#"{"error":{"code":401000,"message":"Access denied"}}"#).unwrap();
    assert_eq!(
        mt_error_message(&ms_error).as_deref(),
        Some("Access denied")
    );
    let deepl_error: serde_json::Value =
        serde_json::from_str(r#"{"message":"Wrong API key"}"#).unwrap();
    assert_eq!(
        mt_error_message(&deepl_error).as_deref(),
        Some("Wrong API key")
    );
    assert_eq!(
        mt_error_message(&serde_json::json!({"translations":[]})),
        None
    );

    let empty: serde_json::Value = serde_json::from_str(r#"{"data":{"translations":[]}}"#).unwrap();
    assert!(mt_parse_response("google-translate", &empty).is_err());
    // 429 / 401 要有针对性的提示（密钥不对是最常见的踩坑）
    assert!(mt_http_hint(403).contains("密钥"));
    assert!(mt_http_hint(429).contains("限流"));
    assert_eq!(mt_http_hint(200), "");
}

/// 前端发来的多段请求体（snake_case 嵌套字段）必须能反序列化成 TranslateBatchRequest。
#[test]
fn batch_request_deserializes_from_frontend_shape() {
    let json = r#"{
            "texts": ["第一段", "第二段"],
            "source": "自动检测",
            "target": "简体中文",
            "provider": {
                "provider_id": "deepl",
                "display_name": "DeepL",
                "api_url": "https://api-free.deepl.com",
                "protocol": "deepl",
                "api_key": "k:fx",
                "model": "",
                "models": [],
                "is_active": true
            }
        }"#;
    let req: TranslateBatchRequest = serde_json::from_str(json).expect("多段请求应能解析");
    assert_eq!(req.texts.len(), 2);
    assert_eq!(req.provider.protocol, "deepl");
    assert!(req.provider.model.is_empty());
    assert_eq!(
        mt_language_code("deepl", &req.target).as_deref(),
        Some("ZH")
    );
}

/// 内置网关的「已提供过」名单必须能落盘往返：否则用户删掉谷歌翻译再保存，
/// 下次启动又会被补回来（像是删不掉）。serde 默认丢弃未知字段，很容易在这里踩坑。
#[test]
fn known_builtins_survive_a_save_load_round_trip() {
    let json = r#"{
            "providers": [{
                "provider_id": "deepl",
                "display_name": "DeepL",
                "api_url": "https://api-free.deepl.com",
                "protocol": "deepl",
                "api_key": "k:fx",
                "model": "",
                "models": [],
                "is_active": true
            }],
            "active_provider_id": "deepl",
            "source_lang": "自动检测",
            "target_lang": "简体中文",
            "known_builtins": ["microsoft", "google", "deepl"]
        }"#;
    let config: TranslateConfig = serde_json::from_str(json).expect("配置应能解析");
    assert_eq!(config.known_builtins.len(), 3);
    // 存回去再读一遍，名单不能丢
    let raw = serde_json::to_string(&config).expect("配置应能序列化");
    let back: TranslateConfig = serde_json::from_str(&raw).expect("配置应能再解析");
    assert_eq!(back.known_builtins, config.known_builtins);
    // 旧配置没有这个字段：补默认空列表，不能让整份配置读不出来
    let legacy: TranslateConfig =
        serde_json::from_str(r#"{"providers": [], "active_provider_id": null}"#).unwrap();
    assert!(legacy.known_builtins.is_empty());
}

/// 真实形态：diygod.cc/europe-travel 是「200 + meta refresh」跳到 B 站视频页的跳转页，
/// 不跟随的话「获取全文」抓到的就是这张没有正文的空壳。
#[test]
fn meta_refresh_is_extracted_from_redirect_shell() {
    let base = url::Url::parse("https://diygod.cc/europe-travel").unwrap();
    let html = r#"<!doctype html><title>Redirecting to: https://www.bilibili.com/video/BV1hzqrBtEMP/</title><meta http-equiv="refresh" content="2;url=https://www.bilibili.com/video/BV1hzqrBtEMP/"><meta name="robots" content="noindex"><link rel="canonical" href="https://www.bilibili.com/video/BV1hzqrBtEMP/"><body><a href="https://www.bilibili.com/video/BV1hzqrBtEMP/">Redirecting</a></body>"#;
    let got = extract_meta_refresh(html, &base).expect("应解析出跳转目标");
    assert_eq!(got.as_str(), "https://www.bilibili.com/video/BV1hzqrBtEMP/");
}

#[test]
fn meta_refresh_handles_case_quotes_and_relative_targets() {
    let base = url::Url::parse("https://example.com/a/b").unwrap();
    let cases = [
        (
            r#"<meta http-equiv=refresh content="0;URL=/moved/here">"#,
            "https://example.com/moved/here",
        ),
        (
            r#"<meta http-equiv='REFRESH' content='3; url=next.html'>"#,
            "https://example.com/a/next.html",
        ),
        (
            // content 写在 http-equiv 之前
            r#"<meta content="0;url=https://other.example/x" http-equiv="refresh">"#,
            "https://other.example/x",
        ),
    ];
    for (html, want) in cases {
        let got = extract_meta_refresh(html, &base).expect(html);
        assert_eq!(got.as_str(), want, "{html}");
    }
}

#[test]
fn normal_page_is_not_treated_as_redirect() {
    let base = url::Url::parse("https://example.com/post").unwrap();
    // canonical / robots / description 这些常见 meta 都不能被当成跳转
    let html = r#"<html><head><meta charset="utf-8"><meta name="robots" content="index,follow"><meta name="description" content="看看 url= 出现在正文 meta 里"><link rel="canonical" href="https://example.com/post"></head><body><p>正文</p></body></html>"#;
    assert!(extract_meta_refresh(html, &base).is_none());
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
    let root = std::env::temp_dir().join(format!("rss-purge-test-{}-{tag}", std::process::id()));
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
