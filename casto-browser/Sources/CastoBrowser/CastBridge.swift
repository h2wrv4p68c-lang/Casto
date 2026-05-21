import Foundation

// Bridges the browser to the existing Casto caster (casto.js). v0 spawns the
// Node script; native in-process casting (porting the DLNA logic to Swift) is
// a later step. NOTE: casto.js currently casts local files — passing a remote
// media URL is the immediate follow-up on the casto.js side.
final class CastBridge {
  func castMedia(_ url: String, target: String?) {
    guard let casto = locateCasto() else {
      NSLog("CastBridge: casto.js not found")
      return
    }
    let node = locateNode()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    var args = node.hasSuffix("/env") ? ["node", casto] : [casto]
    args += [url, "--first"]
    if let t = target, !t.isEmpty { args += ["--device", t] }
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    do { try p.run() } catch { NSLog("CastBridge: \(error)") }
  }

  private func locateCasto() -> String? {
    let fm = FileManager.default
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let candidates = [
      here.appendingPathComponent("../../../../casto.js"), // repo root from Sources/CastoBrowser
      here.appendingPathComponent("casto.js"),
      URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("casto.js"),
      URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("../casto.js"),
    ]
    for c in candidates {
      let path = c.standardizedFileURL.path
      if fm.fileExists(atPath: path) { return path }
    }
    return nil
  }

  private func locateNode() -> String {
    let fm = FileManager.default
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    where fm.isExecutableFile(atPath: c) { return c }
    return "/usr/bin/env"
  }
}
