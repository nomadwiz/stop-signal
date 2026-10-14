// One test per acceptance item of #56, the live activity, that a simulator can prove. The activity is read from
// HailViewModel.lockScreen, which LiveActivities hands to ActivityKit as it changes; the device checks are in the pull
// request.
import XCTest
@testable import StopSignal

@MainActor
final class LiveActivityTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!
    let fixes = FakeFixes()
    lazy var model = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes, reopen: .milliseconds(50))

    override func setUp() {
        StubProtocol.requests = []
        StubProtocol.reply = Data()
        StubProtocol.streams = []
        StubProtocol.failing = false
        StubProtocol.delays = [:]
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

    func status(_ value: String) -> Outcome { Outcome(stop: melrose.id, route: "70-205", status: value) }

    func shown(_ title: String, _ detail: String?, _ glyph: String, _ tone: String?, ended: Bool = false) -> LockScreen {
        LockScreen(route: "70", state: HailActivity.ContentState(title: title, detail: detail, glyph: glyph, tone: tone), ended: ended)
    }

    // #56 acceptance 3, with the owner's decision 48 of 14-10-2026: LiveActivity's words for each state, which carry no
    // minutes; stale, unreachable and left lead with what to do; after a delivered hail, left reads "Hail finished"
    // and ends the activity (decision 50). The glyph and tone are StatusGlyph's, for the Dynamic Island (decision 51).
    // Cancel hail removes the activity at once.
    func testTheActivityShowsLiveActivitysWordsForEachStateAndHailFinishedAfterADeliveredHail() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        var seen = [model.lockScreen]
        model.receive(status("stale"))
        seen.append(model.lockScreen)
        fixes.send(200, from: melrose)
        try await until { [self] in model.present == false }
        seen.append(model.lockScreen)
        fixes.send(10, from: melrose)
        try await until { [self] in model.present == true }
        model.receive(status("sent"))
        seen.append(model.lockScreen)
        model.receive(status("moved"))
        seen.append(model.lockScreen)
        StubProtocol.failing = true
        try? await model.cancel()
        seen.append(model.lockScreen)
        StubProtocol.failing = false
        fixes.send(200, from: melrose)
        try await until { [self] in fixes.closed }
        seen.append(model.lockScreen)

        XCTAssertEqual(seen, [
            shown("Waiting · Melrose Street", "We'll hail in time for it to stop", "dot.radiowaves.left.and.right", nil),
            shown("Be ready to signal", "Lost live times for this bus", "exclamationmark.triangle", "unacknowledged"),
            shown("Go back to the stop", "We won't hail until you're back", "figure.walk.departure", "unacknowledged"),
            shown("Hail sent", "Waiting for driver to confirm", "arrow.right", "confirmed"),
            shown("Hail moved", "Now on the next bus", "arrow.left.arrow.right", "confirmed"),
            shown("Signal the driver yourself", "Can't reach StopSignal", "antenna.radiowaves.left.and.right.slash", "unacknowledged"),
            shown("Hail finished", "If you're not on the bus, arm a new hail", "figure.walk.departure", nil, ended: true),
        ])

        try await model.cancel()
        XCTAssertNil(model.lockScreen)
    }

    // #56 acceptance 4, with the owner's decisions 49 and 50 of 14-10-2026: an outcome ends the activity showing
    // OutcomeCard's title and the outcome's solid glyph, with no detail, and Done then removes it at once. Its sound is
    // the Outcome screen's, which OutcomeTests checks; the activity sets no alert of its own.
    func testAnOutcomeEndsTheActivityWithItsTitleAndSolidGlyphAndDoneRemovesIt() async throws {
        let ends = [
            ("confirmed", shown("The driver will stop", nil, "checkmark.circle.fill", "confirmed", ended: true)),
            ("unacknowledged", shown("Signal the driver as well", nil, "exclamationmark.triangle.fill", "unacknowledged", ended: true)),
            ("cannot-hail", shown("Signal the driver yourself", nil, "xmark.octagon.fill", "cannot-hail", ended: true)),
        ]
        for (outcome, end) in ends {
            fixes.send(10, from: melrose)
            try await model.register(stop: melrose, route: "70-205", duration: 0)
            model.receive(Outcome(stop: melrose.id, route: "70-205", outcome: outcome, reason: "feed"))
            XCTAssertEqual(model.lockScreen, end)
            model.done()
            XCTAssertNil(model.lockScreen)
        }
    }

    // #56 acceptance 5: the secondary text's contrast on the activity's fixed background, by WCAG 2.2's formula. It is
    // about 11:1, above the 4.5:1 that WCAG's 1.4.3 asks of body text; on a device's lock screen it is a device check.
    func testTheSecondaryTextsContrastOnTheActivitysBackgroundMeetsWCAG() {
        func luminance(_ rgb: Int) -> Double {
            let channels: [Double] = [rgb >> 16, rgb >> 8, rgb].map { shifted in
                let c = Double(shifted & 0xff) / 255
                return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
        }
        func contrast(_ a: Int, _ b: Int) -> Double {
            let (l1, l2) = (luminance(a), luminance(b))
            return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
        }
        XCTAssertEqual(contrast(HailActivity.secondary, HailActivity.background), 11.2, accuracy: 0.1)
        XCTAssertGreaterThanOrEqual(contrast(HailActivity.text, HailActivity.background), 4.5)
    }
}
