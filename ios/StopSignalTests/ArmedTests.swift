// One test per acceptance item of #55, the Armed screen. The screens are read through the accessibility tree, the
// phone's fixes come from FakeFixes and the service from StubProtocol; the device checks are in the pull request.
import SwiftUI
import XCTest
@testable import StopSignal

@MainActor
final class ArmedTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!
    let fixes = FakeFixes()
    // Arming waits for the first fix as the app does, and a closed stream reopens within the test.
    lazy var model = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes, reopen: .milliseconds(50))

    override func setUpWithError() throws {
        StubProtocol.requests = []
        StubProtocol.reply = Data()
        StubProtocol.streams = []
        StubProtocol.failing = false
        StubProtocol.delays = [:]
        try turnOnAccessibility()
    }

    override func tearDown() async throws {
        StubProtocol.failing = false
        try await model.cancel()
    }

    // Waits up to 2 s for `done`, and fails if it never comes.
    func until(line: UInt = #line, _ done: @escaping () -> Bool) async throws {
        for _ in 0..<100 {
            if done() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never done", line: line)
    }

    func event(_ key: String, _ value: String) -> String {
        "event: \(key)\ndata: {\"stop\":\"7177-4660a5ff\",\"route\":\"70-205\",\"\(key)\":\"\(value)\"}\n\n"
    }

    func status(_ value: String) -> Outcome { Outcome(stop: melrose.id, route: "70-205", status: value) }

    func labels(_ window: UIWindow) -> [String] { elements(window).compactMap(\.accessibilityLabel) }

    // #55 acceptance 1: Armed has no back button and no other control, and is left only by Cancel hail or an outcome.
    func testTheScreenIsLeftOnlyByCancelHailOrAnOutcome() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        let root = host(RootView(model: model))
        XCTAssertEqual(labels(root), ["Waiting for the 70. We'll hail the bus in time for it to stop for you. Stay at the stop.", "Cancel hail"])

        model.receive(Outcome(stop: melrose.id, route: "70-205", outcome: "confirmed"))
        XCTAssertFalse(labels(root).contains("Cancel hail"))

        try await model.register(stop: melrose, route: "70-205", duration: 0)
        XCTAssertTrue(element(elements(root), "Cancel hail").accessibilityActivate())
        try await until { [self] in model.registration == nil }
        XCTAssertTrue(labels(root).contains { $0.contains(", stop ") })
    }

    // #55 acceptance 2: launch, a stop, a route if the stop has several, Arm: at most three taps to Armed.
    func testTheFlowIsAtMostThreeTapsFromLaunchToArmed() async throws {
        fixes.send(10, from: melrose)
        let root = host(RootView(model: model))
        var taps = 0
        // Each step waits for its screen, and a step that never appears fails the test rather than going uncounted.
        func tap(_ matching: @escaping (String) -> Bool) async throws -> String {
            var target: NSObject?
            try await until { [self] in
                target = elements(root).first { matching($0.accessibilityLabel ?? "") }
                return target != nil
            }
            let tapped = try XCTUnwrap(target)
            XCTAssertTrue(tapped.accessibilityActivate())
            taps += 1
            return tapped.accessibilityLabel ?? ""
        }
        let stop = try await tap { $0.contains(", stop ") }
        if stop.contains(#/Routes [^,]+, /#) { _ = try await tap { $0.hasPrefix("Route ") } }
        _ = try await tap { $0.hasPrefix("Arm hail for the ") }
        try await until { [self] in model.registration != nil }
        XCTAssertLessThanOrEqual(taps, 3)
        XCTAssertEqual(labels(root).last, "Cancel hail")
    }

    // #55 acceptance 3: each state in ArmedStatus's words, `moved` as the owner decided on 13-10-2026, and `left`
    // worded by whether a hail was delivered (ADR-038).
    func testArmedStatusShowsEachStateInItsWordsAndLeftByWhetherAHailWasDelivered() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        let root = host(RootView(model: model))
        func shown() -> String { labels(root)[0] }

        XCTAssertEqual(shown(), "Waiting for the 70. We'll hail the bus in time for it to stop for you. Stay at the stop.")
        model.receive(status("stale"))
        XCTAssertEqual(shown(), "Be ready to signal the driver. We've lost live times for this 70, so we may not be able to hail it. We'll still hail it if its times come back in time.")
        fixes.send(200, from: melrose)
        try await until { [self] in model.present == false }
        XCTAssertEqual(shown(), "Go back to the stop to hail. You moved away from stop 7177, so we won't hail until you're back.")
        fixes.send(10, from: melrose)
        try await until { [self] in model.present == true }
        model.receive(status("sent"))
        XCTAssertEqual(shown(), "Hail sent to the 70. The bus is close. Waiting for the driver to confirm.")
        model.receive(status("moved"))
        XCTAssertEqual(shown(), "Hail moved to the next 70. The first bus was on a different trip. Your hail is now on the next 70.")
        // A departure that closes the session ends unreachable with it, even when its presence/end fails.
        StubProtocol.failing = true
        fixes.send(200, from: melrose)
        try await until { [self] in fixes.closed }
        XCTAssertEqual(shown(), "Hail finished. You moved away from stop 7177 after we hailed the bus. If you're not on the bus, arm a new hail.")
        XCTAssertTrue(element(elements(root), "Cancel hail").accessibilityActivate())
        try await until { [self] in model.armed == .unreachable }
        XCTAssertEqual(shown(), "Signal the driver yourself. We can't reach StopSignal right now, so your hail may not reach the driver. We'll keep trying.")
    }

    // #55 acceptance 4, with the owner's decision of 13-10-2026 on waiting: each change plays signals.md's cue, and
    // VoiceOver announces it after. Stale, unreachable and left with nothing delivered take the heads-up; every change
    // into waiting a light tap; left after a delivered hail nothing.
    func testEachChangePlaysItsSoundAndHapticAndStaleAndLeftWithNothingDeliveredPlayTheHeadsUp() async throws {
        var played: [(Cue, String)] = []
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        // Each change waits for its cue: SwiftUI plays it in its own update, which a forced layout would skip.
        let screen = host(ArmedScreen(model: model, registration: model.registration!, play: { played.append(($0, $1)) }))
        try await until { played.count == 1 }
        fixes.send(200, from: melrose)
        try await until { played.count == 2 }
        fixes.send(10, from: melrose)
        try await until { played.count == 3 }
        for change in ["stale", "waiting", "sent", "moved"] {
            model.receive(status(change))
            try await until { [count = played.count] in played.count == count + 1 }
        }
        fixes.send(200, from: melrose)
        try await until { played.count == 8 }
        StubProtocol.failing = true
        try? await model.cancel()
        try await until { played.count == 9 }
        withExtendedLifetime(screen) {}

        XCTAssertEqual(played.map(\.0), [.tap, .headsUp, .tap, .headsUp, .tap, .tick, .ticks, .none, .headsUp])
        XCTAssertEqual(played[3].1, "Be ready to signal the driver. We've lost live times for this 70, so we may not be able to hail it. We'll still hail it if its times come back in time.")
        XCTAssertEqual(played[7].1, "Hail finished. You moved away from stop 7177 after we hailed the bus. If you're not on the bus, arm a new hail.")

        // What each cue plays (signals.md): its haptic and audio events as type@start+length in seconds, the system
        // sound's ticks, and how long VoiceOver waits, which is when the last sound ends.
        func events(_ cue: Cue) -> [String] { Signals.events(cue).map { "\($0.type.rawValue)@\($0.relativeTime)+\($0.duration)" } }
        XCTAssertEqual(events(.none), [])
        XCTAssertEqual(events(.tap), ["HapticTransient@0.0+0.0"])
        XCTAssertEqual(events(.tick), ["HapticTransient@0.0+0.0"])
        XCTAssertEqual(events(.ticks), ["HapticTransient@0.0+0.0", "HapticTransient@0.15+0.0"])
        XCTAssertEqual(events(.headsUp), ["HapticContinuous@0.0+0.3", "AudioContinuous@0.0+0.3", "HapticTransient@0.4+0.0", "AudioContinuous@0.4+0.1"])
        XCTAssertEqual([Cue.none, .tap, .tick, .ticks, .headsUp].map(Signals.ticks), [[], [], [0], [0, 0.15], []])
        XCTAssertEqual([Cue.none, .tap, .tick, .ticks, .headsUp].map(\.length), [.zero, .zero, .milliseconds(100), .milliseconds(250), .milliseconds(500)])
    }

    // #55 acceptance 5 (ADR-040 decisions 1 and 2), with the owner's decision of 13-10-2026 on a first fix beyond
    // 100 m at arming: with nothing delivered, left keeps the passenger on Armed, and a return shows waiting again.
    func testLeftWithNothingDeliveredStaysOnArmedAndAReturnShowsWaitingAgain() async throws {
        fixes.send(200, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        let root = host(RootView(model: model))
        XCTAssertEqual(model.armed, .left(delivered: false))
        XCTAssertEqual(labels(root), ["Go back to the stop to hail. You moved away from stop 7177, so we won't hail until you're back.", "Cancel hail"])

        fixes.send(10, from: melrose)
        try await until { [self] in model.present == true }
        XCTAssertEqual(labels(root), ["Waiting for the 70. We'll hail the bus in time for it to stop for you. Stay at the stop.", "Cancel hail"])
        XCTAssertFalse(fixes.closed)
    }

    // #55 acceptance 6, with the owner's decisions 4 and 5 of 13-10-2026: unreachable shows while the stream is closed
    // or a request fails. On reopen, while the hail shown is live, the app reports its presence and then registers
    // again, and shows the last state received; after an outcome it sends neither.
    func testUnreachableShowsWhileTheStreamIsClosedOrARequestFailsAndAReopenRegistersAgainOnlyWhileLive() async throws {
        StubProtocol.streams = [Data(event("status", "stale").utf8)]
        StubProtocol.delays = ["/outcomes": 0.3]
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        try await until { [self] in model.armed == .unreachable }
        try await until { [self] in model.armed == .stale }
        XCTAssertEqual(StubProtocol.requests.map(\.url.path), ["/presence/start", "/register", "/outcomes", "/outcomes", "/presence/start", "/register"])
        XCTAssertEqual(StubProtocol.requests[5].body, ["handle": "h", "stop": melrose.id, "route": "70-205", "duration": 0])

        StubProtocol.failing = true
        fixes.send(200, from: melrose)
        try await until { [self] in model.armed == .unreachable }
        StubProtocol.failing = false
        fixes.send(10, from: melrose)
        try await until { [self] in model.armed == .stale }

        // An outcome ends what the hail shown is, so a reopen after it registers nothing.
        StubProtocol.requests = []
        StubProtocol.streams = [Data(event("outcome", "confirmed").utf8)]
        StubProtocol.delays = [:]
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        try await until { StubProtocol.requests.filter { $0.url.path == "/outcomes" }.count == 2 }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(StubProtocol.requests.map(\.url.path), ["/register", "/outcomes", "/outcomes"])
    }

    // #55 acceptance 7: sent, moved and stale, and a return to waiting, come from the stream's status events (#158).
    func testSentMovedAndStaleComeFromTheStreamsStatusEvents() async throws {
        // Each stream sends `sent` first, which marks the hail delivered, so the wait shows both events arrived.
        for (sent, shown) in [("sent", Armed.sent), ("moved", .moved), ("stale", .stale), ("waiting", .waiting)] {
            StubProtocol.reply = Data((event("status", "sent") + event("status", sent)).utf8)
            let armed = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: FakeFixes(), wait: .zero)
            try await armed.register(stop: melrose, route: "70-205", duration: 0)
            try await until { armed.delivered && armed.armed == shown && armed.status == sent }
            try await armed.cancel()
        }
    }

    // #55 acceptance 8 (FR2; ADR-032 decision 4): Cancel hail withdraws the registration with POST /cancel {handle,
    // stop, route}. A failed cancel keeps the passenger on Armed showing unreachable, with Cancel hail still there.
    func testCancelHailWithdrawsTheRegistration() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        let root = host(RootView(model: model))

        StubProtocol.failing = true
        XCTAssertTrue(element(elements(root), "Cancel hail").accessibilityActivate())
        try await until { [self] in model.armed == .unreachable }
        XCTAssertNotNil(model.registration)
        XCTAssertEqual(labels(root).last, "Cancel hail")

        StubProtocol.failing = false
        XCTAssertTrue(element(elements(root), "Cancel hail").accessibilityActivate())
        try await until { [self] in model.registration == nil }
        let cancels = StubProtocol.requests.filter { $0.url.path == "/cancel" }
        XCTAssertEqual(cancels.map(\.method), ["POST", "POST"])
        XCTAssertEqual(cancels.last?.body, ["handle": "h", "stop": melrose.id, "route": "70-205"])

        // A cancel during a reopen's Register waits for it, so the service never meets the cancel first and arms the
        // hail anew once it is withdrawn.
        StubProtocol.requests = []
        StubProtocol.streams = [Data()]
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        StubProtocol.delays = ["/register": 0.5]
        try await until { StubProtocol.requests.filter { $0.url.path == "/outcomes" }.count == 2 }
        try await model.cancel()
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(StubProtocol.requests.map(\.url.path).last, "/cancel")
    }
}
