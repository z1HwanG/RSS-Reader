//! Tauri 命令层：按职能拆分的子模块
//!
//! - `error`：所有命令共用的 CommandError
//! - `state`：数据模型 + state.json 持久化 + 备份还原 / OPML 导入导出
//! - `http`：HTTP 客户端构建（UA / 代理 / 超时）、SSRF 防护、代理配置
//! - `feed`：订阅源抓取与解析、文章原文抓取
//! - `housekeeping`：WebView 缓存与旧版更新残留清理
//! - `translate` / `translate_mt`：AI 翻译网关与机器翻译通道
//! - `image_proxy`：rssimg 本地图片代理协议
//! - `content_store`：文章正文文件存储（与元数据分离，按需读取）
pub mod content_store;
pub mod error;
pub mod feed;
pub mod housekeeping;
pub mod http;
pub mod image_proxy;
pub mod state;
pub mod translate;
pub mod translate_mt;

// 平铺到 commands 顶层：测试模块（tests.rs 的 `use super::*`）用平铺路径访问所有符号
pub(crate) use feed::*;
pub(crate) use housekeeping::*;
pub(crate) use http::*;
pub(crate) use state::*;
pub(crate) use translate::*;
pub(crate) use translate_mt::*;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;
