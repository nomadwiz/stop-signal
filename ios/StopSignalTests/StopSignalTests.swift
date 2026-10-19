// One test per acceptance item of #53: the platform envelope, the view model, HailApi's routes and fields,
// the handle, and the design-system tokens. Run with xcodebuild test, as README.md says.
import SwiftUI
import XCTest
@testable import StopSignal

// Answers every request in place of the network and keeps what it was sent: 200 for the outcome stream, 204 with no
// body for the other routes, as packages/hail-service/src/server.ts answers. Each outcome stream sends the next of
// `streams` and ends, as one the network drops does; once they run out, it sends `reply` and stays open, as the
// service's does. Each begins with the replay's end, `: replayed`, as the service's does with nothing to replay; a
// stream that carries its own marker, after the outcomes it replays, is sent as it is.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Request = (method: String, url: URL, body: NSDictionary, timeout: TimeInterval)
    // URLSession loads requests on its own threads, several at once while a hail is armed (#58), so the log is locked.
    private nonisolated(unsafe) static var log: [Request] = []
    private static let lock = NSLock()
    static var requests: [Request] {
        get { lock.withLock { log } }
        set { lock.withLock { log = newValue } }
    }
    nonisolated(unsafe) static var reply = Data()
    private nonisolated(unsafe) static var queue: [Data] = []
    static var streams: [Data] {
        get { lock.withLock { queue } }
        set { lock.withLock { queue = newValue } }
    }
    // Set, every route but the stream answers 500.
    nonisolated(unsafe) static var failing = false
    // Seconds a request to each path takes before the service sees it.
    nonisolated(unsafe) static var delays: [String: TimeInterval] = [:]

    static var session: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        // URLSession hands a protocol the body as a stream, never as httpBody.
        let stream = request.httpBodyStream!
        stream.open()
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable, case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 {
            bytes.append(buffer, count: count)
        }
        stream.close()
        // A delayed request is answered from a timer on this loading thread's run loop, which every request shares, so
        // sleeping here would hold every other request back too.
        guard let delay = Self.delays[request.url!.path] else { return answer(bytes) }
        RunLoop.current.add(Timer(timeInterval: delay, repeats: false) { [bytes] _ in self.answer(bytes) }, forMode: .common)
    }

    private func answer(_ bytes: Data) {
        let body = try! JSONSerialization.jsonObject(with: bytes) as! NSDictionary
        Self.lock.withLock { Self.log.append((request.httpMethod!, request.url!, body, request.timeoutInterval)) }
        let streaming = request.url!.path == "/outcomes"
        let response = HTTPURLResponse(url: request.url!, statusCode: streaming ? 200 : Self.failing ? 500 : 204, httpVersion: nil, headerFields: streaming ? ["content-type": "text/event-stream"] : nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        guard streaming else { return client!.urlProtocolDidFinishLoading(self) }
        let next = Self.lock.withLock { Self.queue.isEmpty ? nil : Self.queue.removeFirst() }
        let sent = next ?? Self.reply
        let replayed = Data(": replayed\n\n".utf8)
        client?.urlProtocol(self, didLoad: sent.range(of: replayed) == nil ? replayed + sent : sent)
        if next != nil { client?.urlProtocolDidFinishLoading(self) }
    }
}

@MainActor
final class StopSignalTests: XCTestCase {
    let handle = "6F9619FF-8B86-4D11-B42D-00C04FC964FF"
    let base = URL(string: "https://hail.test")!

    override func setUp() {
        StubProtocol.requests = []
        StubProtocol.reply = Data()
        StubProtocol.streams = []
        StubProtocol.failing = false
        StubProtocol.delays = [:]
    }

    // m1-revised.md §6.1: iOS 17.0 or later, iPhone, portrait only.
    func testTheAppTargetsIOS17OnIPhoneInPortraitOnly() {
        let info = Bundle.main.infoDictionary!
        XCTAssertEqual(info["MinimumOSVersion"] as? String, "17.0")
        XCTAssertEqual(info["UIDeviceFamily"] as? [Int], [1])
        XCTAssertEqual(info["UISupportedInterfaceOrientations"] as? [String], ["UIInterfaceOrientationPortrait"])
    }

    // ADR-012 decision 2: the view model holds the hail's state and its register and cancel intents, with no UI.
    func testTheViewModelRegistersAndCancelsAHail() async throws {
        let model = HailViewModel(api: HailApi(base: base, handle: handle, session: StubProtocol.session), fixes: FakeFixes(), wait: .zero)
        let stop = Stop.bundled[0]

        try await model.register(stop: stop, route: "70-203", duration: 0)
        XCTAssertEqual(model.registration, HailViewModel.Registration(stop: stop, route: "70-203"))

        try await model.cancel()
        XCTAssertNil(model.registration)
        // Arming also opens the outcome stream (#58), which may or may not have started by the cancel.
        XCTAssertEqual(StubProtocol.requests.map(\.url.path).filter { $0 != "/outcomes" }, ["/register", "/cancel"])
    }

    // ADR-032 decisions 1 and 2, QR8: five routes, each body exactly its wire names and nothing else.
    func testHailApiCallsTheFiveRoutesAndSendsOnlyQR8sFields() async throws {
        StubProtocol.streams = [Data("event: status\ndata: {\"stop\":\"7012\",\"route\":\"70-203\",\"status\":\"sent\"}\n\nevent: outcome\ndata: {\"stop\":\"7012\",\"route\":\"70-203\",\"outcome\":\"cannot-hail\",\"reason\":\"deadline\",\"nextDistanceM\":1200}\n\n".utf8)]
        let api = HailApi(base: base, handle: handle, session: StubProtocol.session)

        try await api.register(stop: "7012", route: "70-203", duration: 120)
        try await api.cancel(stop: "7012", route: "70-203")
        try await api.presenceStart(stop: "7012")
        try await api.presenceEnd(stop: "7012")
        var outcomes: [Outcome] = []
        try await api.outcomes(opened: {}) { outcomes.append($0) }

        XCTAssertEqual(StubProtocol.requests.map { "\($0.method) \($0.url.absoluteString)" }, [
            "POST https://hail.test/register",
            "POST https://hail.test/cancel",
            "POST https://hail.test/presence/start",
            "POST https://hail.test/presence/end",
            "POST https://hail.test/outcomes",
        ])
        XCTAssertEqual(StubProtocol.requests.map(\.body), [
            ["handle": handle, "stop": "7012", "route": "70-203", "duration": 120],
            ["handle": handle, "stop": "7012", "route": "70-203"],
            ["handle": handle, "stop": "7012"],
            ["handle": handle, "stop": "7012"],
            ["handle": handle],
        ])
        // The outcome stream is silent between outcomes, so URLSession's 60 s idle default would close it (ADR-010 decision 3).
        XCTAssertEqual(StubProtocol.requests[4].timeout, TimeInterval(Int32.max))
        XCTAssertEqual(outcomes, [
            Outcome(stop: "7012", route: "70-203", status: "sent"),
            Outcome(stop: "7012", route: "70-203", outcome: "cannot-hail", reason: "deadline", nextDistanceM: 1200),
        ])
    }

    // ADR-032 decision 5: a UUID v4 made once per install, kept on the device, never in a URL.
    func testTheHandleIsOneUUIDv4PerInstallKeptOnTheDeviceAndNeverInAURL() async throws {
        let defaults = UserDefaults(suiteName: #function)!
        defaults.removePersistentDomain(forName: #function)

        let handle = Handle.current(defaults)

        XCTAssertNotNil(handle.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: [.regularExpression, .caseInsensitive]))
        XCTAssertEqual(Handle.current(defaults), handle)
        XCTAssertEqual(defaults.string(forKey: "handle"), handle)
        try await HailApi(base: base, handle: handle, session: StubProtocol.session).register(stop: "7012", route: "70-203", duration: 0)
        XCTAssertFalse(StubProtocol.requests[0].url.absoluteString.localizedCaseInsensitiveContains(handle))
    }

    // #176 acceptance 1: the deployed service over HTTPS (ADR-044, annotated 14-10-2026), unless the launch
    // environment's STOPSIGNAL_BASE_URL names another, as ColdStartTests does for a local service. An empty one is no
    // address, so the app keeps the deployed service rather than crash at launch.
    func testTheAppAddressesTheDeployedServiceUnlessTheLaunchEnvironmentOverridesIt() {
        XCTAssertEqual(HailApi.address([:]), URL(string: "https://52-64-33-196.sslip.io")!)
        XCTAssertEqual(HailApi.address(["STOPSIGNAL_BASE_URL": ""]), URL(string: "https://52-64-33-196.sslip.io")!)
        XCTAssertEqual(HailApi.address(["STOPSIGNAL_BASE_URL": "http://localhost:8080"]), URL(string: "http://localhost:8080")!)
    }

    // ADR-038 decisions 1 and 3: colours, type styles, spacing and target sizes are read from tokens.json.
    func testColoursTypeSpacingAndTargetsComeFromTokensJSON() {
        func hex(_ name: String, _ traits: UITraitCollection) -> String {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            UIColor(Tokens.color(name)).resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            return String(format: "#%02x%02x%02x", Int((red * 255).rounded()), Int((green * 255).rounded()), Int((blue * 255).rounded()))
        }
        let increasedContrast = UITraitCollection { $0.userInterfaceStyle = .light; $0.accessibilityContrast = .high }

        XCTAssertEqual(hex("confirmed", UITraitCollection(userInterfaceStyle: .light)), "#0a58b8")
        XCTAssertEqual(hex("confirmed", UITraitCollection(userInterfaceStyle: .dark)), "#82b6ff")
        XCTAssertEqual(hex("confirmed", increasedContrast), "#a6cdff")
        let routeNumber = Tokens.type("route-number")
        XCTAssertEqual(routeNumber.size, 56)
        XCTAssertEqual(routeNumber.weight, .heavy)
        XCTAssertEqual(routeNumber.design, .rounded)
        XCTAssertEqual(routeNumber.relativeTo, .largeTitle)
        XCTAssertEqual(Tokens.space("space-4"), 16)
        XCTAssertEqual(Tokens.size("target-standard"), 44)
        XCTAssertEqual(Tokens.size("target-primary"), 64)
    }
}
