# Casto Browser

A lightweight, **API-driven, embeddable** web browser. The thesis: a browser
whose every capability is *addressable* — so other apps can drive it, deep-link
into its functions, and embed it — with built-in casting (via Casto) as a
first-class feature, not a plugin.

It is built on **system WebKit (`WKWebView`)**, not a bundled engine. On macOS
that means no shipped Chromium, near-zero footprint, and Apple maintains the
engine + security patches. (We are explicitly *not* writing a render engine
from scratch — see the design note at the bottom.)

## Architecture

```
   transports                router                 core
 ┌───────────────┐      ┌──────────────┐      ┌────────────────┐
 │ HTTP control  │─────▶│              │─────▶│  BrowserCore    │──▶ WKWebView
 │ (localhost)   │      │   Router     │      │  open/search/   │
 ├───────────────┤      │ (one function│      │  navigate/cast  │
 │ casto:// URLs │─────▶│   surface)   │      └────────────────┘
 │ (when bundled)│      │              │               │
 ├───────────────┤      └──────────────┘               ▼
 │ the UI itself │─────────────┘               ┌────────────────┐
 └───────────────┘                             │  CastBridge    │──▶ casto.js (DLNA)
                                                └────────────────┘
```

The key idea: **one `Router`, many transports.** The UI, a localhost HTTP
request, and a `casto://` deep link all call the *same* functions. Nothing the
browser can do is reachable by only one of them.

## API surface

Both transports share these actions (HTTP path == deep-link host == action):

| Action | HTTP (v0, working) | Deep link (when bundled) | Effect |
|---|---|---|---|
| open | `GET /open?url=…&window=new` | `casto://open?url=…` | Load a page |
| search | `GET /search?q=…` | `casto://search?q=…` | Search query |
| navigate | `GET /navigate?action=back\|forward\|reload` | `casto://navigate?action=…` | History/reload |
| cast | `GET /cast?target=living-room&url=…` | `casto://cast?target=…` | Cast page media to a TV |
| library | `GET /library` | `casto://library` | Open the Casto Library |
| status | `GET /status` | `casto://status` | Current URL / state (JSON) |

Every response is JSON, e.g. `{"ok":true}` or `{"ok":true,"url":"https://…"}`.

Example (drive the browser from any other app/script):

```bash
curl "http://127.0.0.1:7766/open?url=example.com"
curl "http://127.0.0.1:7766/cast?target=Living%20Room"
```

## Status (v0 scaffold)

Working / wired:
- WKWebView browser window with toolbar + address bar.
- `Router` + `BrowserCore` function surface.
- **HTTP control transport** on `127.0.0.1:7766`.
- **`casto://` deep-link transport** — AppleEvent handler + `Info.plist`
  `CFBundleURLTypes`. Registers once the app is built + installed (see below).
- `CastBridge` that shells out to `casto.js` (bundled into the .app), now
  casting remote URLs too.
- "Cast" button extracts the page's first `<video>` source and casts it.
- **Tabs** — themed tab strip, new/close (+ ⌘T / ⌘W / ⌘L), `open?window=new`.
- **★ Library** toolbar button → opens the Casto Library (library.js) in a tab
  (`CASTO_LIBRARY` env overrides the URL; default `http://localhost:8010`).

Stubbed / next:
- Per-tab navigation history polish, drag-reorder tabs.
- Library hook (browse/queue), reader mode, embeddable `CastoWebView` for other
  Swift apps to drop in.

## Build / run

Needs macOS + Xcode toolchain.

```bash
cd casto-browser
swift run            # dev: launches the browser; control API on :7766
```

For the `casto://` deep links (URL schemes require a real bundle):

```bash
./build-app.sh                       # produces CastoBrowser.app
mv CastoBrowser.app /Applications/    # register with LaunchServices
open /Applications/CastoBrowser.app   # open once
open "casto://open?url=apple.com"     # now deep links work
```

## Design note: why not a from-scratch engine?

Writing a render engine is one of the largest efforts in software (cf. Servo,
Ladybird — multi-year, multi-person, still chasing Chromium compatibility). It
is also undifferentiated infrastructure users never see. Casto Browser puts its
originality where it's visible — the addressable/embeddable API and casting —
and treats the engine as a system dependency. If a from-scratch engine is ever
the goal, it's a separate, decade-scale project, not a feature of this one.
