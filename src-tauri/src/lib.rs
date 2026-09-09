mod commands;

use commands::rss::{ClientCache, ProxySetting};
use std::sync::RwLock;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProxySetting(RwLock::new(None)))
        .manage(ClientCache::new())
        // 文章图片走本地 rssimg 协议：由 Rust 侧统一抓取（带浏览器 UA + 应用代理），
        // 绕开防盗链 Referer 校验与 http 图片的混合内容拦截
        .register_asynchronous_uri_scheme_protocol("rssimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = commands::rss::handle_rssimg_request(&app, request).await;
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::rss::load_state,
            commands::rss::save_state,
            commands::rss::fetch_feed,
            commands::rss::fetch_article_html,
            commands::rss::backup_state,
            commands::rss::restore_state,
            commands::rss::read_file_text,
            commands::rss::write_file_text,
            commands::rss::update_proxy_setting,
            commands::rss::test_proxy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
