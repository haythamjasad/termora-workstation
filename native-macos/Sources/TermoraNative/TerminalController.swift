import AppKit
import SwiftTerm
import TermoraCore
import Darwin

final class TerminalController: NSViewController, LocalProcessTerminalViewDelegate {
    let session: Session
    let terminal = LocalProcessTerminalView(frame: .zero)
    private(set) var running = false
    private var started = false
    var titleChanged: ((String) -> Void)?
    var statusChanged: ((String) -> Void)?
    init(session: Session) { self.session = session; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Not supported") }
    override func loadView() {
        view = NSView(); view.addSubview(terminal); terminal.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([terminal.leadingAnchor.constraint(equalTo: view.leadingAnchor), terminal.trailingAnchor.constraint(equalTo: view.trailingAnchor), terminal.topAnchor.constraint(equalTo: view.topAnchor), terminal.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        terminal.processDelegate = self; updateAppearance()
    }
    override func viewDidAppear() {
        super.viewDidAppear()
        if !started { started = true; launch() }
        view.window?.makeFirstResponder(terminal)
    }
    func updateAppearance() {
        terminal.font = .monospacedSystemFont(ofSize: NativePreferences.fontSize, weight: .regular)
        terminal.configureNativeColors()
    }
    private func launch() {
        do {
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? getpwuid(getuid()).flatMap { $0.pointee.pw_shell }.map { String(cString: $0) } ?? "/bin/zsh"
            let command: LaunchCommand
            if CommandLine.arguments.contains("--smoke-test"), session.type == .local {
                command = LaunchCommand(executable: "/bin/sh", arguments: [], directory: ProcessInfo.processInfo.environment["TERMORA_NATIVE_SMOKE_DATA"])
            } else { command = try LaunchCommand.make(for: session, loginShell: shell) }
            guard FileManager.default.isExecutableFile(atPath: command.executable) else { throw NativeError("The command is unavailable: \(command.executable)") }
            let directory = command.directory ?? FileManager.default.homeDirectoryForCurrentUser.path
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory), isDirectory.boolValue else { throw NativeError("The starting directory does not exist.") }
            var environment = ProcessInfo.processInfo.environment
            environment["TERM"] = "xterm-256color"; environment["COLORTERM"] = "truecolor"
            environment["LANG"] = environment["LANG"] ?? "en_US.UTF-8"
            terminal.startProcess(executable: command.executable, args: command.arguments, environment: environment.map { "\($0.key)=\($0.value)" }, currentDirectory: directory)
            running = true; statusChanged?(session.type.title)
        } catch {
            terminal.feed(text: "\r\n\(error.localizedDescription)\r\n"); statusChanged?("Could not start")
        }
    }
    func stop() { if running { terminal.terminate(); running = false } }
    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) { statusChanged?("\(newCols) × \(newRows)") }
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) { titleChanged?(String(title.filter { !$0.isNewline }.prefix(100))) }
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) { if let directory { statusChanged?(directory) } }
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        running = false
        let message = "Session ended (\(exitCode.map { String($0) } ?? "unknown"))"
        terminal.feed(text: "\r\n\(message)\r\n"); statusChanged?(message)
    }
}
