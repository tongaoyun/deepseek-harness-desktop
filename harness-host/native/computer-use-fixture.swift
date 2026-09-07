import AppKit

// Standalone opt-in acceptance window. No access to user files or applications.
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let input = NSTextField(string: "")
    let result = NSTextField(labelWithString: "等待输入")
    var documentURL: URL? { CommandLine.arguments.count > 1 ? URL(fileURLWithPath: CommandLine.arguments[1]) : nil }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu
        menu.addItem(edit)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 240, y: 300, width: 520, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "小胤桌面操作验收（临时窗口）"
        input.frame = NSRect(x: 30, y: 210, width: 460, height: 30)
        input.setAccessibilityIdentifier("xiaoyin-test-input")
        input.setAccessibilityLabel("验收输入")
        result.frame = NSRect(x: 30, y: 80, width: 460, height: 50)
        result.setAccessibilityIdentifier("xiaoyin-test-result")
        let button = NSButton(title: "检查输入", target: self, action: #selector(check))
        button.frame = NSRect(x: 30, y: 150, width: 140, height: 36)
        button.setAccessibilityIdentifier("xiaoyin-test-check")
        for view in [input, result, button] { window.contentView?.addSubview(view) }
        if documentURL != nil {
            for (index, title) in ["打开测试文档", "保存文档", "重新读取磁盘"].enumerated() {
                let control = NSButton(title: title, target: self, action: #selector(documentAction(_:)))
                control.tag = index
                control.frame = NSRect(x: 25 + index * 165, y: 25, width: 160, height: 36)
                control.setAccessibilityIdentifier("xiaoyin-document-\(index)")
                window.contentView?.addSubview(control)
            }
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func check() { result.stringValue = "已收到：" + input.stringValue }
    @objc func documentAction(_ sender: NSButton) {
        guard let url = documentURL else { return }
        do {
            if sender.tag == 1 {
                try input.stringValue.write(to: url, atomically: true, encoding: .utf8)
                result.stringValue = "已保存到磁盘"
            } else {
                input.stringValue = try String(contentsOf: url, encoding: .utf8)
                result.stringValue = sender.tag == 0 ? "已打开测试文档" : "已从磁盘重新读取"
            }
        } catch { result.stringValue = "读写失败：\(error.localizedDescription)" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Fixture()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
