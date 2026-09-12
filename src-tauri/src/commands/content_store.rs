//! 文章正文存储：正文与元数据分离。
//!
//! state.json 只保留元数据（含 300 字纯文本预览），正文落盘在
//! `articles/<feed_id>/<article_id>` 文件里 —— 元数据改动频繁而正文只在抓到新文章时
//! 写一次，分离后：
//! - 每次防抖保存与启动加载只搬运 KB 级元数据，不再序列化几十 MB 的正文；
//! - 查看文章时按需读单个正文文件（毫秒级）。
//!
//! 正文写入统一「更长者胜」：老记录可能只有摘要、刷新后才有全文，
//! 与前端合并历史行为（正文取更长一份）保持一致。

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use super::error::CommandError;
use super::feed::FetchResult;
use super::state::Article;

/// 正文预览的字符上限（纯文本）：列表预览与搜索兜底共用
const PREVIEW_CHARS: usize = 300;

/// 正文存储根目录（不存在则创建）
pub(crate) fn articles_dir(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::Path(e.to_string()))?
        .join("articles");
    std::fs::create_dir_all(&dir).map_err(CommandError::Io)?;
    Ok(dir)
}

/// id 必须是 16 位十六进制（short_hash 的产物）：文件名直接来自前端传入的 id，
/// 这里做防御性校验，杜绝路径注入
fn is_valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn content_path(root: &Path, feed_id: &str, article_id: &str) -> Option<PathBuf> {
    if !is_valid_id(feed_id) || !is_valid_id(article_id) {
        return None;
    }
    Some(root.join(feed_id).join(article_id))
}

/// 写入正文（更长者胜：已有文件更长时保留旧内容）
fn write_content_longer_wins(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read(path) {
        if existing.len() >= content.len() {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// 读取单篇正文；文件不存在或 id 非法时返回 None
pub(crate) fn read_content(root: &Path, feed_id: &str, article_id: &str) -> Option<String> {
    let path = content_path(root, feed_id, article_id)?;
    std::fs::read(path).ok().and_then(|b| String::from_utf8(b).ok())
}

/// 从正文生成纯文本预览：剥标签 → 折叠空白 → 截断。
/// 剥离按「< 到 > 之间丢弃」做，够预览用；不追求与完整 HTML 解析一致。
pub(crate) fn plain_preview(content: &str) -> String {
    let has_tags = content.contains('<') && content.contains('>');
    let text = if has_tags {
        let mut out = String::with_capacity(content.len());
        let mut in_tag = false;
        for c in content.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => out.push(c),
                _ => {}
            }
        }
        out
    } else {
        content.to_string()
    };
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(PREVIEW_CHARS)
        .collect()
}

/// 把抓取结果里的正文落盘，并将 content 从返回值剥离（正文不再过 IPC、不进元数据）。
/// 预览字段顺带生成。单篇写失败只留日志：元数据照常返回，不让整次刷新失败。
pub(crate) fn strip_and_persist_fetch(app: &AppHandle, result: &mut FetchResult) {
    let Ok(root) = articles_dir(app) else {
        return;
    };
    for article in &mut result.articles {
        let Some(content) = article.content.take() else {
            continue;
        };
        article.preview = Some(plain_preview(&content));
        if let Some(path) = content_path(&root, &result.feed_id, &article.id) {
            if let Err(e) = write_content_longer_wins(&path, &content) {
                eprintln!("content_store: 正文写入失败 {}：{e}", path.display());
            }
        }
    }
}

/// 把 Article 列表里的正文挪进内容文件并置 None（元数据瘦身）。
/// 返回是否剥离过内容（调用方据此决定是否回写 state.json）。
/// 场景：旧版 state.json 的迁移、前端异常携带正文的防御性剥离。
pub(crate) fn strip_article_contents(root: &Path, articles: &mut [Article]) -> bool {
    let mut changed = false;
    for article in articles {
        let Some(content) = article.content.take() else {
            continue;
        };
        changed = true;
        if article.preview.is_none() {
            article.preview = Some(plain_preview(&content));
        }
        if let Some(path) = content_path(root, &article.feed_id, &article.id) {
            if let Err(e) = write_content_longer_wins(&path, &content) {
                eprintln!("content_store: 正文迁移写入失败 {}：{e}", path.display());
            }
        }
    }
    changed
}

/// 备份用：从内容文件把正文读回来填进 Article（备份文件保持「完整状态」的旧格式，
/// 旧版本应用也能直接还原）。文件缺失的正文如实留空。
pub(crate) fn restore_article_contents(root: &Path, articles: &mut [Article]) {
    for article in articles {
        if article.content.is_some() {
            continue;
        }
        if let Some(content) = read_content(root, &article.feed_id, &article.id) {
            article.content = Some(content);
        }
    }
}

/// 读取一篇文章的正文（查看文章时按需加载，正文与元数据分离后不再随 state 下发）
#[tauri::command]
pub async fn get_article_content(
    app: AppHandle,
    feed_id: String,
    article_id: String,
) -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, CommandError> {
        let root = articles_dir(&app)?;
        Ok(read_content(&root, &feed_id, &article_id))
    })
    .await
    .map_err(|e| CommandError::Network(format!("读取正文任务执行失败：{e}")))?
}

/// 删除一个订阅源的全部正文文件（删源时调用；元数据随 save_state 一起消失），返回清掉的文件数
#[tauri::command]
pub async fn delete_feed_content(app: AppHandle, feed_id: String) -> Result<u32, CommandError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u32, CommandError> {
        if !is_valid_id(&feed_id) {
            return Err(CommandError::Path("无效的订阅源 ID".into()));
        }
        let dir = articles_dir(&app)?.join(&feed_id);
        let count = std::fs::read_dir(&dir)
            .map(|entries| entries.flatten().count() as u32)
            .unwrap_or(0);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(CommandError::Io)?;
        }
        Ok(count)
    })
    .await
    .map_err(|e| CommandError::Network(format!("清理正文任务执行失败：{e}")))?
}

/// 正文文件迁移的 id 对（订阅源 URL 变更后文章 id 重算）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentIdPair {
    pub old_id: String,
    pub new_id: String,
}

/// 迁移一个订阅源的正文文件（订阅源 URL 变更 → feed_id 与文章 id 重算后调用）：
/// 把旧位置的内容搬到新位置（目标已存在时保留目标），最后清掉旧目录里的残留。
#[tauri::command]
pub async fn move_feed_content(
    app: AppHandle,
    old_feed_id: String,
    new_feed_id: String,
    pairs: Vec<ContentIdPair>,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), CommandError> {
        if !is_valid_id(&old_feed_id) || !is_valid_id(&new_feed_id) {
            return Err(CommandError::Path("无效的订阅源 ID".into()));
        }
        let root = articles_dir(&app)?;
        for pair in &pairs {
            let (Some(from), Some(to)) = (
                content_path(&root, &old_feed_id, &pair.old_id),
                content_path(&root, &new_feed_id, &pair.new_id),
            ) else {
                continue;
            };
            if from == to || !from.exists() || to.exists() {
                continue;
            }
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(CommandError::Io)?;
            }
            std::fs::rename(&from, &to).map_err(CommandError::Io)?;
        }
        let old_dir = root.join(&old_feed_id);
        if old_dir.exists() {
            std::fs::remove_dir_all(&old_dir).map_err(CommandError::Io)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| CommandError::Network(format!("迁移正文任务执行失败：{e}")))?
}
