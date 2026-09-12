# 待办事项 / To-Do

本文件记录计划中的功能与改进，随进度更新。
This file tracks planned features and improvements, updated as work progresses.

状态 / Status：🔜 计划中（Planned）· 🚧 进行中（In progress）· ✅ 已完成（Done）

## 🔜 计划中 / Planned

### 1. 主题自定义 / Custom themes

- 在内置浅色 / 深色之外支持用户自定义主题。一套主题 = 覆盖 `--f2-*` 设计变量的表，
  未覆盖的部分继承内置值；主题文件放**用户数据目录**（`%APPDATA%\com.rssreader.app\themes\*.json`），
  不放安装目录 —— 那里会被升级覆盖、卸载删除。
  Beyond the built-in light / dark themes, let users define their own. A theme is a table overriding
  the `--f2-*` design tokens (anything unspecified inherits the built-in value), stored under the
  **app data directory** rather than the install directory, which upgrades overwrite and uninstall
  removes.
- 自定义主题需声明浅色 / 深色基底，否则「跟随系统」无法判断该用哪一套；`ThemePreference` 从
  `system | light | dark` 扩展为允许主题 id，读到未知值时回退 `system`。
  A custom theme must declare whether it is light- or dark-based so "follow system" can pick one;
  `ThemePreference` gains theme ids, falling back to `system` for unknown values.
- 现状：主题已经是 token 化的 CSS 变量（`styles.css` 的 `:root` 与 `[data-theme="dark"]`，
  共 78 个 `--f2-*` 定义），`applyTheme()` 把结果写进 `<html data-theme>` —— 因此这一步主要是
  「扫描用户目录 + 覆盖合并 + 选择 UI」，投入较小。
  Current state: theming is already token-based (`:root` and `[data-theme="dark"]` in `styles.css`,
  78 `--f2-*` definitions) and applied through a `data-theme` attribute, so this is mostly directory
  scanning, merge-on-override and a picker.
- 建议先做这一项：它顺带把「用户数据目录里的可扩展配置」这条通路建起来，第 2 项可以直接复用。
  Worth doing first: it establishes the extensible-config path in the app data directory, which item 2
  can reuse.

### 2. 界面多语言 / UI internationalization

- 界面文案目前全部硬编码中文（约 250 处字符串，分布在 30 余个文件），需要引入 `t()` 与语言包，
  并把文案逐组件迁移出去。
  All UI copy is currently hardcoded Chinese (~250 strings across 30+ files); this needs a `t()`
  helper plus locale files and a component-by-component migration.
- 建议顺序：先只做「框架 + 单一语言（zh-CN）全量键化」把通路跑通，再加第二种语言 —— 否则会同时踩
  「框架未验证」和「翻译不准」两个坑。
  Suggested order: ship the framework with a single locale (zh-CN) first to validate the path, then
  add a second language; doing both at once mixes framework bugs with translation errors.
- 语言包同样放用户数据目录（`locales/*.json`），内置语言随版本发布；缺 key 时回退内置语言。
  Locale files live in the app data directory as well, with built-in locales shipped in the release
  and missing keys falling back to the built-in language.
- 别漏区域相关的格式化：日期（现在硬编码 `toLocaleString("zh-CN")`）与排序（`localeCompare`）
  都要跟着界面语言走。
  Region-dependent formatting must follow the UI language too: dates (currently hardcoded
  `toLocaleString("zh-CN")`) and sorting (`localeCompare`).
- 与另外两套语言概念区分开：应用界面语言 ≠ 翻译功能的目标语言 ≠ 安装器语言
  （NSIS 已配置 SimpChinese / English，与应用内语言是两套，需分别维护）。
  Keep the three language concepts apart: UI language, translation target language, and installer
  language (NSIS is configured with SimpChinese / English and is maintained separately).

### 3. WebDAV 备份 / WebDAV backup

- 把订阅与阅读状态备份到 WebDAV 服务器，并支持从远端还原。
  Back up subscriptions and reading state to a WebDAV server and restore from it.
- 复用现有本地 JSON 备份 / 还原的状态结构（`state.json`），避免两套格式。
  Reuse the existing local JSON backup / restore state format (`state.json`) instead of maintaining
  two formats.

> 列表持续补充中。 / This list is still growing.

## ✅ 已完成 / Done

### 翻译功能 / Translation

- 多提供商网关（大模型三种协议 + 内置微软 / 谷歌 / DeepL / 腾讯翻译）、正文逐段对照翻译、
  划词翻译浮窗、流式输出、提供商级别可关闭思维链、翻译结果本地缓存。
  Multiple provider gateways (three LLM protocols plus built-in Microsoft / Google / DeepL / Tencent
  machine translation), paragraph-level bilingual rendering, selection translation, streaming output,
  a per-provider switch to disable thinking, and a local translation cache.
