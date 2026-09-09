# 更新日志 / Changelog

本文件记录本项目的所有重要变更。
All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows
[Semantic Versioning](https://semver.org/).

## [未发布] / Unreleased

## [0.1.1] - 2026-09-09

### 修复 / Fixed

- 屏蔽 WebView 默认右键菜单（Back / Refresh / Save as / Print 等浏览器菜单）；
  搜索框、订阅源 URL、代理设置等文本输入框保留系统粘贴 / 复制菜单。
  Suppressed the WebView default context menu (Back / Refresh / Save as / Print); text inputs such as
  the search box, feed URL and proxy settings keep the native paste / copy menu.

### 文档 / Documentation

- 新增中文 `README_zh.md` 与英文 `README.md`（`README.md` 为默认首页），补充各平台前置依赖、
  快捷键、常见问题与贡献指南。
  Added the Chinese `README_zh.md` and English `README.md` (the default landing page), covering
  platform prerequisites, keyboard shortcuts, troubleshooting and contributing.
- 新增 Apache-2.0 `LICENSE`、`.gitattributes`（统一行尾为 LF）。
  Added the Apache-2.0 `LICENSE` and `.gitattributes` (LF line endings).

## [0.1.0] - 2026-09-09

### 新增 / Added

- 应用骨架：Tauri 2 + React 18 + TypeScript（strict）+ Vite 5，Fluent 2 界面与无边框自定义标题栏。
  App skeleton: Tauri 2 + React 18 + TypeScript (strict) + Vite 5, Fluent 2 UI with a frameless
  custom title bar.
- 订阅源管理：RSS 2.0 / 1.0、Atom、JSON Feed 解析；分组与排序；OPML 导入 / 导出；
  单个订阅源可设为「应用内阅读」或「外部浏览器打开」。
  Feed management: RSS 2.0 / 1.0, Atom and JSON Feed parsing; groups and ordering; OPML import /
  export; per-feed in-app reader or external browser mode.
- 抓取：浏览器风格 User-Agent、URL 协议校验、`ETag` / `Last-Modified` 条件请求（304 跳过下载）、
  并发上限 6、可配置自动抓取间隔（10 分钟 ~ 1 小时）。
  Fetching: browser-style User-Agent, URL scheme validation, `ETag` / `Last-Modified` conditional
  requests (304 skips the download), concurrency capped at 6, configurable auto-refresh interval
  (10 minutes to 1 hour).
- 阅读：两栏布局（分隔条可拖拽）、紧凑 / 列表 / 卡片三种视图、全部 / 未读 / 收藏筛选、
  最新 / 最早 / 按订阅源排序、全文搜索、摘要过短时抓取原文全文（最近 20 篇缓存）。
  Reading: two-column layout with a draggable splitter, compact / list / card views, all / unread /
  starred filters, newest / oldest / feed sorting, full-text search, and full-text fetch when a
  summary is too short (20 most recent cached).
- 图片：本地 `rssimg://` 协议代理（浏览器 UA、`Referer` 重试阶梯、GitHub Pages 回退 jsdelivr 镜像、
  单图 50 MB 上限、成功响应缓存 7 天）。
  Images: local `rssimg://` proxy (browser UA, `Referer` retry ladder, jsdelivr fallback for GitHub
  Pages, 50 MB per-image limit, 7-day cache for successful responses).
- 网络：HTTP / SOCKS5 代理与连通性测试（SOCKS5 走 `socks5h`，域名由代理解析）。
  Networking: HTTP / SOCKS5 proxy with a connectivity test (SOCKS5 uses `socks5h`, names resolved
  by the proxy).
- 数据：状态持久化到 `app_data_dir/state.json`（临时文件 + 原子改名、800 ms 防抖落盘）、
  JSON 备份 / 还原、按发布时间清理缓存文章（保留星标）。
  Data: state persisted to `app_data_dir/state.json` (temp file + atomic rename, 800 ms debounced
  writes), JSON backup / restore, and age-based cleanup of cached articles (starred kept).
- 安全：最小权限 capabilities、严格 CSP、外部链接统一走 opener 插件、全局 `<a>` 点击守卫、
  正文渲染前移除 `script` / `iframe` / `form` 等节点。
  Security: least-privilege capabilities, strict CSP, all external links routed through the opener
  plugin, a global `<a>` click guard, and removal of `script` / `iframe` / `form` nodes before
  rendering article HTML.
- 图标字体：Material Symbols Rounded 本地子集化（约 36 KB，不依赖 Google CDN）。
  Icon font: a locally subset Material Symbols Rounded (~36 KB, no Google CDN dependency).

[未发布] / Unreleased: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/z1HwanG/RSS-Reader/releases/tag/v0.1.0
