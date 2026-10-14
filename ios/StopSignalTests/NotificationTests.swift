// One test per acceptance item of #63, the outcome as a local notification, that a simulator can prove. The
// notification is read from the requests HailViewModel hands its Notifier; the device checks are in the pull request.
import SwiftUI
import UserNotifications
import XCTest
@testable import StopSignal

@MainActor
final class NotificationTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!
    let fixes = FakeFixes()
    var asked = 0
    var raised: [UNNotificationRequest] = []
    lazy var model = HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: StubProtocol.session), fixes: fixes, reopen: .milliseconds(50), notifier: Notifier(ask: { [unowned self] in asked += 1 }, raise: { [unowned self] in raised.append($0) }))

    override func setUpWithError() throws {
        StubProtocol.requests = []
        StubProtocol.reply = Data()
        StubProtocol.streams = []
        StubProtocol.failing = false
        StubProtocol.delays = [:]
        try turnOnAccessibility()
    }

    override func tearDown() async throws {
        try await model.cancel()
    }

    func until(line: UInt = #line, _ done: @escaping () -> Bool) async throws {
        for _ in 0..<100 {
            if done() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never done", line: line)
    }

    func ended(_ outcome: String, reason: String? = nil) -> Outcome {
        Outcome(stop: melrose.id, route: "70-205", outcome: outcome, reason: reason)
    }

    func shown(_ request: UNNotificationRequest) -> [String?] {
        [request.content.title, request.content.body, request.content.sound.map { _ in "a sound" }, request.trigger.map { _ in "a trigger" }]
    }

    // #63 acceptance 1 and 3, with the owner's decisions 55 and 56 of 14-10-2026: arming asks to notify, and an outcome
    // arriving on the armed stream raises a notification at once, with OutcomeCard's title and detail and no sound of
    // its own. The same outcome replayed when the stream reopens is not raised again. Whether it shows with the app
    // backgrounded is a device check: iOS presents none in the foreground (UNUserNotificationCenter.h).
    func testAnOutcomeOnTheArmedStreamRaisesANotificationWithItsTitleAndDetailAndNoSound() async throws {
        let confirmed = Data(#"event: outcome\#ndata: {"stop":"7177-4660a5ff","route":"70-205","outcome":"confirmed"}\#n\#n"#.utf8)
        StubProtocol.streams = [confirmed, confirmed + Data(": replayed\n\n".utf8)]
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        XCTAssertEqual(asked, 1)
        try await until { StubProtocol.requests.filter { $0.url.path == "/outcomes" }.count == 3 }

        XCTAssertEqual(raised.map(shown), [["The driver will stop", "Route 70 to Britomart Via Panmure. Be ready at the front of the stop.", nil, nil]])
    }

    // #63 acceptance 2: the notification is local, so the app is signed without aps-environment, the remote push
    // entitlement (ADR-009). A simulator build carries its entitlements in the executable's __TEXT,__entitlements
    // section, so the test reads them there, and finds application-identifier to show it read the right bytes.
    func testTheAppIsSignedWithoutTheRemotePushEntitlement() throws {
        let executable = try Data(contentsOf: XCTUnwrap(Bundle.main.executableURL))
        XCTAssertNotNil(executable.range(of: Data("<key>application-identifier</key>".utf8)))
        XCTAssertNil(executable.range(of: Data("<key>aps-environment</key>".utf8)))
    }

    // #63 acceptance 4, the owner's decision 46 of 14-10-2026: after Done, a cannot-hail brings Outcome back with its
    // card, which plays its sound and haptic as OutcomeTests checks, and raises a notification that replaces the
    // earlier one. A confirmed or unacknowledged after Done is neither shown nor raised, and the live activity Done
    // removed stays removed.
    func testACannotHailAfterDoneBringsOutcomeBackAndRaisesANotification() async throws {
        fixes.send(10, from: melrose)
        try await model.register(stop: melrose, route: "70-205", duration: 0)
        model.receive(ended("confirmed"))
        let root = host(RootView(model: model))
        model.done()
        model.receive(ended("unacknowledged"))
        XCTAssertTrue(labels(root).contains { $0.contains(", stop ") })
        XCTAssertEqual(raised.count, 1)

        model.receive(ended("cannot-hail", reason: "stale"))
        XCTAssertEqual(labels(root).first, "Could not hail. Signal the driver yourself. We couldn't hail the 70: live times for this bus stopped updating. Ask someone at the stop, or raise your hand when you hear a bus.")
        XCTAssertEqual(raised.map(\.identifier), ["outcome", "outcome"])
        XCTAssertEqual(raised.last.map(shown), ["Signal the driver yourself", "We couldn't hail the 70: live times for this bus stopped updating. Ask someone at the stop, or raise your hand when you hear a bus.", nil, nil])
        XCTAssertEqual(LiveActivities.step(from: nil, to: model.lockScreen), LiveActivities.Step.none)
    }

    func labels(_ window: UIWindow) -> [String] { elements(window).compactMap(\.accessibilityLabel) }
}
