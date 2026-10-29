import Foundation
import CryptoKit
import CommonCrypto

public struct ImportResult {
    public let sessions: [Session]
    public let skipped: Int
}
public enum ImportError: LocalizedError {
    case passwordRequired, wrongPassword
    public var errorDescription: String? {
        switch self {
        case .passwordRequired: return "This MobaXterm backup requires its export or master password."
        case .wrongPassword: return "Could not unlock the backup. Check its password; the file may also use an unsupported format."
        }
    }
}

public enum SessionImporter {
    public static let maximumBytes = 10 * 1024 * 1024
    public static func parse(_ data: Data, password: String? = nil) throws -> ImportResult {
        guard !data.isEmpty, data.count <= maximumBytes else { throw NativeError("Choose a non-empty session file up to 10 MiB.") }
        let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let source: String
        if let raw, raw.hasPrefix("_@") {
            guard let password else { throw ImportError.passwordRequired }
            source = try decrypt(raw, password: password)
        } else {
            guard let text = decode(data) else { throw NativeError("The configuration encoding is not supported.") }
            source = text
        }
        if let json = source.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: json) {
            let rows = (value as? [[String: Any]]) ?? ((value as? [String: Any])?["sessions"] as? [[String: Any]])
            guard let rows else { throw NativeError("The JSON file has no sessions array.") }
            var sessions: [Session] = [], skipped = 0
            for row in rows {
                guard let type = ConnectionKind(rawValue: row["type"] as? String ?? "ssh") else { skipped += 1; continue }
                let host = row["host"] as? String ?? ""
                let session = Session(id: row["id"] as? String ?? UUID().uuidString, name: row["name"] as? String ?? host, type: type, host: host, port: (row["port"] as? Int) ?? defaultPort(type), username: row["username"] as? String ?? "", folder: (row["folder"] ?? row["group"]) as? String ?? "My Sessions", privateKeyPath: row["privateKeyPath"] as? String ?? "", gatewayHost: row["gatewayHost"] as? String ?? "", compression: row["compression"] as? Bool ?? false, x11: row["x11"] as? Bool ?? false, cwd: row["cwd"] as? String ?? "", baudRate: row["baudRate"] as? Int ?? 115200)
                if (try? session.validate()) != nil { sessions.append(session) } else { skipped += 1 }
            }
            return ImportResult(sessions: sessions, skipped: skipped)
        }
        var section = "", folder = "My Sessions", sessions: [Session] = [], skipped = 0
        for rawLine in source.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("[") && line.hasSuffix("]") { section = String(line.dropFirst().dropLast()); folder = "My Sessions"; continue }
            guard section == "Bookmarks" || section.range(of: "^Bookmarks_[0-9]+$", options: .regularExpression) != nil, let equals = line.firstIndex(of: "=") else { continue }
            let name = String(line[..<equals]), value = String(line[line.index(after: equals)...])
            if name == "SubRep" { folder = value.isEmpty ? "My Sessions" : value; continue }
            if name == "ImgNum" { continue }
            let parts = value.components(separatedBy: "#")
            guard parts.count >= 3 else { skipped += 1; continue }
            let fields = parts[2].components(separatedBy: "%")
            guard fields.count >= 2, let type = ["0": ConnectionKind.ssh, "4": .rdp, "5": .vnc, "7": .sftp][fields[0]] else { skipped += 1; continue }
            let session = Session(name: unescape(name), type: type, host: unescape(fields[1]), port: fields.count > 2 ? Int(fields[2]) ?? defaultPort(type) : defaultPort(type), username: fields.count > 3 ? unescape(fields[3]) : "", folder: unescape(folder))
            if (try? session.validate()) != nil { sessions.append(session) } else { skipped += 1 }
        }
        guard !sessions.isEmpty else { throw NativeError("No supported session definitions were found. Existing sessions were not changed.") }
        return ImportResult(sessions: sessions, skipped: skipped)
    }
    public static func export(_ sessions: [Session]) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(sessions)
    }
    private static func defaultPort(_ kind: ConnectionKind) -> Int { kind == .vnc ? 5900 : kind == .rdp ? 3389 : 22 }
    private static func unescape(_ value: String) -> String {
        ["__PTVIRG__": ";", "__PIPE__": "|", "__EQUAL__": "=", "__DIEZE__": "#"].reduce(value) { $0.replacingOccurrences(of: $1.key, with: $1.value) }
    }
    private static func decode(_ data: Data) -> String? {
        if data.starts(with: [0xff, 0xfe]) { return String(data: data.dropFirst(2), encoding: .utf16LittleEndian) }
        let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1252)
        return text?.trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}"))
    }
    private static func decrypt(_ raw: String, password: String) throws -> String {
        guard raw.count > 20, !password.isEmpty, password.count <= 4096 else { throw ImportError.wrongPassword }
        let nonce = String(raw.dropFirst(2).prefix(18))
        guard nonce.utf8.count == 18, nonce.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/").contains($0) }), let cipher = Data(base64Encoded: String(raw.dropFirst(20).filter { !$0.isWhitespace })) else { throw NativeError("The encrypted configuration is malformed.") }
        let iv = Data(nonce.utf8.prefix(16))
        var encodings = [Data(password.utf8)]
        if let ansi = password.data(using: .windowsCP1252), ansi != encodings[0] { encodings.insert(ansi, at: 0) }
        for bytes in encodings {
            let key = Data(SHA512.hash(data: bytes).prefix(32))
            if let plain = try? decryptCFB8(cipher, key: key, iv: iv), let text = decode(plain), text.components(separatedBy: .newlines).contains(where: { $0.trimmingCharacters(in: .whitespaces) == "[ImportExportSpecials]" }), !text.unicodeScalars.contains(where: { $0.value == 0 || ($0.value < 32 && ![9,10,13].contains($0.value)) }) { return text }
        }
        throw ImportError.wrongPassword
    }
    private static func decryptCFB8(_ data: Data, key: Data, iv: Data) throws -> Data {
        var cryptor: CCCryptorRef?
        let status = key.withUnsafeBytes { keyBytes in iv.withUnsafeBytes { ivBytes in
            CCCryptorCreateWithMode(CCOperation(kCCDecrypt), CCMode(kCCModeCFB8), CCAlgorithm(kCCAlgorithmAES128), CCPadding(ccNoPadding), ivBytes.baseAddress, keyBytes.baseAddress, key.count, nil, 0, 0, CCModeOptions(0), &cryptor)
        } }
        guard status == kCCSuccess, let cryptor else { throw ImportError.wrongPassword }
        defer { CCCryptorRelease(cryptor) }
        var output = Data(count: data.count + kCCBlockSizeAES128), used = 0
        let capacity = output.count
        let update = output.withUnsafeMutableBytes { destination in data.withUnsafeBytes { source in
            CCCryptorUpdate(cryptor, source.baseAddress, data.count, destination.baseAddress, capacity, &used)
        } }
        guard update == kCCSuccess else { throw ImportError.wrongPassword }
        var finalCount = 0
        let final = output.withUnsafeMutableBytes { destination in
            CCCryptorFinal(cryptor, destination.baseAddress?.advanced(by: used), capacity - used, &finalCount)
        }
        guard final == kCCSuccess else { throw ImportError.wrongPassword }
        output.count = used + finalCount
        return output
    }
}
