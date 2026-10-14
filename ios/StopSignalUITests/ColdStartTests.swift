// Usage: B7's two cold-start times (ADR-046), measured by hand on the iPhone 17 simulator in the Release build. The
// StopSignal scheme, which ios.yml runs, leaves this target out; its own scheme runs it, with the hail service running
// locally:
//   PORT=8080 node packages/hail-service/src/main.ts
//   xcodebuild test -project ios/StopSignal.xcodeproj -scheme StopSignalUITests \
//     -destination 'platform=iOS Simulator,name=iPhone 17'
// Every iteration launches a fresh app process, and xcodebuild prints each metric's ten values.
import CoreLocation
import XCTest

final class ColdStartTests: XCTestCase {
    // Onehunga Station, stop 1039, whose one route takes Register straight to its Arm button.
    private let stop = CLLocation(latitude: -36.92543, longitude: 174.78576)

    private var tenRuns: XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = 10
        return options
    }

    // Launch to first frame, against B7's ≤ 400 ms.
    func testLaunchToFirstFrame() {
        measure(metrics: [XCTApplicationLaunchMetric()], options: tenRuns) { XCUIApplication().launch() }
    }

    // The Arm tap to the Armed screen, against B7's ≤ 1 s, with a decisive fix to hand: the simulator stands at the
    // stop. The app times it between its own B7 signposts, so the harness's taps and polling stay outside the number.
    func testArmTapToArmed() {
        XCUIDevice.shared.location = XCUILocation(location: stop)
        let app = XCUIApplication()
        // The unit tests' Stops screen expects no location on the simulator, so the grant ends with this test.
        addTeardownBlock { app.resetAuthorizationStatus(for: .location) }
        app.launch()
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow While Using App"]
        if allow.waitForExistence(timeout: 10) { allow.tap() }
        let arm = app.buttons["Arm hail for the 309"]
        measure(metrics: [XCTOSSignpostMetric(subsystem: "com.nomadwiz.StopSignal", category: "B7", name: "Arm")], options: tenRuns) {
            app.launch()
            // The row exists once the first fix sorts it to the top of the list.
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Onehunga Station, stop 1039'")).firstMatch
            XCTAssert(row.waitForExistence(timeout: 5))
            row.tap()
            // Register's push has to settle first, or the tap lands where the button was mid-slide.
            XCTAssert(arm.waitForExistence(timeout: 5))
            arm.tap()
            // Cancelling, after the interval has ended, leaves the next iteration a hail the service does not yet hold.
            let cancel = app.buttons["Cancel hail"]
            XCTAssert(cancel.waitForExistence(timeout: 10))
            cancel.tap()
            XCTAssert(cancel.waitForNonExistence(timeout: 10))
        }
    }
}
