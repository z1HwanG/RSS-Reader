<div align="center">

# RSS Reader

**A lightweight, cross-platform desktop RSS reader**

Built with **Tauri 2** + **React 18** + **TypeScript**: feed fetching and parsing run entirely in
Rust, while the frontend only renders and handles interaction. Subscriptions and reading state stay
on your machine and never touch a third-party server.

[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://v2.tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[中文](README_zh.md) | [English](README.md)

</div>

---

## Overview

RSS Reader is for people with many subscriptions who want their data kept locally instead of in a
cloud service: network requests only happen when fetching feeds and article images, and everything
else stays on your machine. The UI follows the Fluent 2 visual language with a frameless custom
title bar, and supports light, dark and system themes.

**Project status**: `0.3.2`, early development; features and the persisted format (`schema_version`
in `state.json`) may still change. A Windows x64 installer is available on
[GitHub Releases](https://github.com/z1HwanG/RSS-Reader/releases) or
[Forgejo Releases](https://git.z1hwang.cn/Zeehow/RSS-Reader/releases); macOS and Linux builds require building
from source as described below. Planned work is tracked in [TODO.md](TODO.md).

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
- Deep links: the app registers the `feed://` and `rssreader://` schemes, so clicking a link in the
  browser (for example RSSHub Radar's "Local reader") opens the app with the feed URL prefilled, or
  jumps to the feed if it is already subscribed

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
- Image fetching uses a retry ladder (direct first, add `Referer` on 403 and remember that host;
  with a proxy configured, a failing host is then retried over a direct connection, except on a 404
  that has jsdelivr candidates); GitHub Pages images additionally fall back to the `cdn.jsdelivr.net`
  mirror
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
- External links always go through the opener plugin; the permission model grants no `fs:` or
  `shell:` access, so the frontend cannot touch files on its own. File access exists only through
  four narrow commands — `backup_state`, `restore_state`, `read_file_text` (OPML import) and
  `write_file_text` (OPML export) — and the app only ever passes them paths the user picked in a
  native dialog
- A global link guard intercepts every `<a>` click inside the WebView and opens it in the system
  browser instead, so the app UI can never be replaced by a foreign page; the WebView's default
  context menu (Back / Refresh / Save as / Print) is suppressed, while the app's own context menus
  still work and text inputs keep the native paste / copy menu

### Auto-update

- A delayed silent check at startup with a notice in the message centre; manual check in
  Settings → About
- Download and install in-app (on Windows the NSIS installer runs in passive mode) and the app
  restarts afterwards
- Update packages are minisign-signed and the public key is embedded in the app; a failing signature
  is rejected
- The manifest comes from GitHub Releases first and falls back to Forgejo Releases; the in-app proxy
  setting is used for update requests

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 18 + TypeScript (strict) + Vite 5 |
| Styling | Plain CSS with Fluent 2 design language (light / dark theme variables) |
| Icons | Material Symbols Rounded (locally subset, ~37 KB) |
| Feed parsing | feed-rs 2 (RSS 2.0/1.0, Atom, JSON Feed) |
| HTTP | reqwest 0.12 (rustls TLS, http2, gzip / brotli / deflate, system-proxy, socks) |
| Tauri plugins | @tauri-apps/plugin-opener, @tauri-apps/plugin-dialog, @tauri-apps/plugin-updater, @tauri-apps/plugin-process |
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
│   │   ├── services/updateService.ts# In-app updater wrapper (check / download / install)
│   │   └── types.ts                 # Shared DTOs (aligned with Rust snake_case)
│   └── lib/
│       ├── tauri.ts                 # Typed invoke wrapper
│       ├── preferences.ts           # Theme / font size / interval / proxy (localStorage)
│       ├── linkGuard.ts             # Global <a> click guard → system browser
│       └── contextMenuGuard.ts      # Suppresses the WebView default context menu
├── src-tauri/                       # Rust backend
│   ├── src/
│   │   ├── main.rs                  # Desktop entry
│   │   ├── lib.rs                   # Builder wiring, command registration, rssimg scheme
│   │   ├── deep_link.rs             # feed:// / rssreader:// parsing and dispatch
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
├── tsconfig.json
└── vite.config.ts                   # Vite dev server (fixed port 1420) and build config
```

## Requirements

- **Rust** stable, **1.77.2+** (Tauri 2's MSRV; the development machine runs 1.98)
- **Node.js** 18+ (v24 tested)
- Platform WebView runtime and build tools:

| Platform | What to install |
|----------|-----------------|
| Windows | [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "Desktop development with C++") + [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (usually preinstalled on Windows 11) |
| macOS | `xcode-select --install` (no full Xcode IDE needed for desktop development) |
| Linux | See the commands below; the official [Prerequisites](https://v2.tauri.app/start/prerequisites/) page is authoritative |

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"

# Arch
sudo pacman -Syu --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Optional: [uv](https://docs.astral.sh/uv/) — only needed to regenerate the icon font subset.

## Getting started

### Download (Windows)

Grab a build from Releases (both platforms carry the same files):

- [GitHub Releases](https://github.com/z1HwanG/RSS-Reader/releases/latest)
- [Forgejo Releases](https://git.z1hwang.cn/Zeehow/RSS-Reader/releases)

| File | Notes |
|------|-------|
| `RSSReader_0.3.2_x64-setup.exe` | NSIS installer (recommended) |
| `RSSReader_0.3.2_x64_en-US.msi` | MSI package |
| `RSSReader_0.3.2_x64_portable.exe` | Portable single file; WebView2 must already be installed |

Requires Windows 10/11 x64 and the WebView2 runtime (preinstalled on Windows 11). No prebuilt macOS
or Linux packages yet.

Note: `bundle.targets = "all"` only builds the MSI and NSIS installers for the host platform; the
portable single-file build is produced separately and is not part of the default `tauri build`
output. If a release does not carry a file listed above, use the NSIS installer or build that
variant yourself.

### Run from source

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
5 MB, while this project uses a few dozen icons and ships a ~37 KB subset (keeping `rlig` ligatures
and the `FILL` variable axis).

After adding icons, regenerate it:

```bash
node scripts/subset-icons.mjs   # Requires uv and network access (full font from Google Fonts)
```

The script extracts the icon list from the source, downloads the full font, subsets it and verifies
every ligature with HarfBuzz, writing directly to
`src/assets/fonts/material-symbols-rounded.woff2`.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl / Cmd + F` | Focus and select the search box |
| `Esc` | Clear the search box and leave it; close settings and other modals |
| `Enter` | Confirm a group rename, add a feed, submit a title / URL edit |

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
- **Secure defaults**: capabilities allow only `core:default`, window controls, `opener:default`,
  `dialog:default`, `updater:default` and `process:default` (the latter two only for the in-app
  updater); the CSP restricts scripts and resources; article HTML is stripped of `script`,
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
| `take_pending_feed_link` | Take (and clear) the deep-link URL buffered by Rust for cold starts |

`rssimg://` is a custom URI scheme (not an IPC command) used for proxied article images.

Events: the Rust side emits `feed-link` with the normalised feed URL when a running instance
receives a `feed://` / `rssreader://` deep link (unlisted in the table above because it is pushed
to the frontend rather than invoked).

## Configuration

Main configuration lives in `src-tauri/tauri.conf.json`:

| Key | Value | Notes |
|-----|-------|-------|
| `productName` | `RSSReader` | Bundle name |
| `identifier` | `com.rssreader.app` | Unique app identifier (also determines the data directory) |
| `app.windows` | 1100×750 (min 800×600) | Main window size, resizable, centered, frameless custom title bar |
| `app.security.csp` | Strict CSP | Restricts scripts and resources; `img-src` allows `rssimg:` |
| `bundle.targets` | `all` | Bundle every target of the current platform |
| `plugins.updater` | Endpoints + signing public key | GitHub / Forgejo `latest.json`; Windows install mode `passive` |
| `plugins.deep-link` | `feed` / `rssreader` | Registers the OS protocol handlers for one-click subscription from the browser |

## Data storage

Tauri derives `app_data_dir` from the `identifier`; the state file is `state.json` inside it:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\com.rssreader.app\state.json` |
| macOS | `~/Library/Application Support/com.rssreader.app/state.json` |
| Linux | `~/.local/share/com.rssreader.app/state.json` |

The state file carries a `schema_version`; older files are upgraded on read by `migrate_state`.

## Releasing

1. Bump the version: `npm version minor --no-git-tag-version`, then sync `src-tauri/Cargo.toml`,
   `Cargo.lock`, `tauri.conf.json` and the project-status line in both READMEs.
2. Build with the signing key (adjust the key path):

   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/rss-reader.key"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
   npm run tauri build
   ```

3. Artifacts land in `src-tauri/target/release/bundle/{msi,nsis}/`, each with a `.sig` file next to it.
4. Upload the installers and their `.sig` files to the GitHub / Forgejo release, plus a `latest.json`:

   ```json
   {
     "version": "0.3.2",
     "notes": "release notes",
     "pub_date": "2026-09-10T12:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of RSSReader_0.3.2_x64-setup.exe.sig>",
         "url": "https://github.com/z1HwanG/RSS-Reader/releases/download/v0.3.2/RSSReader_0.3.2_x64-setup.exe"
       }
     }
   }
   ```

   The `version`, the installer file name and the tag in the URL must all be the version you are
   publishing — clients compare `version` against the running build and reject anything lower.

   Each host serves its own `latest.json`: the GitHub one points at GitHub assets and the Forgejo one
   at Forgejo assets; the client tries them in order and falls back automatically.

5. Clients pick the new version up on their next check. Back up the private key
   `~/.tauri/rss-reader.key`: if it is lost you can no longer sign updates that existing installs
   will accept.

## Troubleshooting

**"Returned a web page instead of an RSS/Atom feed" when adding a feed**
You entered the site's homepage. Feed URLs usually end in `.xml`, `/feed`, `/atom.xml` or `/rss`;
open the URL in a browser first to confirm it returns XML.

**Images in articles do not load**
Images are fetched through the local `rssimg://` protocol; failures retry with a `Referer`, and
GitHub Pages images fall back to the jsdelivr mirror. If they still fail, the image host likely
requires a login, rate-limits by IP, or returned something that is not an image — configuring a
proxy in Settings usually helps.

**Icons render as text (e.g. "search")**
The icon font is a local subset and the source uses an icon outside that list. Run
`node scripts/subset-icons.mjs` to regenerate the subset (needs uv and network access).

**The proxy connectivity test fails**
The test probes `google` / `cloudflare` / `baidu` in order and passes if any succeeds. If all fail,
check the host / port and the type (HTTP vs SOCKS5); SOCKS5 uses `socks5h`, so names are resolved by
the proxy.

**Refreshing is slow**
Fetching is capped at 6 concurrent requests, and the first fetch downloads and parses every entry.
Afterwards, feeds that answer with `ETag` / `Last-Modified` skip the download entirely.

**How do I move my data to another machine?**
Settings → General → Backup to export a JSON file, then restore it on the new machine. To move only
subscriptions, use OPML import / export.

**`tauri dev` fails with a missing webkit2gtk on Linux**
A system dependency is missing; install it with the command for your distribution in Requirements.

## Known limitations

- **Full-text extraction**: only triggered when a feed summary is too short. It relies on container
  selector heuristics plus element removal, so results vary between sites; there is no
  Readability-grade scoring.
- **Article rendering**: HTML is cleaned by node removal rather than a full allow-list sanitizer, so
  it assumes trusted feeds.
- **Platform builds**: `bundle.targets = all` only bundles targets for the host platform;
  cross-platform installers must be built on each OS.
- **Sync**: no cloud sync; moving between devices requires backup / restore or OPML.

## Contributing

- Make sure `npm run build` (TypeScript strict check + Vite build) passes before submitting
- For Rust changes, run `cargo fmt` and `cargo clippy --all-targets`
- After adding icons, run `node scripts/subset-icons.mjs` and commit the generated font
- In issues / PRs, include reproduction steps and expected behavior; a screenshot helps for UI issues

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright © 2026 z1HwanG.

You may use, modify and distribute this project freely provided you comply with the license terms:
keep the copyright and license notices, mark files you changed, and observe the patent grant and
disclaimer clauses.

## Third-party assets

- UI icons use [Material Symbols Rounded](https://fonts.google.com/icons) (Apache-2.0), subset to
  the icons this project actually uses and served locally instead of from the Google CDN.
