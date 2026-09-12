//! 错误类型：所有 Tauri 命令共用的 CommandError
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CommandError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 序列化失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("网络请求失败: {0}")]
    Network(String),
    #[error("订阅源解析失败: {0}")]
    Parse(String),
    #[error("无效的 URL: {0}")]
    InvalidUrl(String),
    #[error("路径解析失败: {0}")]
    Path(String),
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
