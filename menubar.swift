// Casto — menu-bar companion for the DLNA caster + media server.
//
// A lightweight native macOS menu-bar app (no Electron) that drives the
// sibling casto.js (cast a single file) and server.js (serve a library).
//
// Run it (from the repo folder, needs Xcode command line tools + Node):
//
//   swift menubar.swift
//
// It sits in the menu bar as a wood "C". Quitting it stops anything it
// started. Packaging into a proper .app bundle is a later step.

import Cocoa

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!

  // Child processes we own.
  private var serverProcess: Process?
  private var serverDir: String?
  private var castProcess: Process?
  private var castName: String?

  // casto.js / server.js live next to this source file.
  private let scriptDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.button?.image = brandIcon()
    rebuildMenu()
  }

  func applicationWillTerminate(_ note: Notification) {
    stopServer()
    stopCast()
  }

  // MARK: - Menu

  private func rebuildMenu() {
    let menu = NSMenu()

    let serving = serverProcess != nil
    let casting = castProcess != nil

    let status = NSMenuItem(
      title: serving ? "Serving: \(serverDir.map(prettyPath) ?? "library")"
                     : (casting ? "Casting: \(castName ?? "file")" : "Casto — idle"),
      action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
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
    let quit = NSMenuItem(title: "Quit Casto", action: #selector(NSApp.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)

    statusItem.menu = menu
  }

  // MARK: - Actions

  @objc private func castFileAction() {
    guard let url = pickPath(directories: false, prompt: "Cast") else { return }
    stopCast()
    let p = makeNodeProcess(script: "casto.js", args: [url.path, "--first"])
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.castProcess = nil
        self?.castName = nil
        self?.rebuildMenu()
      }
    }
    do {
      try p.run()
      castProcess = p
      castName = url.lastPathComponent
    } catch {
      notify("Couldn't start cast", error.localizedDescription)
    }
    rebuildMenu()
  }

  @objc private func serveLibraryAction() {
    guard let url = pickPath(directories: true, prompt: "Serve") else { return }
    stopServer()
    let p = makeNodeProcess(script: "server.js", args: [url.path, "--name", "Casto"])
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        self?.serverProcess = nil
        self?.serverDir = nil
        self?.rebuildMenu()
      }
    }
    do {
      try p.run()
      serverProcess = p
      serverDir = url.path
    } catch {
      notify("Couldn't start server", error.localizedDescription)
    }
    rebuildMenu()
  }

  @objc private func stopCastAction() { stopCast(); rebuildMenu() }
  @objc private func stopServerAction() { stopServer(); rebuildMenu() }

  private func stopCast() {
    castProcess?.terminationHandler = nil
    castProcess?.terminate()
    castProcess = nil
    castName = nil
  }

  private func stopServer() {
    serverProcess?.terminationHandler = nil
    serverProcess?.terminate()
    serverProcess = nil
    serverDir = nil
  }

  // MARK: - Helpers

  private func makeNodeProcess(script: String, args: [String]) -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: findNode())
    p.arguments = [scriptDir.appendingPathComponent(script).path] + args
    p.currentDirectoryURL = scriptDir
    // GUI apps inherit a sparse PATH; widen it so child node finds tools.
    var env = ProcessInfo.processInfo.environment
    let extra = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env["PATH"] = extra + ":" + (env["PATH"] ?? "")
    p.environment = env
    return p
  }

  // Look for node in the usual install locations, falling back to PATH.
  private func findNode() -> String {
    let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
    return "/usr/bin/env" // last resort; arguments[0] would need to be "node"
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

  private func prettyPath(_ path: String) -> String {
    URL(fileURLWithPath: path).lastPathComponent
  }

  private func notify(_ title: String, _ body: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = body
    a.runModal()
  }

  // A menu-bar template image of the brand "C".
  private func brandIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size)
    img.lockFocus()
    let font = NSFont(name: "Cormorant Garamond", size: 17)
      ?? NSFont(name: "Times New Roman", size: 16)
      ?? NSFont.systemFont(ofSize: 16, weight: .regular)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
    let s = "C" as NSString
    let bounds = s.size(withAttributes: attrs)
    s.draw(at: NSPoint(x: (size.width - bounds.width) / 2,
                       y: (size.height - bounds.height) / 2),
           withAttributes: attrs)
    img.unlockFocus()
    img.isTemplate = true // tint to match the menu bar (light/dark)
    return img
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
app.run()
