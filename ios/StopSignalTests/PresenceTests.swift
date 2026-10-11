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
    }

    // Waits up to 2 s for `done`, and fails if it never comes.
    func until(line: UInt = #line, _ done: @escaping () -> Bool) async throws {
        var tries = 0
        while !done(), tries < 100 {
            tries += 1
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertLessThan(tries, 100, line: line)
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
    // stationary each change nothing.
    func testArrivingSendsPresenceStartAndLeavingSendsPresenceEndWithNoDeviceTime() async throws {
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(70, from: melrose)
        fixes.send(40, from: melrose, accuracy: 80)
        fixes.send(40, from: melrose, stationary: true)
        fixes.send(40, from: melrose)
        fixes.send(90, from: melrose)
        fixes.send(130, from: melrose, accuracy: -1)
        fixes.send(130, from: melrose, stationary: true)
        fixes.send(130, from: melrose)

        try await until { [self] in presence.count == 2 }
        let sent = StubProtocol.requests.filter { $0.url.path.hasPrefix("/presence") }
        XCTAssertEqual(sent.map(\.url.path), ["/presence/start", "/presence/end"])
        XCTAssertEqual(sent.map(\.body), [["handle": "h", "stop": melrose.id], ["handle": "h", "stop": melrose.id]])
        XCTAssertFalse(model.present)
    }

    // #58 acceptance 2: no coordinate leaves the device. Every request through an armed session carries only QR8's
    // handle, stop, route and duration, in its body, and none has a query.
    func testNoCoordinateLeavesTheDevice() async throws {
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(10, from: melrose)
        fixes.send(200, from: melrose)
        try await until { [self] in presence.count == 2 }
        try await model.cancel()

        XCTAssertEqual(Set(StubProtocol.requests.map(\.url.path)), ["/register", "/outcomes", "/presence/start", "/presence/end", "/cancel"])
        for request in StubProtocol.requests {
            XCTAssertTrue(Set(request.body.allKeys as! [String]).isSubset(of: ["handle", "stop", "route", "duration"]), request.url.path)
            XCTAssertNil(request.url.query, request.url.path)
        }
    }

    // #58 acceptance 3, as the owner decided on 11-10-2026: the session stays open through confirmed and unacknowledged,
    // and closes on cancel, on cannot-hail, or on a departure after a delivered hail, which sends presence/end.
    func testTheSessionClosesOnCancelOnCannotHailOrOnADepartureAfterADeliveredHail() async throws {
        StubProtocol.reply = Data(("event: status\ndata: {\"stop\":\"7177-4660a5ff\",\"route\":\"70-205\",\"status\":\"sent\"}\n\n" + outcome("confirmed") + outcome("unacknowledged")).utf8)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(10, from: melrose)
        try await until { [self] in model.present && model.outcome?.outcome == "unacknowledged" }
        XCTAssertTrue(model.delivered)
        XCTAssertFalse(fixes.closed)
        fixes.send(200, from: melrose)
        try await until { [self] in fixes.closed }
        XCTAssertEqual(presence, ["/presence/start", "/presence/end"])

        StubProtocol.reply = Data(outcome("cannot-hail").utf8)
        let cannot = FakeFixes()
        let other = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: cannot)
        try await other.register(stop: melrose, route: "70-205", duration: 0)
        try await until { cannot.closed }

        StubProtocol.reply = Data()
        let cancelled = FakeFixes()
        let third = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: cancelled)
        try await third.register(stop: melrose, route: "70-205", duration: 0)
        try await third.cancel()
        try await until { cancelled.closed }
    }

    // #58 acceptance 4: with nothing delivered, a departure keeps the session open, and a return to the stop sends
    // presence/start again (ADR-040 decisions 1 and 2).
    func testADepartureWithNothingDeliveredKeepsTheSessionOpenAndAReturnSendsPresenceStartAgain() async throws {
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        fixes.send(10, from: melrose)
        fixes.send(200, from: melrose)
        fixes.send(10, from: melrose)

        try await until { [self] in presence.count == 3 }
        XCTAssertEqual(presence, ["/presence/start", "/presence/end", "/presence/start"])
        XCTAssertFalse(fixes.closed)
        XCTAssertTrue(model.present)
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
