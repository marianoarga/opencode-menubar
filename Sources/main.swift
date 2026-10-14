import AppKit
import Foundation
import Darwin
import SQLite3

enum Activity: String, Codable {
    case idle, working, attention

    var title: String {
        switch self {
        case .idle: return "OpenCode · En reposo"
        case .working: return "OpenCode · Trabajando"
        case .attention: return "OpenCode · Requiere atención"
        }
    }

    var detail: String {
        switch self {
        case .idle: return "Todas las sesiones están en reposo."
        case .working: return "Hay actividad en OpenCode."
        case .attention: return "OpenCode espera una respuesta o un permiso."
        }
    }

    var priority: Int {
        switch self {
        case .idle: return 0
        case .working: return 1
        case .attention: return 2
        }
    }
}

struct SessionSnapshot: Decodable {
    let id: String?
    let title: String?
    let state: Activity
    let startedAt: Double?
    let stateSince: Double?
}

struct Snapshot: Decodable {
    let version: Int
    let pid: Int32
    let updatedAt: Double
    let project: String?
    let sessions: [SessionSnapshot]
}

struct ConnectedSession: Encodable {
    let id: String
    let title: String
    let project: String?
    let state: Activity
    let startedAt: Double?
    let stateSince: Double?
    let elapsedSeconds: Int?
    let statusText: String
}

struct Status: Encodable {
    let state: Activity
    let connected: Bool
    let sessions: [ConnectedSession]
}

func duration(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds) s" }
    if seconds < 3600 { return "\(seconds / 60) min \(seconds % 60) s" }
    return "\(seconds / 3600) h \((seconds % 3600) / 60) min"
}

// Read only the names of already-connected sessions. This also resolves titles
// for instances still running the older plugin, without loading session history.
final class SessionTitleStore {
    private let path: String
    private var cache: [String: (title: String?, expiresAt: Double)] = [:]

    init() {
        let environment = ProcessInfo.processInfo.environment
        let dataHome = environment["XDG_DATA_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share").path
        path = environment["OPENCODE_MENUBAR_DATABASE"] ?? URL(fileURLWithPath: dataHome)
            .appendingPathComponent("opencode/opencode.db").path
    }

    func title(for id: String, now: Double) -> String? {
        if let value = cache[id], value.expiresAt > now { return value.title }
        let title = readTitle(id)
        if cache.count > 512 { cache.removeAll() }
        cache[id] = (title, now + 2)
        return title
    }

    private func readTitle(_ id: String) -> String? {
        var database: OpaquePointer?
        let result = sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil)
        defer { if let database = database { sqlite3_close(database) } }
        guard result == SQLITE_OK, let database = database else { return nil }
        sqlite3_busy_timeout(database, 25)
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, "SELECT title FROM session WHERE id = ? LIMIT 1", -1, &statement, nil) == SQLITE_OK,
              let statement = statement else { return nil }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, id, -1, transient) == SQLITE_OK,
              sqlite3_step(statement) == SQLITE_ROW,
              let text = sqlite3_column_text(statement, 0) else { return nil }
        let title = String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : title
    }
}

let sessionTitles = SessionTitleStore()

func sessionDetail(_ session: SessionSnapshot, id: String, project: String?, now: Double) -> ConnectedSession {
    let since = session.state == .working ? session.startedAt : session.stateSince
    let elapsed = since.flatMap { value -> Int? in
        guard value.isFinite, value > 0, value <= now else { return nil }
        return Int(min(now - value, Double(Int32.max)))
    }
    let label: String
    switch session.state {
    case .idle: label = "En reposo"
    case .working: label = "Trabajando"
    case .attention: label = "Requiere atención"
    }
    let statusText = elapsed.map { "\(label) · hace \(duration($0))" } ?? label
    let title = sessionTitles.title(for: id, now: now) ?? session.title?.trimmingCharacters(in: .whitespacesAndNewlines)
    return ConnectedSession(id: id, title: title?.isEmpty == false ? title! : "Cargando nombre de la sesión…",
                            project: project, state: session.state, startedAt: session.startedAt,
                            stateSince: session.stateSince, elapsedSeconds: elapsed, statusText: statusText)
}

let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/OpenCode Menu Bar")
let statesDirectory = supportDirectory.appendingPathComponent("states")

func readStatus(in directory: URL) -> Status {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let now = Date().timeIntervalSince1970
    var connected = false
    var state = Activity.idle
    var entries: [String: (session: SessionSnapshot, project: String?, updatedAt: Double)] = [:]
    for file in files where file.pathExtension == "json" {
        guard let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.version == 1, snapshot.pid > 0 else { continue }
        let age = now - snapshot.updatedAt
        guard age >= -5, age < 30,
              kill(snapshot.pid, 0) == 0 || errno == EPERM else { continue }
        connected = true
        for (index, session) in snapshot.sessions.enumerated() {
            if session.state == .attention { state = .attention }
            else if session.state == .working && state == .idle { state = .working }
            // Session IDs are global. Multiple instances observing the same
            // session share one row; active states take priority over stale idle.
            let id = session.id ?? "\(file.lastPathComponent)-\(index)"
            if let existing = entries[id],
               existing.session.state.priority > session.state.priority ||
               (existing.session.state == session.state && existing.updatedAt > snapshot.updatedAt) { continue }
            entries[id] = (session, snapshot.project, snapshot.updatedAt)
        }
    }
    let sessions = entries.map { id, entry in
        sessionDetail(entry.session, id: id, project: entry.project, now: now)
    }.sorted { first, second in
        if first.state != second.state { return first.state.priority > second.state.priority }
        if first.title != second.title { return first.title.localizedStandardCompare(second.title) == .orderedAscending }
        return first.id < second.id
    }
    return Status(state: state, connected: connected, sessions: sessions)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private let titleItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let detailItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let connectionItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let sessionsHeader = NSMenuItem(title: "Sesiones conectadas", action: nil, keyEquivalent: "")
    private let emptySessionsItem = NSMenuItem(title: "Sin sesiones observadas todavía", action: nil, keyEquivalent: "")
    private var sessionOrder: [String] = []
    private var sessionItems: [String: (name: NSMenuItem, detail: NSMenuItem)] = [:]
    private var activity = Activity.idle
    private var phase = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier).count > 1 {
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(titleItem)
        menu.addItem(detailItem)
        menu.addItem(connectionItem)
        menu.addItem(.separator())
        menu.addItem(sessionsHeader)
        menu.addItem(emptySessionsItem)
        menu.addItem(.separator())
        let folder = NSMenuItem(title: "Abrir carpeta de integración", action: #selector(openFolder), keyEquivalent: "")
        folder.target = self
        menu.addItem(folder)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Salir de OpenCode Menu Bar", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
        update()
        timer = Timer(timeInterval: 0.25, target: self, selector: #selector(update), userInfo: nil, repeats: true)
        RunLoop.main.add(timer!, forMode: .common)
        RunLoop.main.add(timer!, forMode: .eventTracking)
    }

    func menuWillOpen(_ menu: NSMenu) {
        update()
    }

    private func updateSessions(_ sessions: [ConnectedSession]) {
        guard let menu = statusItem.menu else { return }
        sessionsHeader.title = "Sesiones conectadas (\(sessions.count))"
        let order = sessions.map(\.id)
        if order != sessionOrder {
            for items in sessionItems.values {
                menu.removeItem(items.name)
                menu.removeItem(items.detail)
            }
            sessionItems.removeAll()
            sessionOrder = order
            var index = menu.index(of: sessionsHeader) + 1
            for session in sessions {
                let name = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                let detail = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                detail.indentationLevel = 1
                menu.insertItem(name, at: index)
                menu.insertItem(detail, at: index + 1)
                sessionItems[session.id] = (name, detail)
                index += 2
            }
        }
        emptySessionsItem.isHidden = !sessions.isEmpty
        for session in sessions {
            guard let items = sessionItems[session.id] else { continue }
            let fullName = session.title
            let name = fullName.count > 64 ? String(fullName.prefix(61)) + "…" : fullName
            items.name.attributedTitle = NSAttributedString(string: name, attributes: [
                .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.labelColor,
            ])
            items.name.toolTip = session.project.map { "\(fullName)\nProyecto: \($0)" } ?? fullName
            let color: NSColor
            switch session.state {
            case .idle: color = .secondaryLabelColor
            case .working: color = .systemBlue
            case .attention: color = .systemOrange
            }
            let detail = session.project.map { "\(session.statusText) · \($0)" } ?? session.statusText
            items.detail.attributedTitle = NSAttributedString(string: detail, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), .foregroundColor: color,
            ])
        }
    }

    @objc private func update() {
        let status = readStatus(in: statesDirectory)
        activity = status.state
        titleItem.title = activity.title
        detailItem.title = activity.detail
        connectionItem.title = status.connected ? "Integración conectada" : "Sin instancias conectadas · Iniciá OpenCode"
        updateSessions(status.sessions)
        statusItem.button?.toolTip = "\(activity.title)\n\(activity.detail)"
        statusItem.button?.setAccessibilityLabel(activity.title)
        statusItem.button?.image = icon(for: activity)
        phase = (phase + 1) % 8
        // A local diagnostic lets installation checks inspect the app's own state.
        if let data = try? JSONEncoder().encode(status) {
            let path = supportDirectory.appendingPathComponent("app-status.json")
            if (try? Data(contentsOf: path)) != data {
                try? data.write(to: path, options: .atomic)
            }
        }
    }

    private func icon(for state: Activity) -> NSImage {
        // Capture the frame so each NSImage keeps its own animation phase.
        let pulse = CGFloat((sin(Double(phase) * .pi / 4) + 1) / 2)
        let image = NSImage(size: NSSize(width: 20, height: 20), flipped: false) { _ in
            let color: NSColor
            let opacity: CGFloat
            let interiorOpacity: CGFloat
            switch state {
            case .idle:
                color = .black
                opacity = 1
                interiorOpacity = 0.35
            case .working:
                color = .systemBlue
                opacity = 0.65 + 0.35 * pulse
                interiorOpacity = 0.25 + 0.30 * pulse
            case .attention:
                color = .systemOrange
                opacity = 1
                interiorOpacity = 0.45
            }

            // Official OpenCode glyph from https://opencode.ai/favicon.svg.
            // Scale its 256 × 320 mark to 12.8 × 16 points, retaining the
            // rectangular opening and shaded lower block without a background.
            color.withAlphaComponent(opacity).setFill()
            let outline = NSBezierPath(rect: NSRect(x: 3.6, y: 2, width: 12.8, height: 16))
            outline.appendRect(NSRect(x: 6.8, y: 5.2, width: 6.4, height: 9.6))
            outline.windingRule = .evenOdd
            outline.fill()
            color.withAlphaComponent(interiorOpacity).setFill()
            NSBezierPath(rect: NSRect(x: 6.8, y: 5.2, width: 6.4, height: 6.4)).fill()
            return true
        }
        image.isTemplate = state == .idle
        return image
    }

    @objc private func openFolder() {
        NSWorkspace.shared.open(supportDirectory)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        try? FileManager.default.removeItem(at: supportDirectory.appendingPathComponent("app-status.json"))
    }
}

if CommandLine.arguments.contains("--status") {
    let arguments = CommandLine.arguments
    let index = arguments.firstIndex(of: "--status")!
    let directory = arguments.count > index + 1 ? URL(fileURLWithPath: arguments[index + 1]) : statesDirectory
    let data = try JSONEncoder().encode(readStatus(in: directory))
    print(String(decoding: data, as: UTF8.self))
} else {
    try? FileManager.default.createDirectory(at: statesDirectory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
