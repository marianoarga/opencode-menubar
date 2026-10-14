import AppKit
import Foundation
import Darwin

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
}

struct SessionSnapshot: Decodable {
    let state: Activity
}

struct Snapshot: Decodable {
    let version: Int
    let pid: Int32
    let updatedAt: Double
    let sessions: [SessionSnapshot]
}

struct Status: Encodable {
    let state: Activity
    let connected: Bool
}

let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/OpenCode Menu Bar")
let statesDirectory = supportDirectory.appendingPathComponent("states")

func readStatus(in directory: URL) -> Status {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    let now = Date().timeIntervalSince1970
    var connected = false
    var state = Activity.idle
    for file in files where file.pathExtension == "json" {
        guard let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
              snapshot.version == 1, snapshot.pid > 0 else { continue }
        let age = now - snapshot.updatedAt
        guard age >= -5, age < 30,
              kill(snapshot.pid, 0) == 0 || errno == EPERM else { continue }
        connected = true
        for session in snapshot.sessions {
            if session.state == .attention { state = .attention }
            else if session.state == .working && state == .idle { state = .working }
        }
    }
    return Status(state: state, connected: connected)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private let titleItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let detailItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let connectionItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
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
        menu.addItem(titleItem)
        menu.addItem(detailItem)
        menu.addItem(connectionItem)
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
    }

    @objc private func update() {
        let status = readStatus(in: statesDirectory)
        activity = status.state
        titleItem.title = activity.title
        detailItem.title = activity.detail
        connectionItem.title = status.connected ? "Integración conectada" : "Sin instancias conectadas · Iniciá OpenCode"
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
