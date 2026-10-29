import AppKit
import TermoraCore

private final class SidebarNode: NSObject {
    let title: String
    let session: Session?
    let children: [SidebarNode]
    init(title: String, session: Session? = nil, children: [SidebarNode] = []) { self.title = title; self.session = session; self.children = children }
}

final class MainWindowController: NSWindowController, NSWindowDelegate, NSOutlineViewDataSource, NSOutlineViewDelegate, NSSearchFieldDelegate, NSToolbarDelegate {
    private let store: SessionStore
    private let split = NSSplitViewController()
    private let outline = NSOutlineView()
    private let search = NSSearchField()
    private let tabs = NSTabViewController()
    private let status = NSTextField(labelWithString: "Ready")
    private var nodes: [SidebarNode] = []
    private var sheet: ConnectionSheet?
    var onPreferences: (() -> Void)?
    private let sidebarController = NSViewController()
    private let detailController = NSViewController()

    init(store: SessionStore) {
        self.store = store
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Termora Native"; window.minSize = NSSize(width: 840, height: 560)
        window.toolbarStyle = .unified; window.isReleasedWhenClosed = false; window.center()
        super.init(window: window); window.delegate = self
        NativePreferences.applyAppearance()
        buildSidebar(); buildDetail()
        let sidebar = NSSplitViewItem(sidebarWithViewController: sidebarController)
        sidebar.minimumThickness = 210; sidebar.maximumThickness = 380
        split.addSplitViewItem(sidebar); split.addSplitViewItem(NSSplitViewItem(viewController: detailController))
        window.contentViewController = split
        let toolbar = NSToolbar(identifier: "TermoraNativeToolbar")
        toolbar.delegate = self; toolbar.displayMode = .iconOnly; toolbar.allowsUserCustomization = true
        window.toolbar = toolbar
        reloadSessions(); addHome()
    }
    required init?(coder: NSCoder) { fatalError("Not supported") }
    private func buildSidebar() {
        let effect = NSVisualEffectView(); effect.material = .sidebar; effect.blendingMode = .behindWindow
        sidebarController.view = effect
        search.placeholderString = "Search connections"; search.delegate = self
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("connection")); column.title = "Connections"
        outline.addTableColumn(column); outline.outlineTableColumn = column; outline.headerView = nil
        outline.dataSource = self; outline.delegate = self; outline.rowHeight = 30
        outline.style = .sourceList; outline.backgroundColor = .clear
        outline.target = self; outline.doubleAction = #selector(openSelected)
        let menu = NSMenu()
        for (title, action) in [("Connect", #selector(openSelected)), ("Edit…", #selector(editSelected)), ("Delete…", #selector(deleteSelected))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: ""); item.target = self; menu.addItem(item)
        }
        outline.menu = menu
        let scroll = NSScrollView(); scroll.documentView = outline; scroll.hasVerticalScroller = true
        scroll.drawsBackground = false; scroll.autohidesScrollers = true
        let footer = NSTextField(labelWithString: "Saved Connections")
        footer.font = .systemFont(ofSize: 11); footer.textColor = .secondaryLabelColor
        for child in [search, scroll, footer] { effect.addSubview(child); child.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            search.topAnchor.constraint(equalTo: effect.topAnchor, constant: 14), search.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: 12), search.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 12), scroll.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: 6), scroll.trailingAnchor.constraint(equalTo: effect.trailingAnchor, constant: -6), scroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -8),
            footer.leadingAnchor.constraint(equalTo: effect.leadingAnchor, constant: 16), footer.bottomAnchor.constraint(equalTo: effect.bottomAnchor, constant: -12)
        ])
    }
    private func buildDetail() {
        detailController.view = NSView()
        tabs.tabStyle = .segmentedControlOnTop; tabs.transitionOptions = []
        detailController.addChild(tabs)
        let separator = NSBox(); separator.boxType = .separator
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
        for child in [tabs.view, separator, status] { detailController.view.addSubview(child); child.translatesAutoresizingMaskIntoConstraints = false }
        let view = detailController.view
        NSLayoutConstraint.activate([
            tabs.view.topAnchor.constraint(equalTo: view.topAnchor), tabs.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), tabs.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), tabs.view.bottomAnchor.constraint(equalTo: separator.topAnchor),
            separator.leadingAnchor.constraint(equalTo: view.leadingAnchor), separator.trailingAnchor.constraint(equalTo: view.trailingAnchor), separator.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -28),
            status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14), status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14), status.centerYAnchor.constraint(equalTo: separator.bottomAnchor, constant: 14)
        ])
    }
    private func addHome() {
        let controller = NSViewController(); controller.view = NSView()
        let icon = NSImageView(image: NSImage(systemSymbolName: "terminal", accessibilityDescription: "Termora Native")!)
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 66, weight: .light)
        let heading = NSTextField(labelWithString: "Termora Native"); heading.font = .systemFont(ofSize: 30, weight: .medium)
        let subtitle = NSTextField(labelWithString: "A native Mac workspace for your terminals and connections.")
        subtitle.textColor = .secondaryLabelColor
        let local = NSButton(title: "New Local Terminal", target: self, action: #selector(newLocalTerminal)); local.bezelStyle = .rounded
        let connect = NSButton(title: "New Connection…", target: self, action: #selector(newConnection)); connect.bezelStyle = .rounded
        let actions = NSStackView(views: [local, connect]); actions.spacing = 12
        let hint = NSTextField(labelWithString: "⌘T   Local terminal     ⌘N   Connection     ⌘,   Settings")
        hint.font = .systemFont(ofSize: 12); hint.textColor = .tertiaryLabelColor
        let stack = NSStackView(views: [icon, heading, subtitle, actions, hint])
        stack.orientation = .vertical; stack.spacing = 18; stack.alignment = .centerX
        controller.view.addSubview(stack); stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor)])
        let item = NSTabViewItem(viewController: controller); item.label = "Home"; tabs.addTabViewItem(item)
    }
    private var selectedSession: Session? { (outline.item(atRow: outline.clickedRow >= 0 ? outline.clickedRow : outline.selectedRow) as? SidebarNode)?.session }
    private var selectedTerminal: TerminalController? {
        guard tabs.selectedTabViewItemIndex >= 0, tabs.selectedTabViewItemIndex < tabs.tabViewItems.count else { return nil }
        return tabs.tabViewItems[tabs.selectedTabViewItemIndex].viewController as? TerminalController
    }
    private func reloadSessions() {
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = store.sessions.filter { query.isEmpty || [$0.name, $0.host, $0.username, $0.folder].joined(separator: " ").localizedCaseInsensitiveContains(query) }
        let groups = Dictionary(grouping: filtered) { $0.folder.isEmpty ? "My Sessions" : $0.folder }
        nodes = groups.keys.sorted().map { folder in
            SidebarNode(title: folder, children: (groups[folder] ?? []).sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }.map { SidebarNode(title: $0.name, session: $0) })
        }
        outline.reloadData(); outline.expandItem(nil, expandChildren: true)
    }
    func controlTextDidChange(_ obj: Notification) { reloadSessions() }
    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { (item as? SidebarNode)?.children.count ?? nodes.count }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { (item as? SidebarNode)?.children[index] ?? nodes[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { !(item as! SidebarNode).children.isEmpty }
    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool { (item as? SidebarNode)?.session != nil }
    func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool { (item as? SidebarNode)?.session == nil }
    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let node = item as! SidebarNode
        let cell = NSTableCellView()
        let image = NSImageView(image: NSImage(systemSymbolName: node.session?.type.symbol ?? "folder", accessibilityDescription: nil)!)
        let text = NSTextField(labelWithString: node.title); text.lineBreakMode = .byTruncatingTail
        cell.imageView = image; cell.textField = text
        cell.addSubview(image); cell.addSubview(text)
        image.translatesAutoresizingMaskIntoConstraints = false; text.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([image.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2), image.widthAnchor.constraint(equalToConstant: 18), image.heightAnchor.constraint(equalToConstant: 18), image.centerYAnchor.constraint(equalTo: cell.centerYAnchor), text.leadingAnchor.constraint(equalTo: image.trailingAnchor, constant: 8), text.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4), text.centerYAnchor.constraint(equalTo: cell.centerYAnchor)])
        return cell
    }
    @objc func newLocalTerminal() { open(.local()) }
    @objc func newConnection() { showEditor(nil) }
    @objc func editSelected() { if let session = selectedSession { showEditor(session) } }
    private func showEditor(_ session: Session?) {
        guard let window else { return }
        let editor = ConnectionSheet(session: session)
        sheet = editor
        editor.onComplete = { [weak self] value, connect in
            guard let self else { return }
            do { try self.store.save(value); self.reloadSessions(); if connect { self.open(value) } }
            catch { self.present(error) }
            self.sheet = nil
        }
        editor.onCancel = { [weak self] in self?.sheet = nil }
        window.beginSheet(editor.window!)
    }
    @objc func openSelected() { if let session = selectedSession { open(session) } }
    @objc func deleteSelected() {
        guard let session = selectedSession else { return }
        let alert = NSAlert(); alert.messageText = "Delete “\(session.name)”?"; alert.informativeText = "This removes the saved connection. Open terminal tabs stay connected."
        alert.addButton(withTitle: "Delete"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { do { try store.remove(id: session.id); reloadSessions() } catch { present(error) } }
    }
    private func open(_ session: Session) {
        do {
            try session.validate()
            if [.vnc, .rdp, .browser].contains(session.type) { try openExternal(session); return }
            let terminal = TerminalController(session: session)
            let item = NSTabViewItem(viewController: terminal); item.label = session.name
            terminal.titleChanged = { [weak item] title in if !title.isEmpty { item?.label = title } }
            terminal.statusChanged = { [weak self] message in self?.status.stringValue = message }
            tabs.addTabViewItem(item); tabs.selectedTabViewItemIndex = tabs.tabViewItems.count - 1
            window?.makeFirstResponder(terminal.terminal)
        } catch { present(error) }
    }
    private func openExternal(_ session: Session) throws {
        if session.type == .browser { guard let url = URL(string: session.host), NSWorkspace.shared.open(url) else { throw NativeError("Could not open the browser.") }; return }
        if session.type == .vnc {
            var parts = URLComponents(); parts.scheme = "vnc"; parts.host = session.host; parts.port = session.port
            if !session.username.isEmpty { parts.user = session.username }
            guard let url = parts.url, NSWorkspace.shared.open(url) else { throw NativeError("Could not open macOS Screen Sharing.") }; return
        }
        let host = session.host.contains(":") ? "[\(session.host)]" : session.host
        var content = "full address:s:\(host):\(session.port)\r\nprompt for credentials:i:1\r\n"
        if !session.username.isEmpty { content += "username:s:\(session.username)\r\n" }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Termora-\(UUID().uuidString).rdp")
        guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil else { throw NativeError("Install Microsoft Windows App to open RDP connections.") }
        guard let bytes = content.data(using: .utf16LittleEndian) else { throw NativeError("Could not encode the RDP connection.") }
        try (Data([0xff, 0xfe]) + bytes).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        if !NSWorkspace.shared.open(url) { throw NativeError("The RDP application could not open the connection.") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { try? FileManager.default.removeItem(at: url) }
    }
    @objc func closeTab() {
        guard tabs.selectedTabViewItemIndex >= 0 else { return }
        let item = tabs.tabViewItems[tabs.selectedTabViewItemIndex]
        guard let terminal = item.viewController as? TerminalController else { window?.performClose(nil); return }
        if terminal.running && !confirm("Close “\(item.label)”?", detail: "The terminal process will be terminated.") { return }
        terminal.stop(); tabs.removeTabViewItem(item)
    }
    @objc func reconnectTab() {
        guard let terminal = selectedTerminal else { return }
        if terminal.running && !confirm("Reconnect this session?", detail: "The current terminal process will be terminated.") { return }
        let session = terminal.session, item = tabs.tabViewItems[tabs.selectedTabViewItemIndex]
        terminal.stop(); tabs.removeTabViewItem(item); open(session)
    }
    @objc func openSFTP() {
        guard var session = selectedTerminal?.session ?? selectedSession, [.ssh, .sftp].contains(session.type) else { present(NativeError("Select an SSH or SFTP connection first.")); return }
        session.type = .sftp; session.name += " — SFTP"; open(session)
    }
    @objc func nextTab() { if !tabs.tabViewItems.isEmpty { tabs.selectedTabViewItemIndex = (tabs.selectedTabViewItemIndex + 1) % tabs.tabViewItems.count } }
    @objc func previousTab() { if !tabs.tabViewItems.isEmpty { tabs.selectedTabViewItemIndex = (tabs.selectedTabViewItemIndex - 1 + tabs.tabViewItems.count) % tabs.tabViewItems.count } }
    @objc func toggleSidebar() { split.splitViewItems.first?.isCollapsed.toggle() }
    @objc func increaseFont() { NativePreferences.fontSize += 1; updateAppearance() }
    @objc func decreaseFont() { NativePreferences.fontSize -= 1; updateAppearance() }
    func updateAppearance() { NativePreferences.applyAppearance(); for item in tabs.tabViewItems { (item.viewController as? TerminalController)?.updateAppearance() } }
    func stopAll() { for item in tabs.tabViewItems { (item.viewController as? TerminalController)?.stop() } }
    func runSmokeTest(completion: @escaping (Bool) -> Void) {
        guard window?.standardWindowButton(.closeButton) != nil, NSApp.mainMenu?.items.contains(where: { $0.title == "File" }) == true else { completion(false); return }
        newLocalTerminal()
        guard let terminal = selectedTerminal else { completion(false); return }
        var finished = false
        func finish(_ success: Bool) { if !finished { finished = true; completion(success) } }
        terminal.titleChanged = { title in if title == "TERMORA_NATIVE_SMOKE_OK" { finish(true) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let command = Array("printf '\\033]0;TERMORA_NATIVE_SMOKE_OK\\007'\n".utf8)
            terminal.terminal.process.send(data: command[...])
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { finish(false) }
    }
    func confirmCloseAll() -> Bool {
        !tabs.tabViewItems.contains { ($0.viewController as? TerminalController)?.running == true } || confirm("Close active terminal sessions?", detail: "The terminal processes will be terminated.")
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { let allowed = confirmCloseAll(); if allowed { stopAll() }; return allowed }
    private func confirm(_ title: String, detail: String) -> Bool { let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel"); return alert.runModal() == .alertFirstButtonReturn }
    private func present(_ error: Error) { NSAlert(error: error).runModal() }
    @objc func showFeatures() {
        let alert = NSAlert(); alert.messageText = "Termora Native"
        alert.informativeText = "Swift and AppKit windows, native terminal rendering, local shells, SSH, SFTP terminal, serial terminal, saved connections and folders, JSON and MobaXterm import, Screen Sharing, and RDP/browser launchers.\n\nThis first native implementation does not yet include the Electron app’s graphical remote file browser, embedded RDP/VNC, S3, Mosh, server management, tunnels UI, macros, or scheduler."
        alert.runModal()
    }
    @objc func importSessions() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false; panel.title = "Import Connections"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try Data(contentsOf: url)
            var password: String?
            while true {
                do {
                    let imported = try SessionImporter.parse(data, password: password)
                    try store.append(imported.sessions); reloadSessions()
                    let alert = NSAlert(); alert.messageText = "Imported \(imported.sessions.count) connections"
                    alert.informativeText = "\(imported.skipped) unsupported or invalid entries skipped. Password vaults, macros and application settings are not imported."; alert.runModal(); break
                } catch let error as ImportError {
                    let alert = NSAlert(); alert.messageText = "Unlock MobaXterm Backup"; alert.informativeText = error.localizedDescription
                    let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); input.placeholderString = "Export or master password"
                    alert.accessoryView = input; alert.addButton(withTitle: "Unlock"); alert.addButton(withTitle: "Cancel")
                    alert.window.initialFirstResponder = input
                    if alert.runModal() != .alertFirstButtonReturn { input.stringValue = ""; break }
                    password = input.stringValue; input.stringValue = ""
                }
            }
        } catch { present(error) }
    }
    @objc func exportSessions() {
        let panel = NSSavePanel(); panel.title = "Export Connections"; panel.nameFieldStringValue = "termora-native-sessions.json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try SessionImporter.export(store.sessions).write(to: url, options: .atomic) } catch { present(error) }
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.toggleSidebar, .flexibleSpace, .space, .init("local"), .init("connection"), .init("import"), .init("close"), .init("settings")] }
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { [.toggleSidebar, .init("local"), .init("connection"), .flexibleSpace, .init("import"), .init("close"), .init("settings")] }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let definitions: [String: (String, String, Selector)] = ["local": ("New Terminal", "terminal", #selector(newLocalTerminal)), "connection": ("New Connection", "plus", #selector(newConnection)), "import": ("Import Connections", "square.and.arrow.down", #selector(importSessions)), "close": ("Close Tab", "xmark", #selector(closeTab)), "settings": ("Settings", "gearshape", #selector(settings))]
        guard let definition = definitions[identifier.rawValue] else { return nil }
        let item = NSToolbarItem(itemIdentifier: identifier); item.label = definition.0; item.paletteLabel = definition.0; item.toolTip = definition.0
        item.image = NSImage(systemSymbolName: definition.1, accessibilityDescription: definition.0); item.target = self; item.action = definition.2; return item
    }
    @objc private func settings() { onPreferences?() }
}
