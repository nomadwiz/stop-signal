// One test per acceptance item of #58: presence sensed in the armed session and reported as transitions. The phone's
// fixes come from FakeFixes, so no test needs Core Location's updates (ADR-012); the device checks are in the pull
// request that built this.
import CoreLocation
import XCTest
@testable import StopSignal

// The phone's fixes, as the test sends them. `closed` turns true when the view model drops the stream, which is when
// DeviceFixes ends its background activity session.
final class FakeFixes: Fixes, @unchecked Sendable {
    let (stream, feed) = AsyncStream.makeStream(of: Fix.self)
    nonisolated(unsafe) var closed = false

    func open() -> AsyncStream<Fix> {
        feed.onTermination = { _ in self.closed = true }
        return stream
    }

    // A fix `metres` due north of `stop`.
    func send(_ metres: Double, from stop: Stop, accuracy: Double = 5, stationary: Bool = false) {
        let at = CLLocationCoordinate2D(latitude: stop.lat + metres / 111_000, longitude: stop.lon)
        feed.yield(Fix(location: CLLocation(coordinate: at, altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: .now), stationary: stationary))
    }
}

@MainActor
final class PresenceTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!
    let fixes = FakeFixes()
    lazy var model = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes)

    override func setUp() {
        StubProtocol.requests = []
        StubProtocol.reply = Data()
        StubProtocol.streams = []
        StubProtocol.failing = false
        StubProtocol.delays = [:]
    }

    // Closes the armed session, so no test's session outlives it.
    override func tearDown() async throws {
        try await model.cancel()
    }

    var presence: [String] {
        StubProtocol.requests.map(\.url.path).filter { $0.hasPrefix("/presence") }
    }

    func outcome(_ outcome: String) -> String {
        "event: outcome\ndata: {\"stop\":\"7177-4660a5ff\",\"route\":\"70-205\",\"outcome\":\"\(outcome)\"}\n\n"
    }

    // #58 acceptance 1, with ADR-045's rule: arriving within 50 m sends presence/start and leaving beyond 100 m sends
    // presence/end, each with the handle and stop alone, so no device time (ADR-031 decision 2; ADR-032 decision 1). A
    // fix between the two radii, one less accurate than 50 m or of unknown accuracy, and one taken while the phone is
    // stationary each change nothing. A new session's first fix outside the gap reports either way.
    func testArrivingSendsPresenceStartAndLeavingSendsPresenceEndWithNoDeviceTime() async throws {
        func present(_ metres: Double, accuracy: Double = 5, stationary: Bool = false, was: Bool?) -> Bool? {
            let at = CLLocationCoordinate2D(latitude: melrose.lat + metres / 111_000, longitude: melrose.lon)
            let fix = Fix(location: CLLocation(coordinate: at, altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: .now), stationary: stationary)
            return fix.present(at: melrose.location, was: was)
        }
        XCTAssertEqual(present(49, was: false), true)
        XCTAssertEqual(present(52, was: false), false)
        XCTAssertEqual(present(99, was: true), true)
        XCTAssertEqual(present(102, was: true), false)
        XCTAssertEqual(present(10, accuracy: 51, was: false), false)
        XCTAssertEqual(present(10, accuracy: -1, was: false), false)
        XCTAssertEqual(present(10, accuracy: 50, was: false), true)
        XCTAssertEqual(present(200, stationary: true, was: true), true)
        XCTAssertEqual(present(200, was: nil), false)
        XCTAssertEqual(present(75, was: nil), nil)

        fixes.send(130, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(40, from: melrose)
        fixes.send(130, from: melrose)
        try await until { [self] in presence.count == 3 }
        let sent = StubProtocol.requests.filter { $0.url.path.hasPrefix("/presence") }
        XCTAssertEqual(sent.map(\.url.path), ["/presence/end", "/presence/start", "/presence/end"])
        XCTAssertEqual(sent.map(\.body), Array(repeating: ["handle": "h", "stop": melrose.id], count: 3))
    }

    // The owner's decision of 12-10-2026 (ADR-045 decision 5): arming reports the session's first fix accurate to 50 m,
    // stationary or not, before Register, so a new hail never commits on an arrival held from an earlier session.
    func testAFirstFixBeyond100mSendsPresenceEndBeforeRegister() async throws {
        fixes.send(200, from: melrose, stationary: true)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        XCTAssertEqual(StubProtocol.requests.map(\.url.path).filter { $0 != "/outcomes" }, ["/presence/end", "/register"])
    }

    // ADR-045 decision 5: once a decisive fix has arrived within the wait, Register waits for its report to reach the
    // service, however long that takes.
    func testADecisiveFixWithinTheWaitHoldsRegisterUntilItsReportArrives() async throws {
        StubProtocol.delays = ["/presence/end": 0.6]
        let slow = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes, wait: .milliseconds(200))
        fixes.send(200, from: melrose)
        try await slow.register(stop: melrose, route: "70-205", duration: 0)
        XCTAssertEqual(StubProtocol.requests.map(\.url.path).filter { $0 != "/outcomes" }, ["/presence/end", "/register"])
        try await slow.cancel()
    }

    // ADR-045 decision 5, decided 12-10-2026: a first fix between 50 and 100 m is not decisive, so arming waits on for a
    // decisive fix, or for the wait to end, before Register.
    func testAFirstFixBetween50And100mHoldsRegisterUntilADecisiveFix() async throws {
        fixes.send(75, from: melrose)
        let arming = Task { try await model.register(stop: melrose, route: "70-205", duration: 0) }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(StubProtocol.requests.map(\.url.path), [])
        fixes.send(200, from: melrose)
        try await arming.value
        XCTAssertEqual(StubProtocol.requests.map(\.url.path).filter { $0 != "/outcomes" }, ["/presence/end", "/register"])
    }

    // #58 acceptance 2 and T9 (#71): no coordinate leaves the device. Every request through an armed session carries in
    // its body only QR8's handle, stop, route and duration, each with exactly the value the test gave, never one derived
    // from a fix, and none has a query. The outcome stream may not have started by the cancel, so its body may be absent.
    func testNoCoordinateLeavesTheDevice() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(200, from: melrose)
        try await until { [self] in presence.count == 2 }
        try await model.cancel()

        XCTAssertEqual(StubProtocol.requests.map(\.url.path).filter { $0 != "/outcomes" }, ["/presence/start", "/register", "/presence/end", "/cancel"])
        XCTAssertTrue(Set(StubProtocol.requests.map(\.body)).isSubset(of: [
            ["handle": "h"],
            ["handle": "h", "stop": melrose.id],
            ["handle": "h", "stop": melrose.id, "route": "70-205"],
            ["handle": "h", "stop": melrose.id, "route": "70-205", "duration": 0],
        ]), "\(StubProtocol.requests.map(\.body))")
        for request in StubProtocol.requests { XCTAssertNil(request.url.query, request.url.path) }
    }

    // #58 acceptance 3, as the owner decided on 11-10-2026: the session stays open through confirmed and unacknowledged,
    // and closes on cancel, on cannot-hail, or on a departure after a delivered hail, which sends presence/end.
    func testTheSessionClosesOnCancelOnCannotHailOrOnADepartureAfterADeliveredHail() async throws {
        StubProtocol.reply = Data(("event: status\ndata: {\"stop\":\"7177-4660a5ff\",\"route\":\"70-205\",\"status\":\"sent\"}\n\n" + outcome("confirmed") + outcome("unacknowledged")).utf8)
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        try await until { [self] in model.present == true && model.outcome?.outcome == "unacknowledged" }
        XCTAssertTrue(model.delivered)
        XCTAssertFalse(fixes.closed)
        fixes.send(200, from: melrose)
        try await until { [self] in fixes.closed }
        XCTAssertEqual(presence, ["/presence/start", "/presence/end"])

        // The next three sessions send no fix, so arming waits for none.
        StubProtocol.reply = Data(outcome("cannot-hail").utf8)
        let cannot = FakeFixes()
        let other = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: cannot, wait: .zero)
        try await other.register(stop: melrose, route: "70-205", duration: 0)
        try await until { cannot.closed }

        StubProtocol.reply = Data()
        let cancelled = FakeFixes()
        let third = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: cancelled, wait: .zero)
        try await third.register(stop: melrose, route: "70-205", duration: 0)
        try await third.cancel()
        try await until { cancelled.closed }

        // The session opens before the registration's round trip (ADR-009, annotated 02-10-2026), so a failed one
        // closes it.
        StubProtocol.failing = true
        let failed = FakeFixes()
        let fourth = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: failed, wait: .zero)
        do { try await fourth.register(stop: melrose, route: "70-205", duration: 0) } catch {}
        XCTAssertNil(fourth.registration)
        try await until { failed.closed }
        StubProtocol.failing = false
    }

    // #58 acceptance 4: with nothing delivered, a departure keeps the session open, and a return to the stop sends
    // presence/start again (ADR-040 decisions 1 and 2).
    func testADepartureWithNothingDeliveredKeepsTheSessionOpenAndAReturnSendsPresenceStartAgain() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(200, from: melrose)
        fixes.send(10, from: melrose)

        try await until { [self] in presence.count == 3 }
        XCTAssertEqual(presence, ["/presence/start", "/presence/end", "/presence/start"])
        XCTAssertFalse(fixes.closed)
        XCTAssertEqual(model.present, true)
    }

    // #58 acceptance 5, the part the simulator can prove (the owner's decision of 11-10-2026): the app declares the
    // Location updates background mode a CLBackgroundActivitySession needs, asks When In Use only, and says why.
    func testTheAppDeclaresLocationUpdatesInTheBackgroundUnderWhenInUseOnly() {
        let info = Bundle.main.infoDictionary!
        XCTAssertEqual(info["UIBackgroundModes"] as? [String], ["location"])
        XCTAssertEqual(info["NSLocationWhenInUseUsageDescription"] as? String, "StopSignal uses your location to list the stops nearest you first and, while a hail is armed, to tell when you're at the stop. It stays on your phone.")
        XCTAssertNil(info["NSLocationAlwaysAndWhenInUseUsageDescription"])
    }
}
