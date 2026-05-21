import Foundation

// The function surface of the browser. Every capability is addressable here,
// so any transport (localhost HTTP today, casto:// deep links once bundled)
// drives the exact same code path. This is the whole point of the project.
struct Router {
  let core: BrowserCore

  @discardableResult
  func handle(action: String, query: [String: String]) -> [String: Any] {
    switch action {
    case "open":
      guard let s = query["url"], let u = normalizeURL(s) else {
        return ["ok": false, "error": "missing or invalid url"]
      }
      core.open(u, newWindow: query["window"] == "new")
      return ["ok": true]

    case "search":
      guard let q = query["q"] else { return ["ok": false, "error": "missing q"] }
      core.search(q)
      return ["ok": true]

    case "navigate":
      core.navigate(query["action"] ?? "reload")
      return ["ok": true]

    case "cast":
      if let s = query["url"], let u = normalizeURL(s) { core.open(u) }
      core.castCurrent(target: query["target"])
      return ["ok": true]

    case "status", "":
      return ["ok": true, "url": core.currentURL()?.absoluteString ?? ""]

    default:
      return ["ok": false, "error": "unknown action: \(action)"]
    }
  }

  // Convenience for the URL-scheme transport (casto://open?url=...).
  func handle(urlString: String) -> [String: Any] {
    guard let comps = URLComponents(string: urlString) else { return ["ok": false] }
    let action = comps.host ?? comps.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var q: [String: String] = [:]
    for item in comps.queryItems ?? [] { q[item.name] = item.value }
    return handle(action: action, query: q)
  }
}

// Bare host or full URL -> URL. "example.com" becomes https://example.com.
func normalizeURL(_ s: String) -> URL? {
  let t = s.trimmingCharacters(in: .whitespaces)
  if t.contains("://") { return URL(string: t) }
  return URL(string: "https://" + t)
}
