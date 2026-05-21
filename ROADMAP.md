# Casto — Roadmap (rough-in)

A living, rough milestone plan. Status: ✅ done · 🟡 in progress · ⬜ planned.
"done" for native macOS pieces means written + reviewed, not yet machine-built
(no Mac in the build loop here — first build on a real Mac is the verification).

## M0 — Core caster ✅
The "fling one file to the TV" tool.
- ✅ DLNA discovery (SSDP), AVTransport SetURI + Play
- ✅ Local HTTP serving with Range (seek)
- ✅ Subtitles: sidecar detect, SRT + auto-built SMI fallback
- ✅ Transport: play/pause/stop, relative seek; stdin line commands + `--first`
- ✅ Remote `http(s)` URL casting (no local server)

## M1 — Library server ✅
Browse a whole folder from the TV.
- ✅ UPnP MediaServer: SSDP advertise, ContentDirectory `Browse`, ConnectionManager
- ✅ Folder → container/item tree, Range streaming, sidecar poster art
- ⬜ Lazy indexing for very large / external-drive libraries
- ⬜ NAS guidance (or run the existing NAS DLNA server instead)

## M2 — macOS menu-bar app ✅ (build-unverified)
- ✅ NSStatusItem app, cast a file / serve a library, status
- ✅ Mini poster + back/play-pause/forward/stop controls (pipes to casto.js)
- ✅ Open-at-Login toggle + first-run prompt (SMAppService)
- ✅ Packaging: bundle Node, arm64, Developer-ID sign + notarize + staple
- ⬜ Confirmed build on a real Mac

## M3 — Brand ✅
- ✅ New England light-wood wordmark (Cormorant) + monogram app icon

## M4 — Casto Browser 🟡
Lightweight, API-driven, embeddable browser on system WebKit.
- ✅ v0 scaffold: WKWebView window, Router, BrowserCore, CastBridge
- ✅ HTTP control transport (`:7766`) — open/search/navigate/cast/status
- 🟡 Cast hook: extract page `<video>` src → casto.js (now accepts URLs)
- ⬜ `casto://` deep-link transport (needs `.app` bundle + Info.plist)
- ⬜ Tabs / multiple windows
- ⬜ Library hook (browse, queue, "cast from library")
- ⬜ Embeddable `CastoWebView` for other Swift apps to drop in
- ⬜ Reader mode / simplicity features (the Min-inspired bits)

## M5 — FOSS prep ⬜
- ⬜ `LICENSE` (MIT) + SIL OFL attributions for bundled fonts
- ⬜ Make the "Movies for Misti" tagline configurable
- ⬜ Honest README positioning it as the lightweight option

## M6 — Cross-platform ⬜
- ✅ CLI (casto.js / server.js) already runs on Windows + Linux
- ⬜ Cross-OS GUI: Tauri shell over the same Node engine (vs. per-OS tray)

## M7 — Distribution ⬜
- ⬜ Host on GitLab (private), set up CI
- ⬜ Tagged releases + signed/notarized `.app` for hand-off to Misti
- ⬜ "Build once, AirDrop the .app" flow documented

## Open decisions
- Hosting for the always-on library: Mac + external drive vs. NAS
- Whether the browser justifies its own repo (split out of this monorepo)
- How far to take native (in-process) casting vs. shelling to casto.js
