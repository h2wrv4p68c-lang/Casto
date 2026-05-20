// Casto — menu-bar companion for the DLNA caster + media server.
//
// A lightweight native macOS menu-bar app (no Electron) that drives the
// sibling casto.js (cast a single file) and server.js (serve a library),
// with a mini poster and transport controls while casting.
//
// Run from source:   swift menubar.swift
// Or build a .app:    ./build-app.sh   (produces Casto.app)
//
// Quitting it stops anything it started.

import Cocoa
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!

  // Child processes we own.
  private var serverProcess: Process?
  private var serverDir: String?
  private var castProcess: Process?
  private var castName: String?
  private var castStdin: FileHandle?     // write newline commands to casto.js
  private var castPoster: NSImage?
  private var isPaused = false

  private lazy var scriptDir: URL = resolveScriptDir()

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = brandIcon()
    rebuildMenu()
    // She'll never hunt for the toggle, so offer it once on first launch.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      self?.maybeOfferLoginItem()
    }
  }

  func applicationWillTerminate(_ note: Notification) {
    stopServer(); stopCast()
  }

  // MARK: - Menu

  private func rebuildMenu() {
    let menu = NSMenu()
    let serving = serverProcess != nil
    let casting = castProcess != nil

    let status = NSMenuItem(
      title: serving ? "Serving: \(serverDir.map(pretty) ?? "library")"
                     : (casting ? "Casting: \(castName ?? "file")" : "Casto — idle"),
      action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)

    if casting {
      if let poster = castPoster {
        let item = NSMenuItem()
        item.view = posterView(poster)
        menu.addItem(item)
      }
      let controls = NSMenuItem()
      controls.view = transportRow()
      menu.addItem(controls)
    }

    menu.addItem(.separator())

    let cast = NSMenuItem(
      title: casting ? "Stop Casting" : "Cast a File…",
      action: casting ? #selector(stopCastAction) : #selector(castFileAction),
      keyEquivalent: "")
    cast.target = self
    menu.addItem(cast)

    let serve = NSMenuItem(
      title: serving ? "Stop Serving" : "Serve a Library…",
      action: serving ? #selector(stopServerAction) : #selector(serveLibraryAction),
      keyEquivalent: "")
    serve.target = self
    menu.addItem(serve)

    menu.addItem(.separator())

    let login = NSMenuItem(title: "Open at Login",
                           action: #selector(toggleLoginItemAction), keyEquivalent: "")
    login.target = self
    login.state = loginItemEnabled() ? .on : .off
    menu.addItem(login)

    menu.addItem(NSMenuItem(title: "Quit Casto",
                            action: #selector(NSApp.terminate(_:)), keyEquivalent: "q"))
    statusItem.menu = menu
  }

  // MARK: - Launch at login

  private func loginItemEnabled() -> Bool {
    if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
    return false
  }

  @objc private func toggleLoginItemAction() {
    setLoginItem(!loginItemEnabled()); rebuildMenu()
  }

  private func setLoginItem(_ on: Bool) {
    guard #available(macOS 13.0, *) else { return }
    do {
      if on {
        if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
      } else {
        try SMAppService.mainApp.unregister()
      }
    } catch {
      alert("Couldn't update Login Item", error.localizedDescription)
    }
  }

  // Ask once (ever) whether to launch at login.
  private func maybeOfferLoginItem() {
    let key = "castoAskedLoginItem"
    let defaults = UserDefaults.standard
    guard !defaults.bool(forKey: key) else { return }
    defaults.set(true, forKey: key)
    guard #available(macOS 13.0, *), SMAppService.mainApp.status != .enabled else { return }

    let a = NSAlert()
    a.messageText = "Open Casto automatically?"
    a.informativeText = "Casto can start in your menu bar each time you log in, so it's always ready to cast."
    a.addButton(withTitle: "Open at Login")
    a.addButton(withTitle: "Not Now")
    NSApp.activate(ignoringOtherApps: true)
    if a.runModal() == .alertFirstButtonReturn { setLoginItem(true) }
  }

  // MARK: - Custom views

  private func posterView(_ image: NSImage) -> NSView {
    let w: CGFloat = 220, h: CGFloat = 132
    let container = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
    let iv = NSImageView(frame: NSRect(x: 10, y: 6, width: w - 20, height: h - 12))
    iv.image = image
    iv.imageScaling = .scaleProportionallyUpOrDown
    iv.wantsLayer = true
    iv.layer?.cornerRadius = 6
    iv.layer?.masksToBounds = true
    container.addSubview(iv)
    return container
  }

  private func transportRow() -> NSView {
    let w: CGFloat = 220, h: CGFloat = 42, bw: CGFloat = 44, bh: CGFloat = 30
    let container = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
    let specs: [(String, Selector)] = [
      ("gobackward.30", #selector(backAction)),
      (isPaused ? "play.fill" : "pause.fill", #selector(toggleAction)),
      ("goforward.30", #selector(forwardAction)),
      ("stop.fill", #selector(transportStopAction)),
    ]
    for (i, spec) in specs.enumerated() {
      let b = NSButton(frame: NSRect(x: 6 + CGFloat(i) * 52, y: (h - bh) / 2, width: bw, height: bh))
      b.isBordered = false
      b.bezelStyle = .regularSquare
      b.imagePosition = .imageOnly
      b.image = NSImage(systemSymbolName: spec.0, accessibilityDescription: nil)
      b.imageScaling = .scaleProportionallyDown
      b.target = self
      b.action = spec.1
      container.addSubview(b)
    }
    return container
  }

  // MARK: - Transport actions (write commands to casto.js stdin)

  @objc private func backAction() { send("back") }
  @objc private func forwardAction() { send("forward") }
  @objc private func transportStopAction() { send("stop") }
  @objc private func toggleAction() {
    send("toggle"); isPaused.toggle(); rebuildMenu()
  }

  private func send(_ cmd: String) {
    guard let h = castStdin, let d = (cmd + "\n").data(using: .utf8) else { return }
    h.write(d)
  }

  // MARK: - Start/stop

  @objc private func castFileAction() {
    guard let url = pickPath(directories: false, prompt: "Cast") else { return }
    stopCast()
    let pipe = Pipe()
    let p = makeNodeProcess(script: "casto.js", args: [url.path, "--first"])
    p.standardInput = pipe
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.castProcess = nil; self?.castStdin = nil
        self?.castName = nil; self?.castPoster = nil; self?.isPaused = false
        self?.rebuildMenu()
      }
    }
    do {
      try p.run()
      castProcess = p
      castStdin = pipe.fileHandleForWriting
      castName = url.lastPathComponent
      castPoster = posterImage(forVideo: url)
      isPaused = false
    } catch {
      alert("Couldn't start cast", error.localizedDescription)
    }
    rebuildMenu()
  }

  @objc private func serveLibraryAction() {
    guard let url = pickPath(directories: true, prompt: "Serve") else { return }
    stopServer()
    let p = makeNodeProcess(script: "server.js", args: [url.path, "--name", "Casto"])
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.serverProcess = nil; self?.serverDir = nil; self?.rebuildMenu()
      }
    }
    do {
      try p.run(); serverProcess = p; serverDir = url.path
    } catch {
      alert("Couldn't start server", error.localizedDescription)
    }
    rebuildMenu()
  }

  @objc private func stopCastAction() { stopCast(); rebuildMenu() }
  @objc private func stopServerAction() { stopServer(); rebuildMenu() }

  private func stopCast() {
    castProcess?.terminationHandler = nil
    castProcess?.terminate()
    castProcess = nil; castStdin = nil
    castName = nil; castPoster = nil; isPaused = false
  }

  private func stopServer() {
    serverProcess?.terminationHandler = nil
    serverProcess?.terminate()
    serverProcess = nil; serverDir = nil
  }

  // MARK: - Helpers

  private func posterImage(forVideo url: URL) -> NSImage? {
    let dir = url.deletingLastPathComponent()
    let base = url.deletingPathExtension().lastPathComponent
    let fm = FileManager.default
    for ext in ["jpg", "jpeg", "png", "webp"] {
      let p = dir.appendingPathComponent(base + "." + ext)
      if fm.fileExists(atPath: p.path) { return NSImage(contentsOf: p) }
    }
    for name in ["poster", "folder", "cover"] {
      for ext in ["jpg", "jpeg", "png"] {
        let p = dir.appendingPathComponent(name + "." + ext)
        if fm.fileExists(atPath: p.path) { return NSImage(contentsOf: p) }
      }
    }
    return nil
  }

  private func makeNodeProcess(script: String, args: [String]) -> Process {
    let p = Process()
    let node = findNode()
    p.executableURL = URL(fileURLWithPath: node)
    let scriptPath = scriptDir.appendingPathComponent(script).path
    p.arguments = (node.hasSuffix("/env") ? ["node", scriptPath] : [scriptPath]) + args
    p.currentDirectoryURL = scriptDir
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    return p
  }

  private func findNode() -> String {
    let fm = FileManager.default
    // Prefer a node bundled inside the .app so nothing need be preinstalled.
    if let res = Bundle.main.resourceURL {
      let bundled = res.appendingPathComponent("node").path
      if fm.isExecutableFile(atPath: bundled) { return bundled }
    }
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    where fm.isExecutableFile(atPath: c) { return c }
    return "/usr/bin/env"
  }

  // Scripts live in the .app's Resources, or next to this source file.
  private func resolveScriptDir() -> URL {
    let fm = FileManager.default
    var candidates: [URL] = []
    if let res = Bundle.main.resourceURL { candidates.append(res) }
    candidates.append(URL(fileURLWithPath: #filePath).deletingLastPathComponent())
    candidates.append(URL(fileURLWithPath: fm.currentDirectoryPath))
    for c in candidates
    where fm.fileExists(atPath: c.appendingPathComponent("casto.js").path) { return c }
    return candidates.first ?? URL(fileURLWithPath: ".")
  }

  private func pickPath(directories: Bool, prompt: String) -> URL? {
    let panel = NSOpenPanel()
    panel.canChooseFiles = !directories
    panel.canChooseDirectories = directories
    panel.allowsMultipleSelection = false
    panel.prompt = prompt
    NSApp.activate(ignoringOtherApps: true)
    return panel.runModal() == .OK ? panel.url : nil
  }

  private func pretty(_ path: String) -> String { URL(fileURLWithPath: path).lastPathComponent }

  private func alert(_ title: String, _ body: String) {
    let a = NSAlert(); a.messageText = title; a.informativeText = body; a.runModal()
  }

  private func brandIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    let font = NSFont(name: "Cormorant Garamond", size: 17)
      ?? NSFont(name: "Times New Roman", size: 16)
      ?? NSFont.systemFont(ofSize: 16)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
    let s = "C" as NSString
    let b = s.size(withAttributes: attrs)
    s.draw(at: NSPoint(x: (size.width - b.width) / 2, y: (size.height - b.height) / 2),
           withAttributes: attrs)
    img.unlockFocus()
    img.isTemplate = true
    return img
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
