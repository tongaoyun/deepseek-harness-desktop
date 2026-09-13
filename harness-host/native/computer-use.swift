import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

// One bounded action and a fresh observation. Never requests OS permissions
// silently; the user enables Accessibility and Screen Recording in Settings.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8)); exit(1)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return value
}
func windowSignature(_ pid: pid_t) -> String {
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.15)
    guard let focused = attribute(root, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { return "no-focused-window" }
    let window = focused as! AXUIElement
    var point = CGPoint.zero, size = CGSize.zero
    if let value = attribute(window, kAXPositionAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(value as! AXValue, .cgPoint, &point) }
    if let value = attribute(window, kAXSizeAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(value as! AXValue, .cgSize, &size) }
    return "\(attribute(window, kAXTitleAttribute) as? String ?? "")|\(point.x),\(point.y),\(size.width),\(size.height)"
}
@main struct ComputerUse {
  static func main() async {
    guard CommandLine.arguments.count == 2,
      let data = CommandLine.arguments[1].data(using: .utf8),
      let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("无效桌面操作参数") }
    let action = input["action"] as? String ?? ""
    guard ["observe", "click", "type", "key", "scroll"].contains(action) else { fail("不支持的桌面操作") }
    let lockPath = NSTemporaryDirectory() + "xiaoyin-desktop-control-\(getuid()).lock"
    let lock = open(lockPath, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { fail("无法建立桌面操作锁") }
    defer { close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { fail("另一个任务正在操作桌面，请稍后重新观察再继续") }
    guard AXIsProcessTrusted() else { fail("请在系统设置 → 隐私与安全性 → 辅助功能中允许小胤及其桌面操作助手，然后重试") }
    guard CGPreflightScreenCaptureAccess() else { fail("请在系统设置 → 隐私与安全性 → 屏幕录制中允许小胤及其桌面操作助手，然后重试") }
    guard #available(macOS 14.0, *) else { fail("桌面操作需要 macOS 14 或更新版本；文件与命令工具仍可使用") }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else { fail("没有可用的主显示器") }
      let bounds = CGDisplayBounds(display.displayID)
      let scale = min(1.0, 2560.0 / max(bounds.width, bounds.height))
      let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
      if action != "observe" {
        guard let expected = input["expectedProcessId"] as? Int,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(expected),
          input["expectedWindowSignature"] as? String == windowSignature(pid_t(expected)),
          input["expectedWidth"] as? Int == width, input["expectedHeight"] as? Int == height else {
            fail("前台应用、窗口或显示器已变化，未执行操作；请重新观察桌面，不要沿用旧坐标")
        }
      }
      let x = input["x"] as? Double ?? 0, y = input["y"] as? Double ?? 0
      if ["click", "scroll"].contains(action) && (x < 0 || y < 0 || x >= Double(width) || y >= Double(height)) { fail("坐标超出最近截图范围") }
      let point = CGPoint(x: bounds.minX + x / scale, y: bounds.minY + y / scale)
      let source = CGEventSource(stateID: .hidSystemState)
      if action == "click" {
        let right = input["button"] as? String == "right"
        let button: CGMouseButton = right ? .right : .left
        let count = min(2, max(1, input["clickCount"] as? Int ?? 1))
        for index in 1...count {
          for eventType: CGEventType in [right ? .rightMouseDown : .leftMouseDown, right ? .rightMouseUp : .leftMouseUp] {
            let event = CGEvent(mouseEventSource: source, mouseType: eventType, mouseCursorPosition: point, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(index)); event?.post(tap: .cghidEventTap)
          }
        }
      } else if action == "type" {
        let text = input["text"] as? String ?? ""
        guard text.utf16.count <= 4000 else { fail("单次输入过长") }
        let characters = Array(text.utf16)
        for down in [true, false] {
          let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
          event?.flags = []
          characters.withUnsafeBufferPointer { buffer in if let base = buffer.baseAddress { event?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base) } }
          event?.post(tap: .cghidEventTap)
        }
      } else if action == "key" {
        let keys: [String: CGKeyCode] = ["ENTER":36,"TAB":48,"ESC":53,"BACKSPACE":51,"DELETE":117,"SPACE":49,"LEFT":123,"UP":126,"RIGHT":124,"DOWN":125,"HOME":115,"END":119,"PAGEUP":116,"PAGEDOWN":121,"A":0,"C":8,"F":3,"G":5,"L":37,"N":45,"O":31,"P":35,"S":1,"V":9,"W":13,"X":7,"Y":16,"Z":6,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111]
        guard let key = keys[input["key"] as? String ?? ""] else { fail("不支持的按键") }
        let flags: [String: CGEventFlags] = ["CTRL":.maskControl,"ALT":.maskAlternate,"SHIFT":.maskShift,"WIN":.maskCommand]
        var mask = CGEventFlags()
        for flag in (input["modifiers"] as? String ?? "").split(separator: ",") { if let value = flags[String(flag)] { mask.formUnion(value) } }
        for down in [true, false] { let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down); event?.flags = mask; event?.post(tap: .cghidEventTap) }
      } else if action == "scroll" {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        let delta = min(1200, max(-1200, input["delta"] as? Int ?? 0))
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
      }
      if action != "observe" { try await Task.sleep(nanoseconds: 250_000_000) }
      let config = SCStreamConfiguration(); config.width = width; config.height = height; config.showsCursor = false
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let screenshot = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      guard let path = input["screenshot"] as? String,
        let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fail("无法写入桌面截图") }
      CGImageDestinationAddImage(destination, screenshot, nil)
      guard CGImageDestinationFinalize(destination) else { fail("桌面截图保存失败") }
      let front = NSWorkspace.shared.frontmostApplication
      var elements: [[String: Any]] = []
      var visited = 0
      var traversalTruncated = false
      let deadline = ProcessInfo.processInfo.systemUptime + 2
      let limit = min(160, max(1, input["maxElements"] as? Int ?? 100))
      if let front = front {
        let root = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.15)
        var seen = Set<AXUIElement>()
        var expanded = Set<AXUIElement>()
        var pending: [(AXUIElement, Int)] = []
        func walk(_ element: AXUIElement, _ depth: Int, expand: Bool = true) {
          if expand && !expanded.insert(element).inserted { return }
          let isNew = seen.insert(element).inserted
          guard depth < 14, visited < 800, elements.count < limit,
            ProcessInfo.processInfo.systemUptime < deadline else { traversalTruncated = true; return }
          visited += 1
          var origin = CGPoint.zero, size = CGSize.zero
          if let pos = attribute(element, kAXPositionAttribute), CFGetTypeID(pos) == AXValueGetTypeID(), let dim = attribute(element, kAXSizeAttribute), CFGetTypeID(dim) == AXValueGetTypeID() {
            AXValueGetValue(pos as! AXValue, .cgPoint, &origin); AXValueGetValue(dim as! AXValue, .cgSize, &size)
            if isNew && CGRect(origin: origin, size: size).intersects(bounds) && size.width > 0 && size.height > 0 {
              let role = attribute(element, kAXRoleAttribute) as? String ?? ""
              let label = [attribute(element, kAXTitleAttribute) as? String, attribute(element, kAXDescriptionAttribute) as? String].compactMap { $0 }.first { !$0.isEmpty } ?? ""
              let secure = attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
              let value = secure ? "" : (attribute(element, kAXValueAttribute) as? String ?? "")
              elements.append(["name":String(label.prefix(300)),"value":String(value.prefix(2000)),"automationId":attribute(element, kAXIdentifierAttribute) as? String ?? "","controlType":role,"x":(origin.x-bounds.minX)*scale,"y":(origin.y-bounds.minY)*scale,"width":size.width*scale,"height":size.height*scale])
            }
          }
          if expand {
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            let remaining = max(0, 800 - pending.count)
            if children.count > remaining { traversalTruncated = true }
            pending.append(contentsOf: children.prefix(remaining).map { ($0, depth + 1) })
          }
        }
        // Dialogs and their focused input must not be displaced by the file
        // picker's large background/sidebar tree under the observation limit.
        if let focused = attribute(root, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
          let element = focused as! AXUIElement
          walk(element, 0, expand: false)
        }
        if let window = attribute(root, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
          pending.append((window as! AXUIElement, 0))
        }
        pending.append((root, 0))
        var cursor = 0
        while cursor < pending.count && elements.count < limit && ProcessInfo.processInfo.systemUptime < deadline {
          let (element, depth) = pending[cursor]
          cursor += 1
          walk(element, depth)
        }
        if cursor < pending.count { traversalTruncated = true }
      }
      let activeSignature: String = if let front { windowSignature(front.processIdentifier) } else { "" }
      let result: [String: Any] = ["screen":["width":width,"height":height],"activeWindow":["title":front?.localizedName ?? "","processId":front?.processIdentifier ?? 0,"signature":activeSignature],"elements":elements,"truncated":traversalTruncated || elements.count >= limit || visited >= 800]
      FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
    } catch { fail("桌面操作或观察失败，操作可能已经执行，请重新观察后再决定：\(error.localizedDescription)") }
  }
}
