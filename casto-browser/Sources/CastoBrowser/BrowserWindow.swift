import Cocoa
import WebKit

// Minimal browser chrome: a toolbar (back / forward / reload / address / Cast)
// on top of a system WKWebView. Deliberately thin — the interesting surface is
// the Router, not the UI.
final class BrowserWindow: NSWindow, WKNavigationDelegate {
  let webView: WKWebView
  private let addressBar = NSTextField()
  private weak var core: BrowserCore?

  init(core: BrowserCore) {
    self.core = core
    webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    title = "Casto Browser"
    center()

    let content = NSView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760))
    content.autoresizingMask = [.width, .height]

    let barH: CGFloat = 44
    let bar = NSView(frame: NSRect(x: 0, y: 760 - barH, width: 1100, height: barH))
    bar.autoresizingMask = [.width, .minYMargin]

    let back = button("◀", #selector(goBack(_:)), x: 8)
    let fwd = button("▶", #selector(goForward(_:)), x: 44)
    let rel = button("⟳", #selector(reloadPage(_:)), x: 80)
    let castBtn = button("Cast", #selector(castPage(_:)), x: 1100 - 76)
    castBtn.frame = NSRect(x: 1100 - 76, y: 6, width: 68, height: 30)
    castBtn.autoresizingMask = [.minXMargin]

    addressBar.frame = NSRect(x: 120, y: 8, width: 1100 - 210, height: 28)
    addressBar.autoresizingMask = [.width]
    addressBar.target = self
    addressBar.action = #selector(go(_:))
    addressBar.placeholderString = "Search or enter address"

    bar.addSubview(back); bar.addSubview(fwd); bar.addSubview(rel)
    bar.addSubview(addressBar); bar.addSubview(castBtn)

    webView.frame = NSRect(x: 0, y: 0, width: 1100, height: 760 - barH)
    webView.autoresizingMask = [.width, .height]
    webView.navigationDelegate = self

    content.addSubview(webView)
    content.addSubview(bar)
    contentView = content
  }

  private func button(_ t: String, _ s: Selector, x: CGFloat) -> NSButton {
    let b = NSButton(frame: NSRect(x: x, y: 6, width: 32, height: 30))
    b.title = t
    b.bezelStyle = .rounded
    b.target = self
    b.action = s
    return b
  }

  func setAddress(_ s: String) { addressBar.stringValue = s }

  @objc private func go(_ sender: Any?) {
    let text = addressBar.stringValue.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    if text.contains(".") && !text.contains(" "), let u = normalizeURL(text) {
      core?.open(u)
    } else {
      core?.search(text)
    }
  }

  @objc private func goBack(_ s: Any?) { core?.navigate("back") }
  @objc private func goForward(_ s: Any?) { core?.navigate("forward") }
  @objc private func reloadPage(_ s: Any?) { core?.navigate("reload") }
  @objc private func castPage(_ s: Any?) { core?.castCurrent(target: nil) }

  func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
    setAddress(wv.url?.absoluteString ?? "")
  }
}
