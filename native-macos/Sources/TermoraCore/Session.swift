import Foundation

public enum ConnectionKind: String, Codable, CaseIterable {
    case local, ssh, sftp, serial, vnc, rdp, browser
    public var title: String {
        switch self {
        case .local: return "Local Shell"
        case .ssh: return "SSH"
        case .sftp: return "SFTP"
        case .serial: return "Serial"
        case .vnc: return "Screen Sharing"
        case .rdp: return "Remote Desktop"
        case .browser: return "Web Browser"
        }
    }
    public var symbol: String {
        switch self {
        case .local: return "terminal"
        case .ssh: return "network"
        case .sftp: return "folder.badge.gearshape"
        case .serial: return "cable.connector"
        case .vnc, .rdp: return "display"
        case .browser: return "globe"
        }
    }
}

public struct NativeError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Authentication secrets are deliberately absent from the persistent model.
public struct Session: Codable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var type: ConnectionKind
    public var host: String
    public var port: Int
    public var username: String
    public var folder: String
    public var privateKeyPath: String
    public var gatewayHost: String
    public var compression: Bool
    public var x11: Bool
    public var cwd: String
    public var baudRate: Int

    public init(id: String = UUID().uuidString, name: String = "New Connection", type: ConnectionKind = .ssh, host: String = "", port: Int = 22, username: String = "", folder: String = "My Sessions", privateKeyPath: String = "", gatewayHost: String = "", compression: Bool = false, x11: Bool = false, cwd: String = "", baudRate: Int = 115200) {
        self.id = id; self.name = name; self.type = type; self.host = host; self.port = port
        self.username = username; self.folder = folder; self.privateKeyPath = privateKeyPath
        self.gatewayHost = gatewayHost; self.compression = compression; self.x11 = x11
        self.cwd = cwd; self.baudRate = baudRate
    }
    public static func local() -> Session { Session(name: "Local Shell", type: .local) }
    public func validate() throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeError("Enter a connection name.") }
        guard (1...65535).contains(port) else { throw NativeError("Port must be between 1 and 65535.") }
        guard !username.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw NativeError("The username contains a control character.") }
        switch type {
        case .ssh, .sftp, .vnc, .rdp: try Self.validateHost(host)
        case .serial:
            guard host.hasPrefix("/dev/cu.") || host.hasPrefix("/dev/tty.") else { throw NativeError("Select a serial device such as /dev/cu.usbserial.") }
            guard (50...4_000_000).contains(baudRate) else { throw NativeError("The serial baud rate is invalid.") }
        case .browser:
            guard let url = URL(string: host), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { throw NativeError("Enter a complete http or https URL.") }
        case .local: break
        }
        if !gatewayHost.isEmpty { try Self.validateHost(gatewayHost) }
        if !privateKeyPath.isEmpty && !privateKeyPath.hasPrefix("/") { throw NativeError("Select a private key using its absolute file path.") }
        guard !privateKeyPath.contains("\0"), !cwd.contains("\0") else { throw NativeError("File paths cannot contain a null character.") }
    }
    public static func validateHost(_ host: String) throws {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_:%[]@")
        guard !host.isEmpty, host.count <= 253, !host.hasPrefix("-"), host.unicodeScalars.allSatisfy(allowed.contains) else { throw NativeError("Enter a hostname or IP address without spaces, shell punctuation or path separators. Use punycode for international domain names.") }
    }
}

public struct LaunchCommand: Equatable {
    public let executable: String
    public let arguments: [String]
    public let directory: String?
    public init(executable: String, arguments: [String], directory: String? = nil) {
        self.executable = executable; self.arguments = arguments; self.directory = directory
    }
    public static func make(for session: Session, loginShell: String) throws -> LaunchCommand {
        try session.validate()
        if session.type == .local {
            guard loginShell.hasPrefix("/"), !loginShell.contains("\0") else { throw NativeError("Invalid login shell.") }
            return LaunchCommand(executable: loginShell, arguments: ["-l"], directory: session.cwd.isEmpty ? nil : session.cwd)
        }
        if session.type == .serial { return LaunchCommand(executable: "/usr/bin/screen", arguments: [session.host, String(session.baudRate)]) }
        guard session.type == .ssh || session.type == .sftp else { throw NativeError("This connection opens with a native macOS application.") }
        var args = ["-o", "StrictHostKeyChecking=ask"]
        if !session.privateKeyPath.isEmpty { args += ["-i", session.privateKeyPath] }
        if !session.gatewayHost.isEmpty { args += ["-J", session.gatewayHost] }
        if session.compression { args += ["-C"] }
        if session.type == .ssh {
            args += ["-p", String(session.port)]
            if !session.username.isEmpty { args += ["-l", session.username] }
            if session.x11 { args += ["-X"] }
            args += ["--", session.host]
            return LaunchCommand(executable: "/usr/bin/ssh", arguments: args)
        }
        args += ["-P", String(session.port)]
        // SFTP destination syntax; brackets preserve IPv6 port boundaries.
        let host = session.host.contains(":") ? "[\(session.host)]" : session.host
        args += ["--", session.username.isEmpty ? host : "\(session.username)@\(host)"]
        return LaunchCommand(executable: "/usr/bin/sftp", arguments: args)
    }
}
