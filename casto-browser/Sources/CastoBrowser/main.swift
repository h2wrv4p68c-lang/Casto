import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let core = BrowserCore()
  private var window: BrowserWindow!
  private var router: Router!
  private var server: ControlServer!
  private var pendingURL: String?  // a casto:// URL that arrived before we were ready

  // Register the casto:// handler early so a launch-time URL is caught.
  func applicationWillFinishLaunching(_ note: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleGetURL(_:withReplyEvent:)),
      forEventClass: AEEventClass(0x4755524C),   // 'GURL'
      andEventID: AEEventID(0x4755524C))         // 'GURL'
  }

  // Transport #2: casto:// deep links (e.g. casto://open?url=example.com).
  @objc func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    guard let s = event.paramDescriptor(forKeyword: AEKeyword(0x2D2D2D2D))?.stringValue // '----'
    else { return }
    if router != nil && window != nil { router.handle(urlString: s) } else { pendingURL = s }
  }

  func applicationDidFinishLaunching(_ note: Notification) {
    window = BrowserWindow(core: core)
    core.window = window
    router = Router(core: core)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // Transport #1: localhost HTTP control API.
    server = ControlServer(port: 7766) { [weak self] action, query in
      self?.router.handle(action: action, query: query) ?? ["ok": false]
    }
    server.start()

    // Honour a deep link from launch; otherwise open the homepage.
    if let p = pendingURL {
      pendingURL = nil
      router.handle(urlString: p)
    } else {
      core.open(URL(string: "https://duckduckgo.com")!)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
