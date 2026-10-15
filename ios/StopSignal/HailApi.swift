// The client for HailApi's five routes (ADR-032 decision 1), as packages/hail-service/src/server.ts serves them.
// Each body carries the wire names `handle`, `stop`, `route` and `duration` and nothing else: QR8 lets only a stop,
// a route, a duration and an opaque handle leave the device, and the server rejects any other key.
import Foundation

@MainActor
struct HailApi {
    let base: URL
    let handle: String
    var session = URLSession.shared

    // The deployed service, behind Caddy over HTTPS (ADR-044, annotated 14-10-2026). STOPSIGNAL_BASE_URL in the launch
    // environment overrides it, so the simulator and ColdStartTests reach a service running locally.
    static func address(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        URL(string: environment["STOPSIGNAL_BASE_URL"] ?? "https://52-64-33-196.sslip.io")!
    }

    func register(stop: String, route: String, duration: Int) async throws {
        try await post("register", ["handle": handle, "stop": stop, "route": route, "duration": duration])
    }

    func cancel(stop: String, route: String) async throws {
        try await post("cancel", ["handle": handle, "stop": stop, "route": route])
    }

    func presenceStart(stop: String) async throws {
        try await post("presence/start", ["handle": handle, "stop": stop])
    }

    func presenceEnd(stop: String) async throws {
        try await post("presence/end", ["handle": handle, "stop": stop])
    }

    // Holds the outcome stream open and hands each event to `receive` until the stream ends. The server sends each as
    // `event: outcome` or `event: status` with one `data:` line; closing the last stream is the passenger's connection
    // lost. It opens with the outcomes it replays, then `: replayed`, and `opened` is awaited only once that line is
    // read, so a reopen never registers a hail whose outcome is still on its way (#168; the owner's decision 41 of
    // 13-10-2026).
    // After the replay the stream is silent until an outcome, so it takes no practical idle timeout: URLSession's default 60 s would
    // close it on any longer wait, and the service would mark that passenger Unattended (ADR-010 decision 3).
    func outcomes(opened: () async -> Void, _ receive: (Outcome) -> Void) async throws {
        var stream = try request("outcomes", ["handle": handle])
        stream.timeoutInterval = TimeInterval(Int32.max)
        let (lines, response) = try await session.bytes(for: stream)
        try check(response)
        for try await line in lines.lines {
            if line == ": replayed" { await opened() }
            if line.hasPrefix("data:") { receive(try JSONDecoder().decode(Outcome.self, from: Data(line.dropFirst(5).utf8))) }
        }
    }

    private func post(_ path: String, _ body: [String: Any]) async throws {
        try check(try await session.data(for: request(path, body)).1)
    }

    // The handle goes in the body only, never the URL, so no access log holds it (ADR-032 decision 5).
    private func request(_ path: String, _ body: [String: Any]) throws -> URLRequest {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    private func check(_ response: URLResponse) throws {
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw URLError(.badServerResponse)
        }
    }
}

// One event on the outcome stream. An outcome event carries `outcome` (ADR-032 decision 3): `reason` comes with
// cannot-hail only, and `nextDistanceM` with a `deadline` abandonment only, null when the feed shows no next bus
// (annotated 09-10-2026). A status event carries `status` instead: waiting, sent, moved or stale (annotated 11-10-2026).
struct Outcome: Decodable, Equatable {
    let stop: String
    let route: String
    var outcome: String?
    var reason: String?
    var nextDistanceM: Double?
    var status: String?
}

// ADR-032 decision 5: a UUID v4 the device makes once per install, and whose possession authorises. It is kept in the
// app's own defaults, which iOS deletes with the app, so a reinstall makes a new one; the Keychain would outlive it.
enum Handle {
    static func current(_ defaults: UserDefaults = .standard) -> String {
        if let saved = defaults.string(forKey: "handle") { return saved }
        let made = UUID().uuidString
        defaults.set(made, forKey: "handle")
        return made
    }
}
