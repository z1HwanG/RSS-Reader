mod commands;
mod deep_link;

use commands::rss::{ClientCache, ProxySetting};
use std::sync::RwLock;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：再次点击 feed:// 时由它把命令行参数转给已运行的实例；
        // 开启 deep-link feature 后会自动把 URL 交给 deep-link 插件解析
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：检查 → 下载 → 运行安装包（Windows 走 passive 静默模式）；
        // process 插件提供安装完成后的重启能力
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(ProxySetting(RwLock::new(None)))
        .manage(ClientCache::new())
        .manage(deep_link::PendingFeedLink::default())
        .setup(|app| {
            #[cfg(desktop)]
            {
                // 免安装 / 开发场景下也注册协议；安装包安装时同样会写注册表
                let _ = app.deep_link().register_all();
                // 冷启动：地址来自命令行参数
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    deep_link::dispatch(app.handle(), &urls);
                }
                // 运行中：应用已启动时收到新的深链
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    deep_link::dispatch(&handle, &event.urls());
                });
            }
            Ok(())
        })
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
            commands::rss::clear_webview_cache,
            commands::rss::cleanup_old_updater_dirs,
            deep_link::take_pending_feed_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
