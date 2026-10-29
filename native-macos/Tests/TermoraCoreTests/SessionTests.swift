import XCTest
@testable import TermoraCore

final class SessionTests: XCTestCase {
    func testSSHUsesArgumentArrayAndStrictHostVerification() throws {
        let session = Session(name: "Fixture", host: "example.invalid", port: 2222, username: "alice", privateKeyPath: "/Users/alice/My Keys/key", gatewayHost: "bastion.invalid", compression: true, x11: true)
        let command = try LaunchCommand.make(for: session, loginShell: "/bin/zsh")
        XCTAssertEqual(command.executable, "/usr/bin/ssh")
        XCTAssertEqual(command.arguments, ["-o", "StrictHostKeyChecking=ask", "-i", "/Users/alice/My Keys/key", "-J", "bastion.invalid", "-C", "-p", "2222", "-l", "alice", "-X", "--", "example.invalid"])
    }
    func testSFTPAndLoginShell() throws {
        let sftp = Session(name: "Files", type: .sftp, host: "::1", port: 2222, username: "alice")
        XCTAssertEqual(Array(try LaunchCommand.make(for: sftp, loginShell: "/bin/zsh").arguments.suffix(4)), ["-P", "2222", "--", "alice@[::1]"])
        XCTAssertEqual(try LaunchCommand.make(for: .local(), loginShell: "/bin/zsh"), LaunchCommand(executable: "/bin/zsh", arguments: ["-l"]))
    }
    func testRejectsInvalidHostsPortsAndControlCharacters() {
        for host in ["", "-oProxyCommand=bad", "a b", "a\nb", "a/b", "a\\b", "a;b", "$(touch)"] { XCTAssertThrowsError(try Session(host: host).validate()) }
        XCTAssertThrowsError(try Session(host: "example.invalid", port: 0).validate())
        XCTAssertThrowsError(try Session(host: "example.invalid", username: "a\nb").validate())
    }
    func testJSONImportDiscardsSecretsAndCountsUnsupportedEntries() throws {
        let input = Data(#"{"sessions":[{"type":"ssh","host":"example.invalid","name":"Fixture","password":"PRIVATE"},{"type":"s3","host":"bucket"}]}"#.utf8)
        let result = try SessionImporter.parse(input)
        XCTAssertEqual(result.sessions.count, 1); XCTAssertEqual(result.skipped, 1)
        XCTAssertFalse(String(decoding: try SessionImporter.export(result.sessions), as: UTF8.self).contains("PRIVATE"))
    }
    func testEncryptedMobaFixture() throws {
        let file = try XCTUnwrap(Bundle.module.url(forResource: "encrypted-config", withExtension: "mobaconf", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: file)
        XCTAssertThrowsError(try SessionImporter.parse(data))
        XCTAssertThrowsError(try SessionImporter.parse(data, password: "wrong"))
        let result = try SessionImporter.parse(data, password: "fixture-password")
        XCTAssertEqual(result.sessions.first?.host, "example.invalid")
        XCTAssertEqual(result.sessions.first?.port, 2222)
        XCTAssertEqual(result.sessions.first?.folder, "Lab")
        XCTAssertFalse(String(decoding: try SessionImporter.export(result.sessions), as: UTF8.self).contains("VAULT_SECRET"))
    }
    func testStoreAppendDoesNotOverwriteExistingIDs() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("termora-native-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try SessionStore(directory: directory)
        let session = Session(id: "duplicate", name: "Fixture", host: "example.invalid")
        try store.save(session); try store.append([session])
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertNotEqual(store.sessions[0].id, store.sessions[1].id)
        XCTAssertEqual(try SessionStore(directory: directory).sessions.count, 2)
    }
}
