<div align="center">

# RSS Reader

**轻量、跨平台的桌面 RSS 阅读器**

基于 **Tauri 2** + **React 18** + **TypeScript** 构建，订阅源抓取与解析全部在 Rust 侧完成，
前端只负责展示与交互，兼顾性能与安全。

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[中文](README_zh.md) | [English](README_en.md)

</div>

---

## 简介

RSS Reader 是一款桌面端订阅阅读器，面向「订阅数量多、希望本地留存、不依赖云端服务」的使用场景。
订阅数据与阅读状态全部保存在本机，不经过任何第三方服务器；网络请求只在抓取订阅源与文章图片时发生。

界面采用 Fluent 2 视觉语言与无边框自定义标题栏，支持浅色 / 深色 / 跟随系统主题。

## 功能特性

### 订阅管理

- 添加 / 编辑 / 删除 RSS 2.0、RSS 1.0、Atom 与 JSON Feed 订阅源
- 分组管理：新建 / 重命名 / 删除分组，订阅源可在分组间调整，列表按分组折叠展示并显示未读数
- OPML 批量导入 / 导出（导入后自动在后台并发刷新新增源）
- 每个订阅源可单独设置「应用内阅读」或「外部浏览器打开」
- 条件请求（`ETag` / `Last-Modified`）：订阅源未变化时服务端返回 304，跳过下载与解析
- 一键刷新全部订阅源，抓取并发上限 6；自动抓取间隔可选 10 / 15 / 20 / 30 / 45 分钟或 1 小时

### 阅读体验

- 两栏布局：左侧文章列表 + 右侧阅读视图，分隔条可拖拽调宽（宽度持久化）
- 文章列表支持「全部 / 未读 / 收藏」筛选、「最新 / 最早 / 按订阅源」排序，以及紧凑 / 列表 / 卡片三种视图
- 全文搜索：标题 + 正文（正文按纯文本索引，单篇截取 4096 字符控制内存）
- RSS 摘要过短时一键抓取原文全文，正文容器启发式提取并清理广告 / 评论 / 侧栏等无关元素，最近 20 篇缓存复用
- 收藏、未读 / 已读标记、一键全部标为已读，订阅源右键菜单可单源标记已读或刷新
- 大列表分批渲染：首屏 300 篇，滚动到底自动加载更多
- 在系统默认浏览器打开原文、复制文章链接

### 图片与网络

- 文章图片统一经本地 `rssimg://` 协议加载，由 Rust 侧带浏览器 User-Agent 抓取，
  绕开防盗链 Referer 校验与 http 图片的混合内容拦截，成功响应缓存 7 天
- 图片抓取带重试阶梯（先直连、遇 403 补 Referer 并记住该图床、失败再回退直连）；
  GitHub Pages 图片额外回退 `cdn.jsdelivr.net` 镜像
- 单张图片体积上限 50 MB，仅放行 `http` / `https` 图片
- HTTP / SOCKS5 代理配置，含主机与端口格式校验、一键连通性测试（多探测目标，避免单站误报）
- SOCKS5 使用 `socks5h`，域名交由代理解析，规避本地 DNS 污染

### 外观与偏好

- 主题跟随系统 / 浅色 / 深色，阅读字号可调，设置即时生效
- 无边框自定义标题栏（拖拽、最小化、最大化、关闭）
- 主题、字号、抓取频率、代理、筛选与视图模式等偏好存于 `localStorage`

### 数据与安全

- 订阅源与文章状态持久化在 Rust 侧（`app_data_dir/state.json`），写盘采用「临时文件 + 原子改名」，避免中途崩溃损坏文件
- 高频操作（标记已读 / 收藏 / 排序）走 800 ms 防抖合并写盘，窗口隐藏或关闭前强制落盘
- 支持整份状态的 JSON 备份 / 还原，以及按发布时间清理本地缓存文章（星标文章保留）
- 抓取前校验 URL 协议（仅 `http` / `https`）；capabilities 采用最小权限
- 外部链接统一走 opener 插件，前端无裸文件 / shell 访问权限
- 全局链接守卫：拦截 WebView 内所有 `<a>` 点击改用系统默认浏览器打开，避免应用 UI 被外部页面覆盖且无法返回

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | React 18 + TypeScript（strict）+ Vite 5 |
| 样式 | 原生 CSS，Fluent 2 设计语言（含 light / dark 主题变量） |
| 图标 | Material Symbols Rounded（本地子集化，约 36 KB） |
| Feed 解析 | feed-rs 2（RSS 2.0/1.0、Atom、JSON Feed） |
| HTTP | reqwest 0.12（rustls TLS、http2、gzip / brotli / deflate、system-proxy、socks） |
| Tauri 插件 | @tauri-apps/plugin-opener、@tauri-apps/plugin-dialog |
| 其他 | serde / serde_json、thiserror、sha2、hex、url、chrono、log |

## 项目结构

```
RSS-Reader/
├── src/                             # React + TS 前端
│   ├── App.tsx                      # 主应用（两栏布局 + 状态管理 + 抓取调度）
│   ├── main.tsx                     # React 入口
│   ├── styles.css                   # 全局样式（Fluent 2，含 light / dark 主题变量）
│   ├── assets/fonts/                # 子集化后的图标字体
│   ├── features/rss/                # RSS 业务域
│   │   ├── components/              # TitleBar / FeedList / ArticleList / ArticleView
│   │   │                            # AddFeedModal / SettingsModal
│   │   ├── services/rssService.ts   # Tauri IPC 封装 + 防抖落盘
│   │   └── types.ts                 # 共享 DTO 类型（与 Rust snake_case 对齐）
│   └── lib/
│       ├── tauri.ts                 # 类型化 invoke 封装
│       ├── preferences.ts           # 主题 / 字号 / 抓取频率 / 代理（localStorage）
│       └── linkGuard.ts             # 全局 <a> 点击守卫 → 系统浏览器
├── src-tauri/                       # Rust 后端
│   ├── src/
│   │   ├── main.rs                  # 桌面入口
│   │   ├── lib.rs                   # Builder 装配 + 命令注册 + rssimg 协议
│   │   └── commands/
│   │       ├── mod.rs
│   │       └── rss.rs               # 状态持久化、抓取解析、全文提取、代理、图片代理
│   ├── capabilities/default.json    # Tauri v2 权限模型（最小权限）
│   ├── icons/                       # 应用图标（含桌面与移动端）
│   ├── Cargo.toml
│   └── tauri.conf.json              # Tauri v2 配置
├── scripts/
│   └── subset-icons.mjs             # 图标字体子集化（新增图标后运行）
├── index.html
├── package.json
└── tsconfig.json
```

## 环境要求

- [Rust](https://www.rust-lang.org/tools/install) stable（建议 1.70+）
- [Node.js](https://nodejs.org/) 18+
- 各平台 WebView 运行时：Windows WebView2 / macOS WebKit / Linux WebKitGTK（Tauri 依赖）
- 可选：[uv](https://docs.astral.sh/uv/) —— 仅在重新生成图标字体子集时需要

## 快速开始

```bash
npm install          # 安装前端与 Tauri CLI 依赖
npm run tauri dev    # 开发模式（Rust 编译 + 前端 HMR 同时启动）
```

> 修改 Rust 代码、`capabilities/` 或 `tauri.conf.json` 后需重启 `tauri dev` 才生效；
> 修改 `src/` 下前端代码走 Vite HMR 热更新。

生产构建：

```bash
npm run tauri build  # 打包当前平台安装包（Windows .msi/.exe、macOS .dmg、Linux .deb/.rpm 等）
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 图标字体子集化

图标使用本地化的 Material Symbols Rounded 并已子集化：完整可变字体约 5.1 MB，
项目只用到 41 个图标，子集后约 36 KB（保留 `rlig` 连字与 `FILL` 可变轴）。

新增图标后重新生成：

```bash
node scripts/subset-icons.mjs   # 需要 uv 与网络（从 Google Fonts 取完整字体）
```

脚本会下载完整字体、按内置图标清单子集化并校验连字可用性，直接写入
`src/assets/fonts/material-symbols-rounded.woff2`。

## 架构说明

- **状态权威在 Rust**：订阅源、文章与分组的增删改经 `load_state` / `save_state` 持久化到
  `app_data_dir/state.json`；前端 UI 偏好（主题、字号、抓取频率、代理、视图模式）属纯展示状态，
  存于 `localStorage`。
- **抓取解析在 Rust 侧**：`fetch_feed` 使用浏览器风格 User-Agent，对 URL 做协议校验，
  发送条件请求并在 304 时直接返回；解析失败且响应疑似 HTML 时给出「填了网页而非订阅源」的友好提示。
- **ID 生成**：订阅源 ID 取 URL 的 SHA-256 前 16 个十六进制字符；文章 ID 取
  `feed_id + entry 标识` 的哈希，保证跨次抓取稳定去重。
- **图片代理协议**：`rssimg://` 由 Rust 侧注册的异步 URI scheme 处理，与 IPC 无关，
  因此没有命令参数上下文——应用代理配置通过 `update_proxy_setting` 同步到全局状态供其读取。
- **安全默认**：capabilities 仅放行 `core:default`、窗口控制、`opener:default` 与 `dialog:default`；
  CSP 限制脚本与资源来源；正文渲染前移除 `script` / `iframe` / `form` / `base` / `meta refresh` 等节点。

## Tauri 命令（IPC）

Rust 侧通过 `#[tauri::command]` 暴露以下命令，前端经
`src/features/rss/services/rssService.ts` 中的类型化 `call<T>()` 调用：

| 命令 | 说明 |
|------|------|
| `load_state` | 从 `app_data_dir/state.json` 读取持久化状态（订阅源 / 文章 / 分组） |
| `save_state` | 将当前状态原子写回 `state.json` |
| `fetch_feed` | 抓取并解析订阅源，带 ETag / Last-Modified 条件请求 |
| `fetch_article_html` | 抓取文章原文 HTML（摘要过短时获取全文） |
| `backup_state` | 把当前状态导出为 JSON 到指定路径 |
| `restore_state` | 从指定 JSON 文件读取完整状态 |
| `read_file_text` | 读取文本文件（OPML 导入） |
| `write_file_text` | 写入文本到文件（OPML 导出） |
| `test_proxy` | 通过指定代理请求探测地址，返回往返耗时 |
| `update_proxy_setting` | 同步代理配置到 Rust 全局状态，供 `rssimg` 协议抓图使用 |

此外，`rssimg://` 为自定义 URI scheme 协议（非 IPC 命令），用于文章图片的本地代理加载。

## 配置

主要配置位于 `src-tauri/tauri.conf.json`：

| 键 | 值 | 说明 |
|----|----|------|
| `productName` | `RSSReader` | 打包产物名 |
| `identifier` | `com.rssreader.app` | 应用唯一标识（同时决定数据目录） |
| `app.windows` | 1100×750（最小 800×600） | 主窗口尺寸、可调、居中、无系统边框自定义标题栏 |
| `app.security.csp` | 严格 CSP | 限制脚本与资源来源，`img-src` 放行 `rssimg:` |
| `bundle.targets` | `all` | 打包当前平台全部目标 |

## 数据存储

Tauri 的 `app_data_dir` 由 `identifier` 决定，状态文件为其中的 `state.json`：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\com.rssreader.app\state.json` |
| macOS | `~/Library/Application Support/com.rssreader.app/state.json` |
| Linux | `~/.local/share/com.rssreader.app/state.json` |

状态文件带 `schema_version`，旧版本文件在读取时由 `migrate_state` 升级。

## 已知限制

- **正文提取**：仅在 RSS 摘要过短时抓取原文全文，采用容器选择器启发式 + 无关元素移除，
  不同站点效果可能不一致；未引入 Readability 级别的评分算法。
- **正文渲染**：为保留排版只做节点清理，不做完整的 HTML 白名单净化，仅适用于可信订阅源。
- **平台构建**：`bundle.targets = all` 只打包当前平台的目标格式，跨平台安装包需在各自系统上构建。
- **同步能力**：无云端同步，多设备之间需通过备份 / 还原或 OPML 手动迁移。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 授权，Copyright © 2026 z1HwanG。

在遵守许可证条款的前提下可自由使用、修改与分发：需保留版权与许可声明、标注修改过的文件，
并遵守其中的专利授权与免责声明条款。

## 第三方资源

- 界面图标使用 [Material Symbols Rounded](https://fonts.google.com/icons)（Apache-2.0），
  已按项目用到的图标子集化并本地化，不依赖 Google CDN。
