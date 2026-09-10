# 更新日志 / Changelog

本文件记录本项目的所有重要变更。
All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows
[Semantic Versioning](https://semver.org/).

## [0.3.2] - 2026-09-10

### 修复 / Fixed

- 「未读 / 收藏」视图下搜索框输入被静默忽略：筛选与搜索此前写成二选一（先命中筛选就 return），
  现在两者是并列条件，任一不满足才过滤。
  Search input was silently ignored in the "unread" / "starred" views: the filter and the search used
  to short-circuit each other; they are now independent conditions.
- 修改订阅源 URL 后该源文章重复、且丢失已读 / 收藏：文章 ID 由 `feed_id + entry 标识` 哈希而来，
  feed_id 变了 ID 却没变，下次刷新会把同一篇文章再插一遍并误报「无更新」。现在会按新 feed_id
  重算文章 ID（`state.json` 新增 `entry_key` 字段用于回溯原始标识，`schema_version` 升至 2），
  清掉旧 URL 的 ETag / Last-Modified，去重改为按稳定标识（entry_key → 链接 → 标题）匹配。
  Duplicated articles and lost read / starred state after editing a feed URL: article IDs hash
  `feed_id + entry id`, so a new feed id left the old IDs in place and the next refresh re-inserted
  every article while reporting "no update". Articles are now re-keyed against the new feed_id
  (`entry_key` added to `state.json`, `schema_version` bumped to 2), the stale ETag / Last-Modified
  are cleared, and deduplication matches on a stable key (entry_key → link → title).
- 冷启动深链可能与状态载入竞争：载入完成前 `state` 还是空的，已订阅的源会被误判为未订阅并弹出
  添加对话框。现在载入完成前先暂存地址，载入后重放。
  Cold-start deep links raced the state load: with an empty `state` an already-subscribed feed was
  mistaken for a new one. The URL is now buffered until the load finishes and replayed afterwards.
- 原子写盘的临时文件名会与其他备份文件冲突：`with_extension("tmp")` 会把扩展名整个替换掉，
  使 `backup.json` 与 `backup.opml` 落到同一个 `backup.tmp`；改为在完整文件名后追加 `.tmp`。
  The atomic-write temp file could collide with other backups: `with_extension("tmp")` replaced the
  extension, so `backup.json` and `backup.opml` both landed on `backup.tmp`. The temp name is now the
  full file name plus `.tmp`.
- 图片协议加载失败后的直连回退只对 `https` 生效，`http` 图片被直接隐藏；现在 `http` 也会回退。
  The direct fallback after a failed `rssimg` load only worked for `https` images; `http` images are
  now retried as well.
- 直连兜底客户端的超时（10 s）与代理链路（20 s）不一致，改为共用同一常量。
  The direct-fallback HTTP client used a 10 s timeout while the proxied client used 20 s; both now
  share one constant.
- 应用内「支持格式」提示漏了 RSS 1.0（与 README、CHANGELOG 的表述不一致）。
  The in-app supported-format hint omitted RSS 1.0, contradicting the README and CHANGELOG.

### 变更 / Changed

- 「添加订阅源」重复提交已订阅的 URL 时不再写入重复订阅源，改为更新该源。
  Adding an already-subscribed URL no longer creates a duplicate feed; it updates the existing one.

### 文档 / Documentation

- 校正与代码不一致的文档：capabilities 漏列 `updater:default` / `process:default`、技术栈漏列
  updater / process 插件、项目结构漏列 `deep_link.rs` / `updateService.ts` / `vite.config.ts`、
  下载表中的 MSI 与免安装单文件版本号停留在 0.1.1、发布示例里 `latest.json` 的版本号是 0.2.0
  （安装包名却是 0.3.1），以及博文里的 `0.2.1` 与「rename 失败后小睡重试」的描述。
  Fixed documentation that disagreed with the code: the capability list omitted
  `updater:default` / `process:default`, the tech-stack table omitted the updater / process plugins,
  the project structure omitted `deep_link.rs` / `updateService.ts` / `vite.config.ts`, the download
  table still listed 0.1.1 for the MSI and portable builds, the release example used 0.2.0 for
  `latest.json` while the installer names said 0.3.1, and the blog post still said 0.2.1 and
  described a sleep-and-retry that the atomic write does not perform.
- 明确文件访问的实际边界（前端无 `fs:` / `shell:` 权限，文件访问仅经四个窄命令且路径来自用户选择）、
  图片重试阶梯第 3 步仅在启用代理时生效、以及免安装单文件不在默认构建产物中。
  Clarified the real file-access boundary (no `fs:` / `shell:` permission; four narrow commands taking
  user-picked paths), that retry-ladder step 3 only runs with a proxy configured, and that the
  portable build is not part of the default bundle output.

## [0.3.1] - 2026-09-09

### 变更 / Changed

- 优化「添加订阅源」对话框：标题加图标与支持格式说明、地址输入框撑满对话框宽度、
  输入为空时禁用「添加」、修改输入即清除报错、支持 Esc 关闭，并补充无障碍属性。
  Improved the "add feed" dialog: icon and supported-format hint in the header, a full-width URL
  field, disabled submit while empty, clearing the error as you type, Esc to close, and
  accessibility attributes.

## [0.3.0] - 2026-09-09

### 新增 / Added

- 深链订阅：注册 `feed://` 与 `rssreader://` 协议处理器，从浏览器（如 RSSHub Radar 的「本地阅读器」）
  点击链接即可打开应用并预填订阅地址；已订阅的源直接定位。冷启动与运行中都已覆盖（单实例转发）。
  Deep-link subscription: registers the `feed://` and `rssreader://` protocol handlers, so clicking a
  link in the browser (for example RSSHub Radar's "Local reader") opens the app with the feed URL
  prefilled, or jumps to the feed if already subscribed. Both cold start and running instances are
  handled (forwarded by the single-instance plugin).

## [0.2.1] - 2026-09-09

### 新增 / Added

- 设置 → 关于 增加问题反馈入口（GitHub 与 Forgejo 的 Issues）。
  Added issue-tracker links (GitHub and Forgejo) to Settings → About.

### 变更 / Changed

- 「检查更新」按钮移到版本号旁边，更新卡片仅在发现新版本或下载中时显示。
  Moved the "check for updates" button next to the version number; the update card now only shows
  when an update is available or a download is running.
- README 的下载入口同时列出 GitHub 与 Forgejo Releases（此前只指向 GitHub）。
  The README download section now lists both GitHub and Forgejo Releases instead of GitHub only.

## [0.2.0] - 2026-09-09

### 新增 / Added

- 应用内自动更新：启动后延迟静默检查并在消息中心提示，设置 → 关于可手动检查、下载并安装；
  Windows 走 NSIS 安装器的 passive 模式，安装完成后自动重启。
  In-app auto-update: a delayed silent check at startup with a message-centre notice, plus manual
  check / download / install in Settings → About; on Windows it uses the NSIS installer in passive
  mode and restarts the app afterwards.
- 更新包使用 minisign 签名，公钥内置于应用；更新清单优先取 GitHub Releases，失败时回退 Forgejo
  Releases，应用内代理设置会一并用于更新请求。
  Update packages are minisign-signed with the public key embedded in the app; the manifest is
  fetched from GitHub Releases first and falls back to Forgejo Releases, and the in-app proxy setting
  is used for update requests.

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

### 发布 / Release

- 发布 Windows x64 安装包（NSIS `RSSReader_0.1.1_x64-setup.exe`、MSI `RSSReader_0.1.1_x64_en-US.msi`）
  与免安装单文件 `RSSReader_0.1.1_x64_portable.exe`。
  Published Windows x64 installers (NSIS `RSSReader_0.1.1_x64-setup.exe`, MSI
  `RSSReader_0.1.1_x64_en-US.msi`) and a portable single file `RSSReader_0.1.1_x64_portable.exe`.

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

[未发布] / Unreleased: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/z1HwanG/RSS-Reader/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/z1HwanG/RSS-Reader/releases/tag/v0.1.0
