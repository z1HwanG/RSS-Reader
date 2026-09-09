<div align="center">

# RSS Reader

**轻量、跨平台的桌面 RSS 阅读器 · A lightweight, cross-platform desktop RSS reader**

基于 **Tauri 2** + **React 18** + **TypeScript**，抓取与解析在 Rust 侧完成。

Built with **Tauri 2** + **React 18** + **TypeScript**; fetching and parsing run in Rust.

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

### 📖 文档 / Documentation

**[中文文档 →](README_zh.md)** &nbsp;·&nbsp; **[English documentation →](README_en.md)**

</div>

---

## 快速开始 / Quick start

```bash
npm install
npm run tauri dev      # 开发模式 / dev mode
npm run tauri build    # 打包当前平台 / bundle for the host platform
```

需要 Rust stable 与 Node.js 18+，以及各平台 WebView 运行时。

Requires Rust stable, Node.js 18+, and the platform WebView runtime.

## 主要特性 / Highlights

- 订阅管理：RSS / Atom / JSON Feed、分组与排序、OPML 导入导出、条件请求（ETag / Last-Modified）
- 阅读体验：两栏布局、三种列表视图、全文搜索、摘要过短时一键抓取原文全文
- 图片与网络：本地 `rssimg://` 图片代理（绕开防盗链与混合内容）、HTTP / SOCKS5 代理与连通性测试
- 数据与安全：状态本地持久化 + 原子写盘、JSON 备份还原、按天清理缓存、最小权限 capabilities

- Feed management: RSS / Atom / JSON Feed, groups and ordering, OPML import / export, conditional
  requests (ETag / Last-Modified)
- Reading: two-column layout, three list views, full-text search, one-click full-text fetch
- Images and network: local `rssimg://` image proxy (bypasses hotlink and mixed-content issues),
  HTTP / SOCKS5 proxy with a connectivity test
- Data and security: local state with atomic writes, JSON backup / restore, age-based cleanup,
  least-privilege capabilities

> 详细说明（功能、技术栈、项目结构、架构、IPC 命令、配置、已知限制）请见
> [中文文档](README_zh.md) / [English docs](README_en.md)。
>
> Full details (features, stack, structure, architecture, IPC commands, configuration, known
> limitations) are in [README_zh.md](README_zh.md) / [README_en.md](README_en.md).

## 许可证 / License

[Apache License 2.0](LICENSE) · Copyright © 2026 z1HwanG

可自由使用、修改与分发，保留版权与许可声明并标注修改即可。

Free to use, modify and distribute; keep the copyright and license notices and mark your changes.
