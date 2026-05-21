import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let core = BrowserCore()
  private var window: BrowserWindow!
  private var router: Router!
  private var server: ControlServer!

  func applicationDidFinishLaunching(_ note: Notification) {
    window = BrowserWindow(core: core)
    core.window = window
    router = Router(core: core)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    // Transport #1 (working in v0): localhost HTTP control API.
    server = ControlServer(port: 7766) { [weak self] action, query in
      self?.router.handle(action: action, query: query) ?? ["ok": false]
    }
    server.start()

    core.open(URL(string: "https://duckduckgo.com")!)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
