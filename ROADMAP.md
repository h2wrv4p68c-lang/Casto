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
- ✅ Multi-TV cast daemon (`castd.js`): one shared media server, a session
  per renderer, control API — different streams on different TVs at once
- ✅ Admin CLI (`casto-ctl`): cast/play/pause/stop/forward/back/devices.
  Local needs nothing; a remote "master" is gated by a LAN password you set
  once (`castd.js --set-token <pw>` or `--gen-token`), no third party

## M1 — Library ✅
Browse a whole folder, with posters — the Plex-style aspect.
- ✅ UPnP MediaServer (`server.js`): browse from the TV directly
- ✅ Library web app (`library.js`): poster-grid UI (wood theme), folder nav,
  inline play, and Cast-to-TV per item; works in any browser / Casto Browser
- ✅ Folder → tree, Range streaming, sidecar poster art
- ✅ Set posters by drag-and-drop (desktop file or dragged web image); split
  "Find poster" panel that opens an image search to drag from — no API/key
- ✅ In-browser player: watch locally with fullscreen + Fit/Fill/Stretch, and/or
  cast to a TV — fully independent (cast-only via the card 📺 button, or watch
  here + cast at the same time if you want; nothing is forced)
- ✅ Rename movies/folders (persisted title overrides)
- ✅ Search across the library + A→Z / Z→A sort
- ✅ Per-TV "Now Playing" sessions manager (rewind/play/pause/forward/stop)
- ✅ Works off attached external drives (point at the mount, e.g. /Volumes/…)
- ✅ Deliberate "Remove from library" (persisted, files untouched) vs. an
  unplugged drive going "pending" and auto-returning on reconnect
- ✅ Lazy + non-blocking indexing: folders scan on first browse, a background
  crawl fills search, never blocks startup/requests (good for big 4TB drives)
- ✅ Index cached in ~/.casto (keyed by path, NOT on the drive) — survives the
  drive being unplugged / a trip out, no reindex; auto-refresh on reconnect
- ✅ User-triggered ↻ Rescan
- ✅ caffeinate keeps the Mac awake while serving so streams don't pause
- ✅ Concurrency hardening: posters resolved from the dir listing (no per-file
  fs), async readdir, availability checks the mount only (O(1)), debounced
  async cache writes — no event-loop stalls while serving a huge drive
- ⬜ server.js still does a synchronous full DLNA scan at startup (only matters
  if you browse the 4TB drive directly from the TV) — lazy DLNA is the fix
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
- ✅ Cast hook: extract page `<video>` src → casto.js (now accepts URLs)
- ✅ `casto://` deep-link transport (AppleEvent + Info.plist; registers on build/install)
- ✅ Packaging: build-app.sh (bundles casto.js + Node, sign/notarize)
- ✅ Library hook: ★ toolbar button opens the Casto Library in a tab
- ✅ Tabs: themed tab strip, new/close, ⌘T / ⌘W / ⌘L, drag-reorder, `window=new`
- ⬜ Per-tab session restore on relaunch
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
