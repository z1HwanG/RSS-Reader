<div align="center">

# RSS Reader

**A lightweight, cross-platform desktop RSS reader**

Built with **Tauri 2** + **React 18** + **TypeScript**. Feed fetching and parsing run entirely in
Rust; the frontend only renders and handles interaction — fast and safe by design.

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[中文](README_zh.md) | [English](README_en.md)

</div>

---

## Overview

RSS Reader is a desktop feed reader for people with many subscriptions who want their data kept
locally instead of in a cloud service. Subscriptions and reading state live on your machine and
never touch a third-party server; network requests only happen when fetching feeds and article
images.

The UI follows the Fluent 2 visual language with a frameless custom title bar, and supports light,
dark, and system themes.

## Features

### Feed management

- Add / edit / delete RSS 2.0, RSS 1.0, Atom and JSON Feed subscriptions
- Groups: create, rename and delete groups, move feeds between them; the sidebar lists collapsible
  group sections with unread counts
- OPML batch import / export (newly imported feeds are refreshed in the background)
- Per-feed reading mode: in-app reader or open in the external browser
- Conditional requests (`ETag` / `Last-Modified`): a 304 response skips download and parsing
- Refresh all feeds at once with a concurrency cap of 6; auto-refresh intervals of 10 / 15 / 20 /
  30 / 45 minutes or 1 hour

### Reading experience

- Two-column layout: article list on the left, reading view on the right; the splitter is draggable
  and its width is persisted
- Filter by all / unread / starred, sort by newest / oldest / feed, and switch between compact,
  list and card views
- Full-text search over titles and article bodies (bodies indexed as plain text, capped at 4096
  characters per article to bound memory)
- One-click full-text fetch when a feed summary is too short: heuristic container selection plus
  removal of ads, comments and sidebars, with the 20 most recent articles cached
- Starring, read / unread state, mark all as read, and a per-feed context menu to mark read or
  refresh
- Batched list rendering: 300 articles initially, more loaded on scroll
- Open the original article in the system browser, or copy its link

### Images and networking

- Article images load through the local `rssimg://` protocol: Rust fetches them with a browser
  User-Agent, bypassing hotlink `Referer` checks and mixed-content blocking of `http` images;
  successful responses are cached for 7 days
- Image fetching uses a retry ladder (direct first, add `Referer` on 403 and remember that host,
  then fall back to a direct request); GitHub Pages images additionally fall back to the
  `cdn.jsdelivr.net` mirror
- 50 MB per-image limit, only `http` / `https` images allowed
- HTTP / SOCKS5 proxy with host and port validation plus a one-click connectivity test (multiple
  probe targets to avoid single-site false negatives)
- SOCKS5 uses `socks5h`, so names are resolved by the proxy and local DNS poisoning is avoided

### Appearance and preferences

- System / light / dark theme, adjustable reading font size, applied immediately
- Frameless custom title bar (drag, minimize, maximize, close)
- Theme, font size, refresh interval, proxy, filters and view mode are stored in `localStorage`

### Data and security

- Feeds and articles are persisted on the Rust side (`app_data_dir/state.json`) with atomic writes
  (temp file + rename), so a crash mid-write cannot corrupt the file
- High-frequency operations (mark read / star / reorder) are debounced into a single 800 ms write;
  pending changes are flushed when the window is hidden or closed
- Whole-state JSON backup / restore, plus cleanup of cached articles by age (starred articles are
  kept)
- URL schemes are validated before fetching (only `http` / `https`); capabilities follow least
  privilege
- External links always go through the opener plugin; the frontend has no raw file or shell access
- A global link guard intercepts every `<a>` click inside the WebView and opens it in the system
  browser instead, so the app UI can never be replaced by a foreign page

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 18 + TypeScript (strict) + Vite 5 |
| Styling | Plain CSS with Fluent 2 design language (light / dark theme variables) |
| Icons | Material Symbols Rounded (locally subset, ~36 KB) |
| Feed parsing | feed-rs 2 (RSS 2.0/1.0, Atom, JSON Feed) |
| HTTP | reqwest 0.12 (rustls TLS, http2, gzip / brotli / deflate, system-proxy, socks) |
| Tauri plugins | @tauri-apps/plugin-opener, @tauri-apps/plugin-dialog |
| Other | serde / serde_json, thiserror, sha2, hex, url, chrono, log |

## Project structure

```
RSS-Reader/
├── src/                             # React + TS frontend
│   ├── App.tsx                      # Main app (two-column layout, state, fetch scheduling)
│   ├── main.tsx                     # React entry
│   ├── styles.css                   # Global styles (Fluent 2, light / dark variables)
│   ├── assets/fonts/                # Subset icon font
│   ├── features/rss/                # RSS domain
│   │   ├── components/              # TitleBar / FeedList / ArticleList / ArticleView
│   │   │                            # AddFeedModal / SettingsModal
│   │   ├── services/rssService.ts   # Tauri IPC wrappers + debounced persistence
│   │   └── types.ts                 # Shared DTOs (aligned with Rust snake_case)
│   └── lib/
│       ├── tauri.ts                 # Typed invoke wrapper
│       ├── preferences.ts           # Theme / font size / interval / proxy (localStorage)
│       └── linkGuard.ts             # Global <a> click guard → system browser
├── src-tauri/                       # Rust backend
│   ├── src/
│   │   ├── main.rs                  # Desktop entry
│   │   ├── lib.rs                   # Builder wiring, command registration, rssimg scheme
│   │   └── commands/
│   │       ├── mod.rs
│   │       └── rss.rs               # Persistence, fetching/parsing, full text, proxy, images
│   ├── capabilities/default.json    # Tauri v2 permission model (least privilege)
│   ├── icons/                       # App icons (desktop and mobile)
│   ├── Cargo.toml
│   └── tauri.conf.json              # Tauri v2 configuration
├── scripts/
│   └── subset-icons.mjs             # Icon font subsetting (run after adding icons)
├── index.html
├── package.json
└── tsconfig.json
```

## Requirements

- [Rust](https://www.rust-lang.org/tools/install) stable (1.70+ recommended)
- [Node.js](https://nodejs.org/) 18+
- Platform WebView runtime: WebView2 on Windows, WebKit on macOS, WebKitGTK on Linux
- Optional: [uv](https://docs.astral.sh/uv/) — only needed to regenerate the icon font subset

## Getting started

```bash
npm install          # Install frontend and Tauri CLI dependencies
npm run tauri dev    # Dev mode (Rust build + frontend HMR)
```

> Changes to Rust code, `capabilities/` or `tauri.conf.json` require restarting `tauri dev`.
> Frontend changes under `src/` hot-reload through Vite.

Production build:

```bash
npm run tauri build  # Bundle the current platform (.msi/.exe, .dmg, .deb/.rpm, ...)
```

Artifacts are written to `src-tauri/target/release/bundle/`.

### Icon font subsetting

Icons use a local Material Symbols Rounded font, already subset: the full variable font is about
5.1 MB, while this project uses 41 icons and ships a ~36 KB subset (keeping `rlig` ligatures and
the `FILL` variable axis).

After adding icons, regenerate it:

```bash
node scripts/subset-icons.mjs   # Requires uv and network access (full font from Google Fonts)
```

The script downloads the full font, subsets it against the built-in icon list and verifies the
ligatures, writing directly to `src/assets/fonts/material-symbols-rounded.woff2`.

## Architecture

- **Rust owns the state**: feeds, articles and groups are persisted to `app_data_dir/state.json`
  through `load_state` / `save_state`. Frontend UI preferences (theme, font size, refresh interval,
  proxy, view mode) are pure presentation state and live in `localStorage`.
- **Fetching and parsing in Rust**: `fetch_feed` sends a browser-style User-Agent, validates the URL
  scheme, issues conditional requests and returns early on 304. When parsing fails and the response
  looks like HTML, it reports a friendly "you entered a web page, not a feed" error.
- **ID generation**: feed IDs are the first 16 hex characters of the SHA-256 of the URL; article IDs
  hash `feed_id + entry identifier`, giving stable deduplication across fetches.
- **Image proxy scheme**: `rssimg://` is handled by an asynchronous URI scheme registered in Rust
  rather than by IPC, so it has no command argument context — the app proxy configuration is
  mirrored into global state via `update_proxy_setting` for it to read.
- **Secure defaults**: capabilities allow only `core:default`, window controls, `opener:default` and
  `dialog:default`; the CSP restricts scripts and resources; article HTML is stripped of `script`,
  `iframe`, `form`, `base` and `meta refresh` nodes before rendering.

## Tauri commands (IPC)

The Rust side exposes the following `#[tauri::command]` functions, called from the frontend through
the typed `call<T>()` helper in `src/features/rss/services/rssService.ts`:

| Command | Description |
|---------|-------------|
| `load_state` | Read persisted state (feeds / articles / groups) from `app_data_dir/state.json` |
| `save_state` | Atomically write the current state back to `state.json` |
| `fetch_feed` | Fetch and parse a feed with `ETag` / `Last-Modified` conditional requests |
| `fetch_article_html` | Fetch the original article HTML when the summary is too short |
| `backup_state` | Export the current state as JSON to a given path |
| `restore_state` | Read a full state from a given JSON file |
| `read_file_text` | Read a text file (OPML import) |
| `write_file_text` | Write text to a file (OPML export) |
| `test_proxy` | Probe through a given proxy and return the round-trip latency |
| `update_proxy_setting` | Mirror the proxy config into Rust global state for `rssimg` fetching |

`rssimg://` is a custom URI scheme (not an IPC command) used for proxied article images.

## Configuration

Main configuration lives in `src-tauri/tauri.conf.json`:

| Key | Value | Notes |
|-----|-------|-------|
| `productName` | `RSSReader` | Bundle name |
| `identifier` | `com.rssreader.app` | Unique app identifier (also determines the data directory) |
| `app.windows` | 1100×750 (min 800×600) | Main window size, resizable, centered, frameless custom title bar |
| `app.security.csp` | Strict CSP | Restricts scripts and resources; `img-src` allows `rssimg:` |
| `bundle.targets` | `all` | Bundle every target of the current platform |

## Data storage

Tauri derives `app_data_dir` from the `identifier`; the state file is `state.json` inside it:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\com.rssreader.app\state.json` |
| macOS | `~/Library/Application Support/com.rssreader.app/state.json` |
| Linux | `~/.local/share/com.rssreader.app/state.json` |

The state file carries a `schema_version`; older files are upgraded on read by `migrate_state`.

## Known limitations

- **Full-text extraction**: only triggered when a feed summary is too short. It relies on container
  selector heuristics plus element removal, so results vary between sites; there is no
  Readability-grade scoring.
- **Article rendering**: HTML is cleaned by node removal rather than a full allow-list sanitizer, so
  it assumes trusted feeds.
- **Platform builds**: `bundle.targets = all` only bundles targets for the host platform;
  cross-platform installers must be built on each OS.
- **Sync**: no cloud sync; moving between devices requires backup / restore or OPML.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 z1HwanG.

You may use, modify and distribute this project freely provided you comply with the license terms:
keep the copyright and license notices, mark files you changed, and observe the patent grant and
disclaimer clauses.

## Third-party assets

- UI icons use [Material Symbols Rounded](https://fonts.google.com/icons) (Apache-2.0), subset to
  the icons this project actually uses and served locally instead of from the Google CDN.
