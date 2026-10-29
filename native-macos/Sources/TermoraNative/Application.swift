import AppKit
import TermoraCore
import Darwin

@main
@MainActor
enum TermoraMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = ApplicationDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private var controller: MainWindowController?
    private var preferences: PreferencesController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let smoke = CommandLine.arguments.contains("--smoke-test")
            let directory: URL
            if smoke, let temporary = ProcessInfo.processInfo.environment["TERMORA_NATIVE_SMOKE_DATA"] {
                directory = URL(fileURLWithPath: temporary, isDirectory: true)
            } else {
                let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                directory = base.appendingPathComponent("TermoraNative", isDirectory: true)
            }
            let store = try SessionStore(directory: directory)
            controller = MainWindowController(store: store)
            controller?.onPreferences = { [weak self] in self?.showPreferences() }
            installMenus()
            controller?.showWindow(nil)
            NSApp.activate(ignoringOtherApps: true)
            if smoke {
                controller?.runSmokeTest { [weak self] success in
                    self?.controller?.stopAll()
                    print(success ? "PASS Native AppKit window, menu and real PTY round-trip" : "FAIL Native AppKit/PTY smoke test")
                    Darwin.exit(success ? 0 : 1)
                }
            }
        } catch {
            if CommandLine.arguments.contains("--smoke-test") {
                print("FAIL Native startup: \(error.localizedDescription)")
                Darwin.exit(1)
            }
            let alert = NSAlert(error: error); alert.runModal(); NSApp.terminate(nil)
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.showWindow(nil); return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard controller?.confirmCloseAll() != false else { return .terminateCancel }
        controller?.stopAll(); return .terminateNow
    }
    @objc private func showPreferences() {
        if preferences == nil { preferences = PreferencesController(onChange: { [weak self] in self?.controller?.updateAppearance() }) }
        preferences?.showWindow(nil)
    }
    private func installMenus() {
        let bar = NSMenu()
        func submenu(_ name: String) -> NSMenu {
            let item = NSMenuItem(title: name, action: nil, keyEquivalent: "")
            let menu = NSMenu(title: name); item.submenu = menu; bar.addItem(item); return menu
        }
        func command(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "", modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers; item.target = target; menu.addItem(item)
        }
        let application = submenu("Termora")
        command(application, "About Termora Native", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp)
        application.addItem(.separator())
        command(application, "Settings…", #selector(showPreferences), ",", target: self)
        application.addItem(.separator())
        let services = NSMenu(); let serviceItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: ""); serviceItem.submenu = services; application.addItem(serviceItem); NSApp.servicesMenu = services
        application.addItem(.separator())
        command(application, "Hide Termora", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        command(application, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", modifiers: [.command, .option], target: NSApp)
        command(application, "Show All", #selector(NSApplication.unhideAllApplications(_:)), target: NSApp)
        application.addItem(.separator())
        command(application, "Quit Termora", #selector(NSApplication.terminate(_:)), "q", target: NSApp)
        let file = submenu("File")
        command(file, "New Local Terminal", #selector(MainWindowController.newLocalTerminal), "t", target: controller)
        command(file, "New Connection…", #selector(MainWindowController.newConnection), "n", target: controller)
        command(file, "Open Selected Connection", #selector(MainWindowController.openSelected), "o", target: controller)
        command(file, "Edit Selected Connection…", #selector(MainWindowController.editSelected), "e", modifiers: [.command, .shift], target: controller)
        command(file, "Delete Selected Connection…", #selector(MainWindowController.deleteSelected), target: controller)
        file.addItem(.separator())
        command(file, "Import Connections…", #selector(MainWindowController.importSessions), "i", modifiers: [.command, .shift], target: controller)
        command(file, "Export Connections…", #selector(MainWindowController.exportSessions), "e", modifiers: [.command, .option], target: controller)
        file.addItem(.separator())
        command(file, "Close Tab", #selector(MainWindowController.closeTab), "w", target: controller)
        let edit = submenu("Edit")
        command(edit, "Undo", Selector(("undo:")), "z")
        command(edit, "Redo", Selector(("redo:")), "z", modifiers: [.command, .shift])
        edit.addItem(.separator())
        command(edit, "Cut", #selector(NSText.cut(_:)), "x")
        command(edit, "Copy", #selector(NSText.copy(_:)), "c")
        command(edit, "Paste", #selector(NSText.paste(_:)), "v")
        command(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        let view = submenu("View")
        command(view, "Toggle Sidebar", #selector(MainWindowController.toggleSidebar), "s", modifiers: [.command, .control], target: controller)
        command(view, "Larger Terminal Text", #selector(MainWindowController.increaseFont), "+", target: controller)
        command(view, "Smaller Terminal Text", #selector(MainWindowController.decreaseFont), "-", target: controller)
        view.addItem(.separator())
        command(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", modifiers: [.command, .control])
        let terminal = submenu("Terminal")
        command(terminal, "Reconnect Tab", #selector(MainWindowController.reconnectTab), "r", modifiers: [.command, .shift], target: controller)
        command(terminal, "Open SFTP Tab", #selector(MainWindowController.openSFTP), target: controller)
        command(terminal, "Next Tab", #selector(MainWindowController.nextTab), "]", modifiers: [.command, .shift], target: controller)
        command(terminal, "Previous Tab", #selector(MainWindowController.previousTab), "[", modifiers: [.command, .shift], target: controller)
        let window = submenu("Window")
        command(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        command(window, "Zoom", #selector(NSWindow.performZoom(_:)))
        command(window, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), target: NSApp)
        NSApp.windowsMenu = window
        let help = submenu("Help")
        command(help, "Native Build Features", #selector(MainWindowController.showFeatures), target: controller)
        NSApp.helpMenu = help
        NSApp.mainMenu = bar
    }
}

enum NativePreferences {
    static var fontSize: CGFloat {
        get { let value = UserDefaults.standard.double(forKey: "terminalFontSize"); return CGFloat(value == 0 ? 13 : min(32, max(9, value))) }
        set { UserDefaults.standard.set(min(32, max(9, Double(newValue))), forKey: "terminalFontSize") }
    }
    static func applyAppearance() {
        switch UserDefaults.standard.string(forKey: "appearance") {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: NSApp.appearance = nil
        }
    }
}

final class PreferencesController: NSWindowController {
    private let onChange: () -> Void
    private let theme = NSPopUpButton()
    private let size = NSStepper()
    private let sizeLabel = NSTextField(labelWithString: "")
    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 470, height: 250), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Settings"; window.isReleasedWhenClosed = false; window.center()
        super.init(window: window)
        theme.addItems(withTitles: ["Follow macOS", "Light", "Dark"])
        theme.selectItem(at: ["system", "light", "dark"].firstIndex(of: UserDefaults.standard.string(forKey: "appearance") ?? "system") ?? 0)
        theme.target = self; theme.action = #selector(changed)
        size.minValue = 9; size.maxValue = 32; size.increment = 1; size.doubleValue = Double(NativePreferences.fontSize); size.target = self; size.action = #selector(changed)
        let fontRow = NSStackView(views: [sizeLabel, size]); fontRow.spacing = 8
        let grid = NSGridView(views: [[NSTextField(labelWithString: "Appearance:"), theme], [NSTextField(labelWithString: "Terminal text size:"), fontRow]])
        grid.rowSpacing = 18; grid.columnSpacing = 16
        let note = NSTextField(wrappingLabelWithString: "Authentication is handled by macOS SSH and SFTP inside the terminal. This app does not save passwords or access Keychain at startup.")
        note.textColor = .secondaryLabelColor; note.font = .systemFont(ofSize: 12)
        let stack = NSStackView(views: [grid, note]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 24
        window.contentView?.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 26)])
        refreshLabel()
    }
    required init?(coder: NSCoder) { fatalError("Not supported") }
    private func refreshLabel() { sizeLabel.stringValue = "\(Int(size.doubleValue)) pt" }
    @objc private func changed() {
        UserDefaults.standard.set(["system", "light", "dark"][theme.indexOfSelectedItem], forKey: "appearance")
        NativePreferences.fontSize = CGFloat(size.doubleValue); refreshLabel(); NativePreferences.applyAppearance(); onChange()
    }
}
