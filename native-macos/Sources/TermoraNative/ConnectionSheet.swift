import AppKit
import TermoraCore

final class ConnectionSheet: NSWindowController {
    var onComplete: ((Session, Bool) -> Void)?
    var onCancel: (() -> Void)?
    private let original: Session?
    private let kind = NSPopUpButton()
    private let name = NSTextField()
    private let host = NSTextField()
    private let port = NSTextField()
    private let username = NSTextField()
    private let folder = NSTextField()
    private let key = NSTextField()
    private let gateway = NSTextField()
    private let directory = NSTextField()
    private let baud = NSTextField()
    private let compression = NSButton(checkboxWithTitle: "Compress SSH traffic", target: nil, action: nil)
    private let x11 = NSButton(checkboxWithTitle: "Forward X11 to an installed XQuartz server", target: nil, action: nil)
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let kinds = ConnectionKind.allCases
    init(session: Session?) {
        original = session
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 510), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = session == nil ? "New Connection" : "Edit Connection"
        super.init(window: window)
        let value = session ?? Session()
        name.stringValue = session?.name ?? ""
        host.stringValue = value.host; port.stringValue = String(value.port)
        username.stringValue = value.username; folder.stringValue = value.folder
        key.stringValue = value.privateKeyPath; gateway.stringValue = value.gatewayHost
        directory.stringValue = value.cwd; baud.stringValue = String(value.baudRate)
        compression.state = value.compression ? .on : .off; x11.state = value.x11 ? .on : .off
        name.placeholderString = "Connection name"; host.placeholderString = "Hostname, IP address or URL"
        username.placeholderString = "Your current Mac username if left blank"
        key.placeholderString = "Optional private-key file"; gateway.placeholderString = "Optional jump-host name"
        directory.placeholderString = "Home directory if left blank"
        kind.addItems(withTitles: kinds.map(\.title)); kind.selectItem(at: kinds.firstIndex(of: value.type) ?? 1)
        kind.target = self; kind.action = #selector(typeChanged)
        let selector = NSStackView(views: [NSTextField(labelWithString: "Connection type:"), kind]); selector.spacing = 12
        let tabView = NSTabView(); tabView.tabViewType = .topTabsBezelBorder
        func page(_ title: String, rows: [[NSView]], note: String) {
            let item = NSTabViewItem(identifier: title); item.label = title
            let container = NSView(); item.view = container
            let grid = NSGridView(views: rows); grid.columnSpacing = 16; grid.rowSpacing = 14
            grid.column(at: 0).xPlacement = .trailing
            let description = NSTextField(wrappingLabelWithString: note)
            description.font = .systemFont(ofSize: 12); description.textColor = .secondaryLabelColor
            let content = NSStackView(views: [grid, description]); content.orientation = .vertical; content.alignment = .leading; content.spacing = 24
            container.addSubview(content); content.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 22), content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -22), content.topAnchor.constraint(equalTo: container.topAnchor, constant: 26)])
            for row in rows { if let field = row.last as? NSTextField { field.widthAnchor.constraint(greaterThanOrEqualToConstant: 335).isActive = true } }
            tabView.addTabViewItem(item)
        }
        page("Connection", rows: [[NSTextField(labelWithString: "Host / URL / device:"), host], [NSTextField(labelWithString: "Port:"), port], [NSTextField(labelWithString: "Username:"), username], [NSTextField(labelWithString: "Serial baud rate:"), baud]], note: "SSH and SFTP ask for passwords and key passphrases inside the terminal. Host-key verification uses macOS SSH and your existing known_hosts file.")
        let browse = NSButton(title: "Choose…", target: self, action: #selector(chooseKey)); browse.bezelStyle = .rounded
        let keyRow = NSStackView(views: [key, browse]); keyRow.spacing = 8
        key.widthAnchor.constraint(greaterThanOrEqualToConstant: 250).isActive = true
        page("SSH Options", rows: [[NSTextField(labelWithString: "Private key:"), keyRow], [NSTextField(labelWithString: "SSH jump host:"), gateway], [NSTextField(labelWithString: ""), compression], [NSTextField(labelWithString: ""), x11]], note: "Use a key managed by macOS ssh-agent or choose a private key. The app does not copy keys or store passwords.")
        page("Bookmark", rows: [[NSTextField(labelWithString: "Connection name:"), name], [NSTextField(labelWithString: "Folder:"), folder], [NSTextField(labelWithString: "Local starting folder:"), directory]], note: "Saved connections contain connection identity and key-file paths only. Local starting folders apply to Local Shell connections.")
        errorLabel.textColor = .systemRed; errorLabel.font = .systemFont(ofSize: 12)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelSheet)); cancel.bezelStyle = .rounded; cancel.keyEquivalent = "\u{1b}"
        let save = NSButton(title: "Save", target: self, action: #selector(saveOnly)); save.bezelStyle = .rounded
        let connect = NSButton(title: "Save and Connect", target: self, action: #selector(saveAndConnect)); connect.bezelStyle = .rounded; connect.keyEquivalent = "\r"
        let buttons = NSStackView(views: [cancel, save, connect]); buttons.spacing = 10
        guard let view = window.contentView else { return }
        for child in [selector, tabView, errorLabel, buttons] { view.addSubview(child); child.translatesAutoresizingMaskIntoConstraints = false }
        NSLayoutConstraint.activate([
            selector.topAnchor.constraint(equalTo: view.topAnchor, constant: 20), selector.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            tabView.topAnchor.constraint(equalTo: selector.bottomAnchor, constant: 20), tabView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 22), tabView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -22), tabView.bottomAnchor.constraint(equalTo: errorLabel.topAnchor, constant: -10),
            errorLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24), errorLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), errorLabel.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -12), errorLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 18),
            buttons.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24), buttons.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -18)
        ])
        typeChanged()
    }
    required init?(coder: NSCoder) { fatalError("Not supported") }
    @objc private func typeChanged() {
        let value = kinds[kind.indexOfSelectedItem]
        host.isEnabled = value != .local
        let ssh = value == .ssh || value == .sftp
        for field in [username, key, gateway] { field.isEnabled = ssh }
        compression.isEnabled = ssh; x11.isEnabled = value == .ssh
        directory.isEnabled = value == .local; baud.isEnabled = value == .serial
        port.isEnabled = [.ssh, .sftp, .vnc, .rdp].contains(value)
        if original == nil { port.stringValue = value == .vnc ? "5900" : value == .rdp ? "3389" : "22" }
    }
    @objc private func chooseKey() {
        guard let window else { return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in if response == .OK, let url = panel.url { self?.key.stringValue = url.path } }
    }
    @objc private func cancelSheet() { if let window { window.sheetParent?.endSheet(window) }; onCancel?() }
    @objc private func saveOnly() { complete(connect: false) }
    @objc private func saveAndConnect() { complete(connect: true) }
    private func complete(connect: Bool) {
        let type = kinds[kind.indexOfSelectedItem]
        let hostValue = host.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = Session(id: original?.id ?? UUID().uuidString, name: trimmedName.isEmpty ? (type == .local ? "Local Shell" : hostValue) : trimmedName, type: type, host: hostValue, port: Int(port.stringValue) ?? 0, username: username.stringValue, folder: folder.stringValue.isEmpty ? "My Sessions" : folder.stringValue, privateKeyPath: key.stringValue, gatewayHost: gateway.stringValue, compression: compression.state == .on, x11: x11.state == .on, cwd: directory.stringValue, baudRate: Int(baud.stringValue) ?? 0)
        do {
            try session.validate()
            if let window { window.sheetParent?.endSheet(window) }
            onComplete?(session, connect)
        } catch { errorLabel.stringValue = error.localizedDescription }
    }
}
