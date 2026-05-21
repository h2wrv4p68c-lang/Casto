import Cocoa
import WebKit

// Owns the actual browsing actions. The Router calls into this; the UI calls
// into this. One source of truth, whether a human clicked or an app sent an
// API request. All WebKit work is marshalled to the main thread.
final class BrowserCore {
  weak var window: BrowserWindow?
  private let cast = CastBridge()

  func open(_ url: URL, newWindow: Bool = false) {
    onMain {
      // newWindow is a documented v0 stub: single window for now.
      self.window?.webView.load(URLRequest(url: url))
      self.window?.setAddress(url.absoluteString)
    }
  }

  func search(_ q: String) {
    var c = URLComponents(string: "https://duckduckgo.com/")!
    c.queryItems = [URLQueryItem(name: "q", value: q)]
    if let u = c.url { open(u) }
  }

  func navigate(_ action: String) {
    onMain {
      guard let wv = self.window?.webView else { return }
      switch action {
      case "back": wv.goBack()
      case "forward": wv.goForward()
      case "reload": wv.reload()
      default: break
      }
    }
  }

  func currentURL() -> URL? { window?.webView.url }

  // The Casto hook: find a playable media source on the current page and hand
  // it to the casto.js DLNA caster. Falls back to the page URL itself.
  func castCurrent(target: String?) {
    onMain {
      guard let wv = self.window?.webView else { return }
      let js = """
      (function(){var v=document.querySelector('video source[src],video[src]');\
      return v?(v.src||v.getAttribute('src')):'';})()
      """
      wv.evaluateJavaScript(js) { result, _ in
        let media = (result as? String) ?? ""
        let toCast = media.isEmpty ? (wv.url?.absoluteString ?? "") : media
        if !toCast.isEmpty { self.cast.castMedia(toCast, target: target) }
      }
    }
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }
}
