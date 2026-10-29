import Foundation

public final class SessionStore {
    public let fileURL: URL
    public private(set) var sessions: [Session] = []
    public init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        fileURL = directory.appendingPathComponent("sessions.json")
        if FileManager.default.fileExists(atPath: fileURL.path) {
            sessions = try JSONDecoder().decode([Session].self, from: Data(contentsOf: fileURL))
        }
    }
    public func save(_ session: Session) throws {
        try session.validate()
        var next = sessions.filter { $0.id != session.id }; next.append(session)
        try commit(next)
    }
    public func remove(id: String) throws { try commit(sessions.filter { $0.id != id }) }
    public func append(_ imported: [Session]) throws {
        var next = sessions, ids = Set(sessions.map(\.id))
        for var session in imported {
            try session.validate()
            if ids.contains(session.id) { session.id = UUID().uuidString }
            ids.insert(session.id); next.append(session)
        }
        try commit(next)
    }
    private func commit(_ next: [Session]) throws {
        guard next.count <= 10_000 else { throw NativeError("The session limit is 10,000.") }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(next).write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        sessions = next
    }
}
