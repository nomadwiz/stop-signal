// One test per acceptance item of #62, the Outcome screen, that a simulator can prove, and one for Done. The screen is
// read through the accessibility tree; the device checks are in the pull request.
import AVFoundation
import SwiftUI
import XCTest
@testable import StopSignal

@MainActor
final class OutcomeTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!
    let fixes = FakeFixes()
    lazy var model = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes)

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

    func until(line: UInt = #line, _ done: @escaping () -> Bool) async throws {
        for _ in 0..<100 {
            if done() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never done", line: line)
    }

    func ended(_ outcome: String, reason: String? = nil, next: Double? = nil) -> Outcome {
        Outcome(stop: melrose.id, route: "70-205", outcome: outcome, reason: reason, nextDistanceM: next)
    }

    // Arms the 70 at Melrose Street, ends it in `outcome` and shows RootView.
    func shown(_ outcome: Outcome) async throws -> UIWindow {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        model.receive(outcome)
        return host(RootView(model: model))
    }

    func labels(_ window: UIWindow) -> [String] { elements(window).compactMap(\.accessibilityLabel) }

    // #62 acceptance 1: with the screen off and VoiceOver on, each outcome has its own sound, haptic and words, and
    // the card reads its tag, title and detail, so no two outcomes sound, feel or read alike.
    func testTheThreeOutcomesAreDistinguishableWithTheScreenOffAndVoiceOverOn() async throws {
        var played: [(Cue, String)] = []
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        for outcome in ["confirmed", "unacknowledged", "cannot-hail"] {
            // Each screen is given its outcome, so a screen hosted earlier plays nothing again.
            let count = played.count
            let screen = host(OutcomeScreen(model: model, registration: model.registration!, outcome: ended(outcome, reason: "feed"), play: { played.append(($0, $1)) }))
            try await until { played.count == count + 1 }
            XCTAssertEqual(labels(screen).first, played.last?.1)
        }

        XCTAssertEqual(played.map(\.0), [.confirmed, .unacknowledged, .cannotHail])
        XCTAssertEqual(played.map(\.1), [
            "Confirmed. The driver will stop. Route 70 to Britomart Via Panmure. Be ready at the front of the stop.",
            "Not confirmed. Signal the driver as well. Your hail reached the 70, but the driver hasn't confirmed.",
            "Could not hail. Signal the driver yourself. We couldn't hail the 70: live bus times aren't available for this stop. Ask someone at the stop, or raise your hand when you hear a bus.",
        ])
        func pattern(_ cue: Cue) -> [String] { Signals.events(cue).map { "\($0.type.rawValue)@\($0.relativeTime)+\($0.duration)" } }
        let patterns = [Cue.confirmed, .unacknowledged, .cannotHail, .headsUp].map(pattern)
        XCTAssertEqual(Set(patterns).count, 4, "an outcome shares its pattern with another signal")

        // A confirmed headsign with no " to " is shown whole (the owner's decision 1 of 14-10-2026).
        let link = Stop.Route(id: "INN-202", shortName: "INN", headsign: "Inner Link Clockwise")
        XCTAssertEqual(ended("confirmed").words(route: link).detail, "Route INN, Inner Link Clockwise. Be ready at the front of the stop.")
    }

    // #62 acceptance 2: each failure state's first line, under the tag, says what to do instead.
    func testEachFailureStatesFirstLineNamesTheFallback() {
        let route = melrose.routes[2]
        XCTAssertEqual(ended("unacknowledged").words(route: route).title, "Signal the driver as well")
        for (reason, title) in [("deadline", "Signal this bus yourself"), ("stale", "Signal the driver yourself"), ("feed", "Signal the driver yourself")] {
            XCTAssertEqual(ended("cannot-hail", reason: reason).words(route: route).title, title, reason)
        }
    }

    // #62 acceptance 3: each outcome plays signals.md's sound and haptic together from the same instant, on a
    // `.playback` session that mixes with other audio, so it sounds through the silent switch; VoiceOver speaks once
    // the last sound ends.
    func testEachOutcomePlaysItsSoundAndHapticTogetherThenTheAnnouncementThroughTheSilentSwitch() {
        func events(_ cue: Cue) -> [String] { Signals.events(cue).map { "\($0.type.rawValue)@\($0.relativeTime)+\($0.duration)" } }
        // Confirmed: two 120 ms notes rising a fifth; two sharp taps 100 ms apart at full intensity.
        XCTAssertEqual(events(.confirmed), ["HapticTransient@0.0+0.0", "AudioContinuous@0.0+0.12", "HapticTransient@0.1+0.0", "AudioContinuous@0.12+0.12"])
        // Unacknowledged: three 90 ms notes on one pitch with 90 ms gaps; three medium taps, evenly spaced, on the notes.
        XCTAssertEqual(events(.unacknowledged), ["HapticTransient@0.0+0.0", "AudioContinuous@0.0+0.09", "HapticTransient@0.18+0.0", "AudioContinuous@0.18+0.09", "HapticTransient@0.36+0.0", "AudioContinuous@0.36+0.09"])
        // Cannot hail: two 200 ms notes falling a fifth; one 400 ms buzz at full intensity.
        XCTAssertEqual(events(.cannotHail), ["HapticContinuous@0.0+0.4", "AudioContinuous@0.0+0.2", "AudioContinuous@0.2+0.2"])

        func pitches(_ cue: Cue) -> [Float] {
            Signals.events(cue).filter { $0.type == .audioContinuous }.map { $0.eventParameters.first { $0.parameterID == .audioPitch }!.value }
        }
        XCTAssertLessThan(pitches(.confirmed)[0], pitches(.confirmed)[1])
        XCTAssertEqual(Set(pitches(.unacknowledged)).count, 1)
        XCTAssertGreaterThan(pitches(.cannotHail)[0], pitches(.cannotHail)[1])
        XCTAssertEqual(pitches(.cannotHail)[0] - pitches(.cannotHail)[1], pitches(.confirmed)[1] - pitches(.confirmed)[0])
        func intensities(_ cue: Cue) -> [Float] {
            Signals.events(cue).filter { $0.type != .audioContinuous }.map { $0.eventParameters.first { $0.parameterID == .hapticIntensity }!.value }
        }
        XCTAssertEqual(intensities(.confirmed), [1, 1])
        XCTAssertEqual(intensities(.unacknowledged), [0.6, 0.6, 0.6])
        XCTAssertEqual(intensities(.cannotHail), [1])
        XCTAssertEqual([Cue.confirmed, .unacknowledged, .cannotHail].map(Signals.ticks), [[], [], []])
        XCTAssertEqual([Cue.confirmed, .unacknowledged, .cannotHail].map(\.length), [.milliseconds(240), .milliseconds(450), .milliseconds(400)])

        Signals.play(.none, announcing: "")
        XCTAssertEqual(AVAudioSession.sharedInstance().category, .playback)
        XCTAssertTrue(AVAudioSession.sharedInstance().categoryOptions.contains(.mixWithOthers))
    }

    // #62 acceptance 4, with the owner's decisions 3 and 4 of 14-10-2026: each cannot-hail reason's card, with Done
    // under its fallback, and the fallback registers a new hail for the same route and stop. A failed one keeps the
    // passenger on Outcome with the arming-failure alert.
    func testEachCannotHailReasonHasItsCardAndItsFallbackRegistersTheSameRouteAndStop() async throws {
        let feed = "We couldn't hail the 70: live bus times aren't available for this stop. Ask someone at the stop, or raise your hand when you hear a bus."
        let stale = "We couldn't hail the 70: live times for this bus stopped updating. Ask someone at the stop, or raise your hand when you hear a bus."
        let close = "This 70 is too close to stop safely, so no hail was sent."
        let route = melrose.routes[2]
        func card(_ reason: String, _ next: Double? = nil) -> [String] {
            let words = ended("cannot-hail", reason: reason, next: next).words(route: route)
            return [words.title, words.detail, words.action, words.secondary ?? ""]
        }
        XCTAssertEqual(card("deadline", 1200), ["Signal this bus yourself", close + " The next 70 is 1.2 km away.", "Hail the next 70", "Done"])
        XCTAssertEqual(card("deadline", 40), ["Signal this bus yourself", close + " The next 70 is 40 m away.", "Hail the next 70", "Done"])
        XCTAssertEqual(card("deadline"), ["Signal this bus yourself", close, "Hail the next 70", "Done"])
        XCTAssertEqual(card("stale"), ["Signal the driver yourself", stale, "Hail the next 70", "Done"])
        XCTAssertEqual(card("feed"), ["Signal the driver yourself", feed, "Try again", "Done"])

        let root = try await shown(ended("cannot-hail", reason: "deadline", next: 1200))
        XCTAssertEqual(labels(root), ["Could not hail. Signal this bus yourself. \(close) The next 70 is 1.2 km away.", "Hail the next 70", "Done"])

        StubProtocol.failing = true
        StubProtocol.requests = []
        XCTAssertTrue(element(elements(root), "Hail the next 70").accessibilityActivate())
        try await until { StubProtocol.requests.contains { $0.url.path == "/register" } }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.outcome?.outcome, "cannot-hail")
        let alert = try XCTUnwrap(root.rootViewController?.presentedViewController as? UIAlertController)
        XCTAssertEqual([alert.title, alert.message], ["Signal the driver yourself", "We couldn't arm your hail."])
        alert.dismiss(animated: false)

        for fallback in ["Hail the next 70", "Try again"] {
            StubProtocol.failing = false
            StubProtocol.requests = []
            model.receive(ended("cannot-hail", reason: fallback == "Try again" ? "feed" : "stale"))
            XCTAssertTrue(element(elements(root), fallback).accessibilityActivate())
            try await until { [self] in model.outcome == nil }
            XCTAssertEqual(StubProtocol.requests.first { $0.url.path == "/register" }?.body, ["handle": "h", "stop": melrose.id, "route": "70-205", "duration": 0])
            XCTAssertEqual(labels(root).last, "Cancel hail")
        }
    }

    // The owner's decision 4 of 14-10-2026: Done on any card returns to Stops, and neither cancels the hail nor ends
    // the location session (ADR-040).
    func testDoneReturnsToStopsWithoutCancellingTheHailOrEndingTheSession() async throws {
        for outcome in [ended("confirmed"), ended("unacknowledged"), ended("cannot-hail", reason: "feed")] {
            StubProtocol.requests = []
            let fixes = FakeFixes()
            let done = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes)
            fixes.send(10, from: melrose)
            try await done.register(stop: melrose, route: "70-205", duration: 0)
            done.receive(outcome)
            let root = host(RootView(model: done))
            XCTAssertEqual(labels(root).last, "Done")
            XCTAssertTrue(element(elements(root), "Done").accessibilityActivate())
            try await until { [self] in labels(root).contains { $0.contains(", stop ") } }
            XCTAssertFalse(StubProtocol.requests.contains { $0.url.path == "/cancel" })
            // A cannot-hail has already closed the session (ADR-040); Done leaves the others open.
            XCTAssertEqual(fixes.closed, outcome.outcome == "cannot-hail")
            // A cannot-hail after Done, as a stale feed sends for a committed hail, still closes it (ADR-040), and
            // the passenger stays on Stops.
            done.receive(ended("cannot-hail", reason: "feed"))
            try await until { fixes.closed }
            XCTAssertTrue(labels(root).contains { $0.contains(", stop ") })
            // Arming again is what ends the session left open, and cancelling that ends the test's.
            try await done.register(stop: melrose, route: "70-205", duration: 0)
            try await done.cancel()
        }
    }
}
