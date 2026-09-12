//! 应用维护命令：清理 WebView 缓存、清理旧版更新残留的临时目录
use super::error::CommandError;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
pub(crate) fn purge_stale_updater_dirs(app_name: &str, temp_root: &std::path::Path) -> u32 {
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
pub(crate) fn parse_version(version: &str) -> Option<Vec<u32>> {
    if version.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for piece in version.split('.') {
        parts.push(piece.parse::<u32>().ok()?);
    }
    Some(parts)
}
