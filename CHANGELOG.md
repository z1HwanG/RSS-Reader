# 更新日志 / Changelog

本文件记录本项目的所有重要变更。
All notable changes to this project are documented in this file.

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows
[Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-09-11

### 新增 / Added

- **正文按内容种类渲染**：抓取时记录正文的 `content_type`，不再假定「正文一定是 HTML」。
  纯文本按空行分段（此前换行全丢）、Markdown 渲染标题 / 列表 / 引用 / 代码块 / 表格、
  `data:` URI 内联图片直接显示、Atom 的 `content src` 外链正文给出打开入口。
  Article bodies are rendered by their actual content kind (plain text / Markdown / inline image /
  external body), instead of always being injected as HTML.
- **附件按种类抓取与展示**：RSS `enclosure`、MediaRSS、JSON Feed `attachments`、Atom 媒体链接与
  正文里的视频嵌入（Bilibili / YouTube 等）统一收成附件列表；图片是缩略图网格（可点击放大），
  音频 / 视频用原生播放器直接内嵌播放，文档给打开入口。CSP 相应放行 `media-src` 与 `frame-src`。
  Attachments (enclosure / MediaRSS / JSON Feed / Atom media / embedded players) are collected and
  shown per kind — image grid, inline audio & video players, document cards.
- **文章元信息**：新增作者、标签、摘要、缩略图；阅读视图顶部显示作者 / 时间 / 预计阅读时长 /
  附件数，标签以胶囊列出，正文无图时用缩略图作首图，列表显示作者与附件图标，搜索范围随之扩大。
  Authors, tags, summaries and thumbnails are extracted and surfaced in the reading view.
- **安装包支持选择快捷方式**：新增安装页「快捷方式选项」，可分别选择是否创建桌面与开始菜单
  快捷方式（默认都创建）；静默 / 被动安装跳过此页、按默认处理。安装界面提供简体中文 / English。
  The NSIS installer gained a shortcut-options page (desktop / Start menu); silent installs skip it.
- **自动更新不再留下旧版本目录**：updater 出于安装需要会保留解压出的临时目录（每个约 3 MB），
  现在应用启动时清理它们，只保留版本号最新的一个。
  Stale updater temp directories are purged at startup, keeping the newest one.

### 变更 / Changed

- **刷新一律全量抓取**：「刷新」与「刷新所有订阅源」走同一条路径，每次都重新下载并解析整份订阅源，
  不再发送条件请求、也没有「304 → 无更新」分支；随之下线水位线与条件请求那套机制
  （`Feed` 的 `etag` / `last_modified` / `peak_article_count`，`state.json` 的 `schema_version` 升到 4）。
  代价是每次刷新都要完整下载，订阅源条目多时更慢。
  Every refresh is now a full fetch; the conditional-request / watermark machinery was removed.
- **「清理缓存」不再删除文章**：改为只清内存中的解析缓存（原文全文提取结果、列表预览、搜索索引）
  与 WebView 磁盘缓存（文章图片缓存，实测可达数百 MB），文章与订阅源数据不受影响。
  The cache button no longer deletes articles — it clears in-memory parse caches and the WebView
  disk cache (cached article images).
- **标题栏窗口按钮与工具栏图标统一形态**：最小化 / 最大化 / 关闭改为 36px 方形 + 4px 圆角 +
  20px 图标，与工具栏图标按钮同尺寸同状态；「最大化」改用方框字形而非四角括号。
  Window buttons now share the toolbar icon-button geometry.
- **去重合并保留更长正文**：旧记录可能只有摘要，重新抓到的全文不再被摘要覆盖；新增字段合并时
  取有值的一份。
  Dedupe merging keeps the longer body and fills gaps in the new fields.

### 修复 / Fixed

- **「获取全文」大面积失效**：提取器从固定选择器改为带评分的容器识别（文字量 × (1 − 链接密度)
  + 段落与配图，剥离评论区与站点外壳），在少数派 / 阮一峰周刊 / 云风 / Solidot 等真实页面上
  都能落在正文范围内。
  The full-text extractor was rewritten to pick the article container by scoring instead of fixed
  selectors, and strips comment areas and site chrome.
- **抓不到正文时说明具体原因**：区分「站点返回安全检测 / 人机验证页」「正文靠 JavaScript 渲染」
  「提取结果确实不比订阅源已给的多」，而不是统一报「提取器不兼容」。
  Extraction failures now report the actual reason (challenge page / JS-rendered / nothing longer).
- **正文里的视频嵌入被删掉**：`iframe` 不再当作噪声，认得的平台播放器抽成附件并就地渲染为
  16:9 播放器（`sandbox` 限制权限），订阅源完全没给正文时自动抓一次原文。
  Embedded video players are no longer stripped as noise; they render inline and empty feeds
  auto-fetch once.
- **右键菜单贴窗口底部被切掉**：菜单改为挂载后按真实尺寸夹进视口（此前订阅源菜单完全没收边，
  文章菜单用的是写死的估算尺寸）。
  Right-click menus are clamped into the viewport using their measured size.

## [0.3.4] - 2026-09-10

### 修复 / Fixed

- 同一篇文章在列表里出现两条（例如左侧列表连着两条一模一样的「21岁出门远行」）：
  去重此前只按文章 `id` 比对，而 id 是 `hash(feed_id + 条目标识)`，订阅源改过一次
  条目标识（或中途换过订阅地址）之后，同一篇文章会以**两个不同 id** 落库；v0.3.2 之前
  写入的记录又没有 `entry_key`，抓取侧的去重（按 entry_key → 链接 → 标题建已知集合）
  与它比对时两边都对不上，于是磁盘上一直留着两条。
  现在去重认「身份线索」而不是单个字段：一篇文章登记它的 `entry_key` / 链接 /
  标题+发布时间，任一线索与他人相同即合并为一条（并查集归组），最后再按 `id` 兜一次
  （收拾链接被改过、线索全对不上的残留）。合并保留先出现那条的位置与字段、只从同组记录
  补空缺，已读 / 收藏取并集，不会丢用户数据（`src/lib/articleDedupe.ts`）。
  同时把刷新（单源 / 全部）与添加订阅源的追加路径统一走 `appendArticles`，
  避免「载入时清干净、刷新又插一条」的来回反复。
  A single article could show up twice in the list (e.g. two identical
  "21岁出门远行" rows). Dedup only compared the article `id`, but that id is
  `hash(feed_id + entry identity)`, so a feed that ever changed its entry
  identity (or was re-subscribed under a new URL) left the same article stored
  under **two different ids** — and records written before v0.3.2 carry no
  `entry_key`, so the fetch-side dedup (entry_key → link → title) matched
  neither side and both rows stayed on disk.
  Dedup now works on identity **clues** instead of a single field: an article
  registers its `entry_key`, link and title+published-at, and any shared clue
  merges the records into one (union-find grouping), with a final `id` pass
  that catches leftovers whose link was rewritten. Merging keeps the earlier
  record's position and fields, only filling gaps from its group, and unions
  read / starred so user data survives (`src/lib/articleDedupe.ts`).
  The append paths (single-feed refresh, refresh all, add feed) now all go
  through `appendArticles`, so a refresh can no longer re-insert what the
  load-time cleanup just removed.
- **清理缓存后刷新取不回文章**：本地文章被清掉，订阅源的 ETag / Last-Modified 却还留着，
  下次刷新带 `If-None-Match` / `If-Modified-Since` 拿到 304「无更新」，直接跳过下载——
  列表就一直是空的，看起来就是「删了再也回不来」。现在按**取回只走单源「刷新」**的约定处理：
  ① 每个订阅源新增水位线 `peak_article_count`（本地篇数的历史最高值，抓取后自动抬高）。
  **单源「刷新」**（抽屉里右键订阅源 → 刷新）发现本地篇数低于水位线——即这个源被清理过——
  就忽略条件请求头完整重抓一次，把被清掉的文章补回来；服务端固执回 304 时按「无更新」处理，
  绝不清空已有数据。
  ② 标题栏「刷新所有订阅源」**保持增量更新**：304 就跳过，不为取回被清理的文章做全量重抓
  （多源全量下载明显更慢，也会把刚清理掉的旧文章整批拉回列表）。
  ③ 清理缓存**不动** ETag / Last-Modified（否则标题栏刷新会变成全量下载、把清掉的旧文章拉回来），
  只把受影响源的水位线抬到清理前的篇数，留下「被清理过」的痕迹。
  判定与水位线维护抽成纯函数 `src/lib/feedConditional.ts`，抓取入口 `fetchOneFeed`（`src/App.tsx`）；
  `Feed` 新增 `peak_article_count`（Rust 侧 `#[serde(default)]`，旧数据缺该字段时为 0，行为不变）。
  **Clearing the cache made refresh unable to bring articles back**: the local
  articles were deleted while the feed's ETag / Last-Modified stayed behind, so the
  next refresh sent `If-None-Match` / `If-Modified-Since`, got a 304 "not modified",
  and skipped the download entirely — the list stayed empty as if deleted articles
  could never return. Recovery is now limited to the **single-feed refresh**:
  ① every feed carries a watermark `peak_article_count` (highest local article count
  ever seen; raised after each fetch). The single-feed refresh (right-click a feed in
  the drawer → 刷新) notices that the local count fell below the watermark — meaning
  this feed was cleaned — and re-downloads in full, ignoring the conditional headers.
  If the server still insists on 304, it is treated as "no update" and existing data is
  never wiped.
  ② the title-bar **"refresh all" stays incremental**: a 304 is skipped and no full
  re-download is triggered to recover cleaned articles (downloading every feed in full
  is much slower and keeps pulling cleaned articles back into the list).
  ③ clearing the cache **does not touch** ETag / Last-Modified (otherwise the title-bar
  refresh would become a full download and pull cleaned articles back); it only raises
  the affected feeds' watermarks to their pre-cleanup counts, leaving the trace.
  The predicate and watermark maintenance live in the pure helper
  `src/lib/feedConditional.ts`, with `fetchOneFeed` as the fetch entry point
  (`src/App.tsx`). `Feed` gained `peak_article_count` (Rust side `#[serde(default)]`,
  so old data reads as 0 and behaves as before).

## [0.3.3] - 2026-09-10

### 新增 / Added

- 设置 →「订阅源 → 全部订阅源」新增**按名称搜索**：与排序方式叠加（搜索结果仍按当前排序/分组
  顺序排列），无匹配时给出提示，带一键清空；搜索状态下的「全选」只作用于当前可见项。
  过滤规则抽成纯函数 `filterFeedsByName`（`src/lib/feedOrder.ts`），同时匹配显示名与订阅地址。
  Settings → Feeds → "All feeds" gained a **search by name** box: it composes with the active sort
  mode (results keep the current order/grouping), shows a hint when nothing matches, has a one-click
  clear, and "select all" only applies to the currently visible rows while searching. The rule lives
  in the pure helper `filterFeedsByName` (`src/lib/feedOrder.ts`) and matches both the display name
  and the feed URL.
- 设置 →「分组与排序」支持一步到位的排序，不再只能逐格挪动：
  - 每行新增**置顶 / 置底**按钮（组内一步到底）；
  - 按住行首手柄可**拖拽**：拖到另一行上方即插到它之前，拖到分组末尾的空白即放到该组最后，
    跨分组拖拽会自动改归属并落位。
  重排规则抽成纯函数 `reorderFeedsInGroup`（`src/lib/feedOrder.ts`），`sort_order` 仍是组内序号，
  每次移动只重排同组并重新编号。
  Settings → "Groups & order" can now reorder in one step instead of nudging row by row:
  - new **move to top / move to bottom** buttons per row;
  - holding the row's drag handle and **dragging** works too: drop onto a row to insert before it, drop
    into the gap at a group's end to move it last in that group, and dragging across groups reassigns
    the feed and places it in one go.
  The rule lives in the pure helper `reorderFeedsInGroup` (`src/lib/feedOrder.ts`); `sort_order` remains
  a per-group index, so each move reorders only that group and renumbers it 0..n-1.
- 图标字体子集补充 `vertical_align_top` / `vertical_align_bottom` / `drag_indicator`
  （`node scripts/subset-icons.mjs`，51 个图标、连字校验全部通过）。
  Added `vertical_align_top` / `vertical_align_bottom` / `drag_indicator` to the icon-font subset
  (`node scripts/subset-icons.mjs`; 51 icons, all ligatures verified).

### 变更 / Changed

- 设置 →「分组与排序」的移动按钮收敛为**置顶 / 置底**，逐格挪动交给拖拽：原来每行还有上移 / 下移
  两个按钮，与拖动排序重复且更容易误点。现在按钮负责「一步到底」，拖拽负责落到任意位置。
  Settings → "Groups & order" now keeps only **move to top / move to bottom** buttons; nudging a row
  one step at a time is left to dragging. The per-row move-up / move-down buttons were redundant with
  drag reordering and easy to mis-click, so the buttons handle "one step to either end" and dragging
  handles landing anywhere.
- 重排「全部订阅源」列表头部：原先标题与搜索/排序/选框挤在一行，窗口稍窄时标题会被压成竖排。
  现在头部可换行——搜索框可压缩，选中项工具栏在空间不足时自动折到第二行。
  Reflowed the "All feeds" header: the title used to be squeezed into a vertical column when the
  search / sort / selection controls crowded the same row. The header now wraps — the search box can
  shrink, and the selection toolbar moves to a second row when space runs out.
- 设置 →「订阅源 → 全部订阅源」列表头部新增排序方式切换：**按添加时间**与**按分组**
  （分组先后 + 组内顺序，未分组排最后）。「按添加时间」按钮自带方向：默认**最新添加在前**，
  再点同一个按钮切换为**最早添加在前**（按钮内箭头随方向变化），方式与方向都记在 `localStorage`。
  排序规则抽成纯函数 `src/lib/feedOrder.ts`；它只影响设置面板的展示顺序，不改动订阅源本身，
  也不在此列表里提供上下移按钮（手动排序仍在「分组与排序」页签）。
  Settings → Feeds → "All feeds" now has a sort selector: **by date added** and **by group** (group
  order, then the order inside each group; ungrouped feeds last). The "by date added" button carries
  its own direction: newest first by default, and clicking the same button again flips it to oldest
  first (the arrow inside the button follows the direction). Both the mode and the direction are kept
  in `localStorage`. The rules live in the pure helper `src/lib/feedOrder.ts`; they only affect how
  the settings list is displayed — the feeds are not modified, and this list carries no move-up /
  move-down buttons (manual ordering still lives in the "Groups & order" tab).

### 修复 / Fixed

- 设置 →「分组与排序」里点**置顶 / 置底**（以及当时的置顶 / 置底 / 上移 / 下移）界面顺序不变：
  该页签渲染的是「订阅源」页签的排序结果，而它默认「按添加时间」——时间戳相同时才退回
  `sort_order`，于是按钮改了组内序号，界面仍按时间戳排。现在排序页签固定按「分组 + 组内
  `sort_order`」渲染（新增纯函数 `sortFeedsByGroupOrder`），「按添加时间」只作用于「订阅源」页签。
  In Settings → "Groups & order", clicking **move to top / move to bottom** (and the move up / down
  buttons that existed then) left the list unchanged: the tab rendered the result of the "Feeds" tab's
  sort mode, which defaults to **by date added** and only falls back to `sort_order` when timestamps
  tie — so the buttons rewrote the per-group index while the view kept sorting by timestamp. The
  ordering tab now always renders by group + per-group `sort_order` (new pure helper
  `sortFeedsByGroupOrder`), and "by date added" only affects the "Feeds" tab.
- 拖到分组末尾（最后一行下方的空白）不放行：落点提交复用了 `position: "top"`，而纯函数把
  「`beforeId` 为 null + top」解释成「移到首位」，该项已在首位时判定原地不动。现在按落点语义
  传档位——有落点行插到它之前，没有落点行则置底。
  Dropping into the gap below a group's last row did nothing: the drop handler reused
  `position: "top"`, and the pure helper reads "`beforeId` is null + top" as **move to first** — a
  no-op when the item is already first. The handler now passes a position that matches the drop
  target: insert before the row under the pointer, or move to the end when there is none.
- **拖动排序完全不可用（整片区域显示「禁止」光标，拖不动）**，三个原因叠加：
  - Tauri 窗口默认 `dragDropEnabled: true`，Windows 上 WebView2 会接管拖放，HTML5 拖拽事件根本
    到不了页面 —— 这正是禁止光标的来源。现已在窗口配置里关闭原生拖放（应用不使用系统级文件拖放）；
  - `setPointerCapture` 在指针非激活时抛 `NotFoundError`，把整个 `pointerdown` 处理器从中间打断，
    拖拽状态建不起来。现在捕获失败只降级（拖出窗口外会断线），不再中断处理；
  - 监听器的 effect 依赖里带着 `feeds`，每次重排都重建监听 —— 落点提交那一刻正好把正在处理的
    事件链一起拆掉。现在只依赖页签，订阅源数据经 ref 读取，行顺序由 key 驱动。
  拖拽因此改为**双通道**且互斥：原生 HTML5 拖拽可用时走 dragstart/dragover/drop（`draggable`
  只在手柄按下时置位，避免常驻 draggable 带来的禁止光标），原生被接管时改用指针自绘拖拽
  （手柄按下 + 4px 阈值起步，落点画插入线、目标分组高亮，支持拖到分组末尾、跨分组、上下边缘
  自动滚动、按 Esc 放弃）。两条通道都在真实浏览器里跑过端到端验证；监听仍走 `addEventListener`，
  与 React 的异步渲染时序解耦，`dragover` 一律同步 `preventDefault`。
  **Dragging to reorder did not work at all** (the whole area showed the forbidden cursor), from three
  compounding causes:
  - Tauri windows default to `dragDropEnabled: true`, so on Windows WebView2 takes over drag & drop and
    HTML5 drag events never reach the page — the source of the forbidden cursor. Native drag & drop is
    now disabled in the window config (the app does not use system-level file drops);
  - `setPointerCapture` throws `NotFoundError` when the pointer is not active, which aborted the whole
    `pointerdown` handler mid-way so the drag state was never established. A failed capture now only
    degrades (dragging outside the window loses the pointer), it no longer aborts the handler;
  - the listener effect depended on `feeds`, so every reorder re-registered the listeners — and the
    moment a drop was committed it tore down the very event chain handling it. It now depends only on
    the active tab, reads feed data through a ref, and lets row keys drive reordering.
  Dragging is therefore **dual-channel** and mutually exclusive: native HTML5 drag & drop when the
  platform allows it (`draggable` is set only while the handle is held down, avoiding the forbidden
  cursor a permanently draggable row produces), and a pointer-driven fallback when native drag & drop
  is intercepted (press the handle, 4 px threshold, insertion line plus target-group highlight, drop
  at a group's end, cross-group moves, auto-scroll at the edges, Esc to cancel). Both channels were
  verified end to end in a real browser.
- 设置面板里的订阅源列表不再用 `useMemo` 缓存排序结果（只有几十个订阅源，排序开销可忽略），
  避免任何缓存使用户看到旧的顺序。
  The settings panel no longer memoizes the sorted feed list (a few dozen feeds sort instantly), so a
  stale cache can never show an outdated order.

- 图标字体子集缺少 `arrow_downward` / `arrow_upward`，排序按钮里会漏出图标文字。
  已运行 `node scripts/subset-icons.mjs` 重新生成子集（47 个图标，连字校验全部通过）。
  The icon-font subset was missing `arrow_downward` / `arrow_upward`, so the sort button showed the
  raw ligature text. The subset was regenerated with `node scripts/subset-icons.mjs` (47 icons, all
  ligatures verified).

- `npm run tauri dev` 会整个崩掉、窗口页面冻在崩溃前的内容上（看起来像「改了代码却没生效」）：
  编辑器 / 工具保存文件时是「先写临时文件再改名」（如 `src/.App.tsx.<pid>.<uuid>.tmpdir/App.tsx.tmp`），
  chokidar 可能刚好在临时文件被删除的瞬间去 watch 它，Windows 抛 `EBUSY: resource busy or locked`；
  chokidar 的 `isFatalError` 只把 EACCES / EPERM 当致命错误，EBUSY 不是，但无人处理 `error` 事件时
  Node 会把它抛到进程顶层，vite 直接退出，`tauri dev` 随之报 `beforeDevCommand terminated`。
  现在 `vite.config.ts` 里加了 `fileWatchGuard` 插件：只把**资源占用类且带临时文件特征**的监听错误
  降级为警告（`EBUSY` / `ENOENT` / `ENOTDIR` + `.tmpdir` / `.tmp`），其余监听错误照旧抛出、照旧退出，
  不会把真问题一起吞掉。
  `npm run tauri dev` used to die outright and leave the window frozen on the pre-crash page (which
  looks like "I changed the code but nothing happened"): editors and tools save by writing a temp
  file and renaming it (e.g. `src/.App.tsx.<pid>.<uuid>.tmpdir/App.tsx.tmp`), chokidar can try to
  watch it in the instant it is deleted, and Windows raises `EBUSY: resource busy or locked`.
  chokidar's `isFatalError` only treats EACCES / EPERM as fatal, so EBUSY is not — but with no
  `error` listener attached, Node throws it to the top level, vite exits, and `tauri dev` reports
  "beforeDevCommand terminated". `vite.config.ts` now carries a `fileWatchGuard` plugin that
  downgrades only resource-contention watch errors that mention a temp file (`EBUSY` / `ENOENT` /
  `ENOTDIR` + `.tmpdir` / `.tmp`) to a warning; every other watch error is still thrown and still
  exits, so real problems are not swallowed.

- 抽屉里的「收藏」不再与顶栏筛选里的「仅星标文章」绑定：此前抽屉「收藏」会直接改写持久化的
  `viewFilter` 偏好，顶栏再切「全部 / 未读」又会反过来清掉收藏视图。现在「收藏」是独立的
  会话视图（`src/lib/articleFilter.ts`）：进入收藏视图不改动筛选偏好，退出后回到原来的
  「全部 / 未读 / 仅星标」；收藏视图内只看星标文章，不受「未读」等筛选影响（否则已读的
  收藏文章会被滤掉，收藏就不完整了）。选中具体订阅源或点「全部文章」会退出该视图。
  The drawer's "Starred" entry no longer shares state with the top bar's "starred only" filter:
  it used to overwrite the persisted `viewFilter` preference, and switching the top bar back to
  "all / unread" would in turn clear the starred view. "Starred" is now an independent
  session-scoped view (`src/lib/articleFilter.ts`): opening it leaves the filter preference
  untouched, closing it returns to the previous all / unread / starred-only filter, and inside the
  starred view only starred articles are shown regardless of that filter (otherwise read-and-starred
  articles would be filtered out and the view would be incomplete). Selecting a feed or "all
  articles" leaves the starred view.
- 实现细节：`handleSelectFeed(null)` 内部原先无条件重置收藏视图，而抽屉「收藏」本身也要把订阅源
  清空，于是同一次点击里「进入收藏」会被该重置覆盖，表现为点了收藏没反应。现在只在传入具体
  `feedId` 时退出收藏视图。
  Detail: `handleSelectFeed(null)` used to reset the starred view unconditionally, but the drawer's
  own "Starred" entry also clears the feed selection, so entering the starred view and that reset
  landed in the same batch and cancelled each other out (clicking "Starred" appeared to do nothing).
  The starred view now exits only when a concrete `feedId` is passed.

- 选中订阅源后列表仍混着其他源的文章：旧版写入的文章没有 `entry_key` 字段，
  抓取侧去重按「entry_key → 链接 → 标题」建已知集合，这些老行匹配不上，于是同一篇文章以
  **同一个 id** 留下两条记录（实测 433 组、其中 188 组已读状态还不一致）。React 的列表 key
  撞车后，协调过程不会清理上一次渲染的 DOM 节点，列表里就会残留别的源的文章。
  现在载入 / 还原状态时按 id 合并重复记录（`src/lib/articleDedupe.ts`，已读取并集、
  `entry_key` 取有值的那份）并回写磁盘自愈；列表 key 追加下标作为兜底。
  Selecting a feed left articles from other feeds mixed into the list: articles written by older
  versions carry no `entry_key`, and fetch-side dedup builds its known-key set from
  `entry_key → link → title`, so those legacy rows never matched and the same entry ended up stored
  twice under the **same id** (433 groups measured, 188 of them disagreeing on read state). React
  then logged "Encountered two children with the same key" and, on a key collision, reconciliation
  leaves the previous render's DOM nodes behind — hence the foreign articles. State load / restore
  now merges duplicate ids (`src/lib/articleDedupe.ts`: read and starred are unioned, `entry_key`
  prefers the non-null one) and writes the healed state back; list keys also carry the index as a
  fallback.
- 切换文章后右侧阅读区仍停在上一篇的滚动位置：滚动容器（`.app-reader`）在 React 里是复用同一个
  DOM 节点的，浏览器会原样保留 `scrollTop`。切换订阅源 / 筛选 / 排序 / 搜索时文章列表
  （`.article-items`）同理。现在两处都在内容集合变化时回到顶部（`src/lib/scrollReset.ts`，
  用 `useLayoutEffect` 在绘制前归零，避免闪一帧旧位置）。
  After switching articles the reading pane kept the previous article's scroll position, and the
  article list kept its offset when the feed / filter / sort / search changed — both are the same
  recycled scroll container, so the browser preserved `scrollTop`. Both now scroll back to the top
  when the content set changes (`src/lib/scrollReset.ts`, using `useLayoutEffect` so the reset lands
  before paint).

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

[未发布] / Unreleased: https://github.com/z1HwanG/RSS-Reader/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/z1HwanG/RSS-Reader/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/z1HwanG/RSS-Reader/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/z1HwanG/RSS-Reader/releases/tag/v0.1.0
