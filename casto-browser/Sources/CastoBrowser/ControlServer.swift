import Foundation
import Network

// The working transport for v0: a tiny localhost HTTP server so other apps can
// drive the browser programmatically. Maps  GET /open?url=...  onto the Router
// action "open" with those query params. Minimal by design (one read, one
// response, close); good enough for local control, not a public web server.
final class ControlServer {
  private var listener: NWListener?
  private let portValue: UInt16
  private let route: (String, [String: String]) -> [String: Any]

  init(port: UInt16, route: @escaping (String, [String: String]) -> [String: Any]) {
    self.portValue = port
    self.route = route
  }

  func start() {
    guard let port = NWEndpoint.Port(rawValue: portValue) else { return }
    do {
      listener = try NWListener(using: .tcp, on: port)
    } catch {
      NSLog("ControlServer failed to bind \(portValue): \(error)")
      return
    }
    listener?.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    listener?.start(queue: .global())
    NSLog("Casto control API → http://127.0.0.1:\(portValue)")
  }

  private func accept(_ conn: NWConnection) {
    conn.start(queue: .global())
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
      guard let self = self, let data = data, !data.isEmpty,
            let text = String(data: data, encoding: .utf8) else { conn.cancel(); return }
      let (action, query) = self.parse(text)
      var result: [String: Any] = ["ok": false]
      DispatchQueue.main.sync { result = self.route(action, query) }
      self.respond(conn, json: result)
    }
  }

  private func parse(_ request: String) -> (String, [String: String]) {
    guard let line = request.split(separator: "\r\n").first else { return ("", [:]) }
    let parts = line.split(separator: " ")
    guard parts.count >= 2 else { return ("", [:]) }
    let target = String(parts[1]) // e.g. "/open?url=https://example.com"
    guard let comps = URLComponents(string: "http://localhost" + target) else { return ("", [:]) }
    let action = comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var q: [String: String] = [:]
    for item in comps.queryItems ?? [] { q[item.name] = item.value }
    return (action, q)
  }

  private func respond(_ conn: NWConnection, json: [String: Any]) {
    let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8)
    let header = "HTTP/1.1 200 OK\r\n"
      + "Content-Type: application/json\r\n"
      + "Content-Length: \(body.count)\r\n"
      + "Connection: close\r\n\r\n"
    var out = Data(header.utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}
