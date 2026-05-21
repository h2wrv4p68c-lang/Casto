import Cocoa
import WebKit

private let woodBg = NSColor(srgbRed: 0xe9 / 255.0, green: 0xd6 / 255.0, blue: 0xb0 / 255.0, alpha: 1)
private let woodCard = NSColor(srgbRed: 0xfb / 255.0, green: 0xf1 / 255.0, blue: 0xdd / 255.0, alpha: 1)
private let woodInk = NSColor(srgbRed: 0x5b / 255.0, green: 0x3a / 255.0, blue: 0x22 / 255.0, alpha: 1)

final class Tab {
  let webView: WKWebView
  var title: String = "New Tab"
  init(_ webView: WKWebView) { self.webView = webView }
}

// Tabbed browser chrome: a themed tab strip + toolbar over a stack of
// WKWebViews (one per tab). Only the active tab's view is mounted.
final class BrowserWindow: NSWindow, WKNavigationDelegate {
  private var tabs: [Tab] = []
  private var activeIndex = 0
  private let tabBar = NSView()
  private let webContainer = NSView()
  private let addressBar = NSTextField()
  private weak var core: BrowserCore?

  private let tabBarH: CGFloat = 30
  private let toolbarH: CGFloat = 44
  private let tabW: CGFloat = 160

  var activeWebView: WKWebView? { tabs.indices.contains(activeIndex) ? tabs[activeIndex].webView : nil }

  init(core: BrowserCore) {
    self.core = core
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered, defer: false)
    title = "Casto Browser"
    center()

    let W: CGFloat = 1100, H: CGFloat = 760
    let content = NSView(frame: NSRect(x: 0, y: 0, width: W, height: H))
    content.autoresizingMask = [.width, .height]

    tabBar.frame = NSRect(x: 0, y: H - tabBarH, width: W, height: tabBarH)
    tabBar.autoresizingMask = [.width, .minYMargin]
    tabBar.wantsLayer = true
    tabBar.layer?.backgroundColor = woodBg.cgColor

    let bar = NSView(frame: NSRect(x: 0, y: H - tabBarH - toolbarH, width: W, height: toolbarH))
    bar.autoresizingMask = [.width, .minYMargin]
    bar.wantsLayer = true
    bar.layer?.backgroundColor = woodCard.cgColor
    let back = button("◀", #selector(goBack(_:)), x: 8)
    let fwd = button("▶", #selector(goForward(_:)), x: 44)
    let rel = button("⟳", #selector(reloadPage(_:)), x: 80)
    let castBtn = button("Cast", #selector(castPage(_:)), x: W - 76)
    castBtn.frame = NSRect(x: W - 76, y: 6, width: 68, height: 30)
    castBtn.autoresizingMask = [.minXMargin]
    let libBtn = button("★", #selector(openLibraryAction(_:)), x: W - 124)
    libBtn.frame = NSRect(x: W - 124, y: 6, width: 40, height: 30)
    libBtn.toolTip = "Open your Casto Library"
    libBtn.contentTintColor = woodInk
    libBtn.autoresizingMask = [.minXMargin]
    addressBar.frame = NSRect(x: 120, y: 8, width: W - 252, height: 28)
    addressBar.autoresizingMask = [.width]
    addressBar.target = self
    addressBar.action = #selector(go(_:))
    addressBar.placeholderString = "Search or enter address"
    bar.addSubview(back); bar.addSubview(fwd); bar.addSubview(rel)
    bar.addSubview(addressBar); bar.addSubview(libBtn); bar.addSubview(castBtn)

    webContainer.frame = NSRect(x: 0, y: 0, width: W, height: H - tabBarH - toolbarH)
    webContainer.autoresizingMask = [.width, .height]

    content.addSubview(webContainer)
    content.addSubview(bar)
    content.addSubview(tabBar)
    contentView = content

    addTab(nil) // first tab; AppDelegate loads the homepage/deep-link into it
  }

  // MARK: - Tabs

  @discardableResult
  func newTab(_ url: URL?) -> Int { addTab(url) }

  @discardableResult
  private func addTab(_ url: URL?) -> Int {
    let wv = WKWebView(frame: webContainer.bounds, configuration: WKWebViewConfiguration())
    wv.autoresizingMask = [.width, .height]
    wv.navigationDelegate = self
    let tab = Tab(wv)
    tabs.append(tab)
    activeIndex = tabs.count - 1
    if let url = url { wv.load(URLRequest(url: url)) }
    showActiveTab()
    rebuildTabBar()
    return activeIndex
  }

  func selectTab(_ i: Int) {
    guard tabs.indices.contains(i) else { return }
    activeIndex = i
    showActiveTab()
    rebuildTabBar()
    setAddress(activeWebView?.url?.absoluteString ?? "")
  }

  func closeTab(_ i: Int) {
    guard tabs.indices.contains(i) else { return }
    if tabs.count == 1 {
      // Keep one tab alive; just reset it to the homepage.
      tabs[0].webView.load(URLRequest(url: URL(string: "https://duckduckgo.com")!))
      return
    }
    tabs[i].webView.removeFromSuperview()
    tabs.remove(at: i)
    activeIndex = min(activeIndex, tabs.count - 1)
    showActiveTab()
    rebuildTabBar()
  }

  private func showActiveTab() {
    webContainer.subviews.forEach { $0.removeFromSuperview() }
    if let wv = activeWebView {
      wv.frame = webContainer.bounds
      webContainer.addSubview(wv)
    }
  }

  private func rebuildTabBar() {
    tabBar.subviews.forEach { $0.removeFromSuperview() }
    for (i, tab) in tabs.enumerated() {
      let x = CGFloat(i) * tabW
      let container = NSView(frame: NSRect(x: x, y: 0, width: tabW, height: tabBarH))
      container.wantsLayer = true
      container.layer?.backgroundColor = (i == activeIndex ? woodCard : woodBg).cgColor

      let titleBtn = NSButton(frame: NSRect(x: 6, y: 0, width: tabW - 28, height: tabBarH))
      titleBtn.title = tab.title
      titleBtn.isBordered = false
      titleBtn.alignment = .left
      titleBtn.lineBreakMode = .byTruncatingTail
      titleBtn.contentTintColor = woodInk
      titleBtn.tag = i
      titleBtn.target = self
      titleBtn.action = #selector(tabClicked(_:))

      let closeBtn = NSButton(frame: NSRect(x: tabW - 22, y: 5, width: 18, height: 18))
      closeBtn.title = "×"
      closeBtn.isBordered = false
      closeBtn.contentTintColor = woodInk
      closeBtn.tag = i
      closeBtn.target = self
      closeBtn.action = #selector(tabClosed(_:))

      container.addSubview(titleBtn)
      container.addSubview(closeBtn)
      tabBar.addSubview(container)
    }
    let plus = NSButton(frame: NSRect(x: CGFloat(tabs.count) * tabW + 4, y: 3, width: 26, height: 24))
    plus.title = "+"
    plus.isBordered = false
    plus.contentTintColor = woodInk
    plus.target = self
    plus.action = #selector(newTabClicked(_:))
    tabBar.addSubview(plus)
  }

  @objc private func tabClicked(_ s: NSButton) { selectTab(s.tag) }
  @objc private func tabClosed(_ s: NSButton) { closeTab(s.tag) }
  @objc private func newTabClicked(_ s: Any?) { newTab(nil); core?.open(URL(string: "https://duckduckgo.com")!) }

  // MARK: - Toolbar

  private func button(_ t: String, _ s: Selector, x: CGFloat) -> NSButton {
    let b = NSButton(frame: NSRect(x: x, y: 6, width: 32, height: 30))
    b.title = t; b.bezelStyle = .rounded; b.target = self; b.action = s
    return b
  }

  func setAddress(_ s: String) { addressBar.stringValue = s }

  @objc private func go(_ sender: Any?) {
    let text = addressBar.stringValue.trimmingCharacters(in: .whitespaces)
    guard !text.isEmpty else { return }
    if text.contains(".") && !text.contains(" "), let u = normalizeURL(text) { core?.open(u) }
    else { core?.search(text) }
  }
  @objc private func goBack(_ s: Any?) { core?.navigate("back") }
  @objc private func goForward(_ s: Any?) { core?.navigate("forward") }
  @objc private func reloadPage(_ s: Any?) { core?.navigate("reload") }
  @objc private func castPage(_ s: Any?) { core?.castCurrent(target: nil) }
  @objc private func openLibraryAction(_ s: Any?) { core?.openLibrary() }

  // MARK: - Keyboard (no menu needed)

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if event.modifierFlags.contains(.command), let ch = event.charactersIgnoringModifiers {
      switch ch {
      case "t": newTab(nil); core?.open(URL(string: "https://duckduckgo.com")!); return true
      case "w": closeTab(activeIndex); return true
      case "l": makeFirstResponder(addressBar); return true
      default: break
      }
    }
    return super.performKeyEquivalent(with: event)
  }

  // MARK: - Navigation delegate

  func webView(_ wv: WKWebView, didFinish nav: WKNavigation!) {
    guard let idx = tabs.firstIndex(where: { $0.webView === wv }) else { return }
    tabs[idx].title = wv.title?.isEmpty == false ? wv.title! : (wv.url?.host ?? "Tab")
    if idx == activeIndex { setAddress(wv.url?.absoluteString ?? "") }
    rebuildTabBar()
  }
}
