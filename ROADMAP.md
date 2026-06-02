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

## M1.5 — Unified media hub ✅
The Library becomes a multi-type front door, not just movies.
- ✅ Content-type classification on scan: audio → Music; video → TV if it looks
     episodic (SxxExx / "Season N" / 1x02 / "Episode N"), else Movie (heuristic,
     no metadata provider)
- ✅ Header filter chips: All · Movies · TV · Music · Podcasts; cards render at
     the right aspect per kind (2:3 video posters vs 1:1 square art)
- ✅ Podcasts mounted in the hub via the shared engine (podcast-core.js) under
     /api/pod — same subscribe / search / resume / speed / offline as standalone
- ✅ podcast-core.js: one engine + one browser widget (CastoPod.mount) shared by
     both the standalone app and the hub (no duplication)
- ✅ Soundbar/audio casting: DLNA upnp:class now matches the media type
     (audioItem for audio), so music + podcasts fling cleanly to DLNA
     soundbars/AV receivers/speakers. (Cast/AirPlay/Sonos remain out of scope —
     separate protocols.)
- ✅ Read-ahead buffer: podcast audio proxy transparently caches the episode to
     ~/.casto on first play (LRU-capped ~2GB), so seeks and a casting renderer's
     repeated Range pulls hit local disk instead of cold-connecting the CDN
- ✅ Flinging audio: cast podcast episodes (and local music, via the existing
     caster) to a DLNA TV/speaker. Podcasts cast our own proxied URL so the
     renderer gets plain HTTP + Range even for HTTPS-CDN episodes; sessions show
     in Now Playing for transport. Per-episode + dock cast; standalone app stays
     cast-free by design
- ✅ TV season/episode detection (SxxExx, ranges, 1x02, "Season N…Episode M",
     bare "Episode N") from filename then folder path; season/episode persisted
     in the index cache and surfaced in browse/search
- ✅ Sequencing: episodes order numerically by season→episode (E2 before E10),
     S·E badge on cards, and the inline player auto-advances to the next episode
     (Autoplay toggle + "Next ▸" + "Up next:" indicator)
- ✅ Continue Watching (video): inline player remembers position per file (by
     rel path, persisted in ~/.casto, survives reindex), resumes on reopen, and
     marks episodes watched near the end. Progress bars on grid cards; ✓ Watched
     / ▶ Resume on show-page rows; a hero ▶ Play/Resume that jumps to the
     in-progress (else first unwatched) episode
- ✅ "Continue Watching" home row: a strip of in-progress items across the
     library (most-recent first), with progress bars; episodes show the series
     name. Click to resume. /api/continue powers it
- ✅ Keyboard shortcuts in the player: Space play/pause, ←/→ seek 10s, F
     fullscreen, N next episode, Esc close (and Esc closes finder/Now Playing)
- ✅ Per-show detail/splash page (Plex/Jellyfin style): opening a show folder
     shows a hero + season picker + episode list; episodes Play (autoplay-next
     within the season) or Cast to a TV. Works for flat folders and Season/*
     subfolders; /api/show aggregates either into season-grouped episodes
- ⬜ "10-foot"/TV mode: D-pad/arrow-key focus nav so the UI is usable on a TV
     browser with a remote
- ⬜ Folder-level kind inference (folders currently always show; leaves filter)
- ⬜ Music metadata (album/artist grouping) + audiobook chapters
- ⬜ Movie-vs-TV via a metadata provider instead of filename heuristics
- ⬜ Cast auto-advance (poll the renderer for "ended" → fling next episode)

## M2.5 — Podcasts ✅ (standalone)
A self-contained podcast app (`podcasts.js`) in the Casto family theme — no
account, no DB, no deps. State lives in ~/.casto (subs, progress, downloads).
- ✅ Subscribe by RSS feed URL (tolerant, dependency-free feed parser)
- ✅ Find shows via the public directory (iTunes Search API, proxied — no key)
- ✅ In-browser player dock: resume-where-you-left-off (persisted position),
     variable speed (0.8×–2×), 15s back / 30s forward, seek bar
- ✅ Offline download (server-side fetch to ~/.casto/podcast-downloads),
     played back locally with Range
- ✅ Audio proxied with Range forwarding so seeking works on any host
- ⬜ Cast-to-TV/speaker hook (reuse casto.js — currently standalone by design)
- ⬜ OPML import/export of subscriptions

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
