// One test per acceptance item of #54, the Stops and Register screens, plus the bundled stop list and ConfirmPanel's
// destination rule (ADR-043). The screens are hosted in a window and read through the accessibility tree VoiceOver
// reads, so no UI test target is needed.
import CoreLocation
import SwiftUI
import XCTest
@testable import StopSignal

@MainActor
final class StopsRegisterTests: XCTestCase {
    let melrose = Stop.bundled.first { $0.id == "7177-4660a5ff" }!

    override func setUpWithError() throws {
        StubProtocol.requests = []
        // SwiftUI builds its accessibility tree only while an assistive technology is on. This private switch in
        // libAccessibility, called from the tests alone, turns it on as VoiceOver would; the app never calls it.
        let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW)
        let enable = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"), "libAccessibility no longer has _AXSApplicationAccessibilitySetEnabled")
        unsafeBitCast(enable, to: (@convention(c) (Bool) -> Void).self)(true)
    }

    // `view` in a phone-sized window, kept by the test so its state lives across reads.
    func host(_ view: some View) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        return window
    }

    // Each accessibility element in `window`, in VoiceOver's order, once SwiftUI has drawn its latest state.
    func elements(_ window: UIWindow) -> [NSObject] {
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.2))
        func walk(_ node: NSObject) -> [NSObject] {
            if node.isAccessibilityElement { return [node] }
            return (node.accessibilityElements as? [NSObject] ?? (node as? UIView)?.subviews ?? []).flatMap(walk)
        }
        return walk(window)
    }

    func elements(_ view: some View) -> [NSObject] {
        elements(host(view))
    }

    func model(_ session: URLSession = .shared) -> HailViewModel {
        HailViewModel(api: HailApi(base: URL(string: "https://hail.test")!, handle: "h", session: session), fixes: FakeFixes())
    }

    func element(_ elements: [NSObject], _ label: String) -> NSObject {
        elements.first { $0.accessibilityLabel == label }!
    }

    // ADR-043: the stops on the seven routes through Melrose Street, each route by the id Register sends.
    func testStopsJSONHoldsTheStopsOnTheSevenRoutesThroughMelroseStreet() throws {
        let file = try JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.main.url(forResource: "stops", withExtension: "json")!)) as! [String: Any]
        XCTAssertEqual(file["source"] as? String, "packages/replay/fixtures/gtfs.zip, stops valid 20260917–20261231")
        XCTAssertEqual(Set(Stop.bundled.map(\.id)).count, Stop.bundled.count)
        XCTAssertEqual(Set(Stop.bundled.flatMap(\.routes).map(\.shortName)), ["30", "309", "64", "70", "75", "INN", "295"])
        XCTAssertEqual(melrose.code, "7177")
        XCTAssertEqual(melrose.name, "Melrose Street")
        XCTAssertEqual(melrose.lat, -36.86698)
        XCTAssertEqual(melrose.lon, 174.77468)
        XCTAssertEqual(melrose.routes.map(\.id), ["30-202", "64-202", "70-205", "75-202", "295-202", "309-203", "INN-202"])
        XCTAssertEqual(melrose.routes[2], Stop.Route(id: "70-205", shortName: "70", headsign: "Botany To Britomart Via Panmure"))
    }

    // The owner's decision of 11-10-2026: the text after the headsign's last " to ", ignoring case, or the headsign whole.
    func testTheDestinationIsTheHeadsignAfterItsLastTo() {
        func destination(_ headsign: String) -> String { Stop.Route(id: "", shortName: "", headsign: headsign).destination }
        XCTAssertEqual(destination("Botany To Britomart Via Panmure"), "To Britomart Via Panmure")
        XCTAssertEqual(destination("Mangere Town Centre to City Centre"), "To City Centre")
        XCTAssertEqual(destination("Inner Link Clockwise Customs St To Victoria Park"), "To Victoria Park")
        XCTAssertEqual(destination("Inner Link Clockwise"), "Inner Link Clockwise")
        XCTAssertEqual(destination("Toronto"), "Toronto")
    }

    // #54 acceptance 1: a stop is found by search or by the nearby list, nearest first, with no map.
    func testAStopIsFoundBySearchOrNearestFirstWithoutAMap() {
        // Melrose Street has a stop on each side of the road; the code tells them apart.
        XCTAssertEqual(Set(Stop.found("melrose", near: nil).map(\.id)), ["7177-4660a5ff", "8541-4d49b0a9"])
        XCTAssertEqual(Stop.found(" 7177 ", near: nil).map(\.id), ["7177-4660a5ff"])
        XCTAssertEqual(Stop.found("no such stop", near: nil), [])

        let here = melrose.location
        let nearby = Stop.found("", near: here)
        XCTAssertEqual(nearby.count, Stop.bundled.count)
        XCTAssertEqual(nearby.first?.id, melrose.id)
        let metres = nearby.map { here.distance(from: $0.location) }
        XCTAssertEqual(metres, metres.sorted())

        let rows = elements(StopsScreen(model: model(), here: here))
        XCTAssertEqual(rows.first { $0.accessibilityLabel?.hasPrefix("Melrose Street") == true }?.accessibilityLabel, "Melrose Street, stop 7177, 0 m away. Routes 30, 64, 70, 75, 295, 309, INN.")
    }

    // #54 acceptance 2: route and stop on one screen, each with its own Change, before arming; a stop with several
    // routes asks for the route first, and Arm registers that stop and route with duration 0.
    func testRouteAndStopAreConfirmedOnOneScreenEachWithItsOwnChangeBeforeArming() async throws {
        let model = model(StubProtocol.session)
        let screen = host(RegisterScreen(stop: melrose, model: model))

        let routes = elements(screen)
        XCTAssertEqual(routes.compactMap(\.accessibilityLabel), melrose.routes.map { "Route \($0.shortName), \($0.destination)" })
        XCTAssertTrue(element(routes, "Route 70, To Britomart Via Panmure").accessibilityActivate())

        let check = elements(screen)
        XCTAssertEqual(check.compactMap(\.accessibilityLabel), [
            "Route 70, To Britomart Via Panmure", "Change route", "Stop, Melrose Street, stop 7177", "Change stop", "Arm hail for the 70",
        ])
        XCTAssertTrue(element(check, "Arm hail for the 70").accessibilityActivate())
        for _ in 0..<50 where model.registration == nil { try await Task.sleep(for: .milliseconds(20)) }
        // Arming also opens the outcome stream (#58).
        XCTAssertEqual(StubProtocol.requests.filter { $0.url.path != "/outcomes" }.map(\.body), [["handle": "h", "stop": "7177-4660a5ff", "route": "70-205", "duration": 0]])

        let oneRoute = Stop.bundled.first { $0.routes.count == 1 }!
        XCTAssertEqual(elements(RegisterScreen(stop: oneRoute, model: model)).last?.accessibilityLabel, "Arm hail for the \(oneRoute.routes[0].shortName)")
    }

    // #54 acceptance 3: text contrast at least 4.5:1, the main action 64 pt tall and every other control at least 44 pt.
    func testTextContrastAndTargetSizesMeetTheDesignSystem() {
        func luminance(_ name: String, _ traits: UITraitCollection) -> CGFloat {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            UIColor(Tokens.color(name)).resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let linear = [red, green, blue].map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
        }
        let themes = [
            UITraitCollection(userInterfaceStyle: .light),
            UITraitCollection(userInterfaceStyle: .dark),
            UITraitCollection { $0.accessibilityContrast = .high },
        ]
        // Every text and ground pair the two screens draw.
        for (text, ground) in [("ink", "surface"), ("ink", "surface-raised"), ("ink-muted", "surface"), ("ink-muted", "surface-raised"), ("on-signal", "signal")] {
            for theme in themes {
                let (a, b) = (luminance(text, theme), luminance(ground, theme))
                XCTAssertGreaterThanOrEqual((max(a, b) + 0.05) / (min(a, b) + 0.05), 4.5, "\(text) on \(ground)")
            }
        }

        let check = elements(RegisterScreen(stop: Stop.bundled.first { $0.routes.count == 1 }!, model: model()))
        XCTAssertEqual(check.last!.accessibilityFrame.height, 64)
        for label in ["Change route", "Change stop"] {
            XCTAssertGreaterThanOrEqual(element(check, label).accessibilityFrame.height, 44, label)
            XCTAssertGreaterThanOrEqual(element(check, label).accessibilityFrame.width, 44, label)
        }
        let rows = elements(RegisterScreen(stop: melrose, model: model()))
        XCTAssertEqual(rows.count, melrose.routes.count)
        for row in rows { XCTAssertGreaterThanOrEqual(row.accessibilityFrame.height, 44, row.accessibilityLabel ?? "") }
    }

    // design-system README §Type: nothing truncates. Route chips wrap to a second row, and at the accessibility text
    // sizes ConfirmPanel's Change buttons stack under what they change.
    func testRouteChipsWrapAndConfirmPanelStacksAtTheLargestSizes() {
        let chips = elements(Flow(spacing: 4) { ForEach(["30", "64", "70", "75", "295", "309", "INN"], id: \.self) { RouteChip(route: $0) } }.frame(width: 120))
        XCTAssertEqual(chips.count, 7)
        XCTAssertGreaterThan(chips.last!.accessibilityFrame.minY, chips.first!.accessibilityFrame.maxY)

        let oneRoute = Stop.bundled.first { $0.routes.count == 1 }!
        func changeRouteIsBelowTheRoute(_ size: DynamicTypeSize) -> Bool {
            let check = elements(RegisterScreen(stop: oneRoute, model: model()).environment(\.dynamicTypeSize, size))
            let route = element(check, "Route \(oneRoute.routes[0].shortName), \(oneRoute.routes[0].destination)")
            return element(check, "Change route").accessibilityFrame.minY >= route.accessibilityFrame.maxY
        }
        XCTAssertFalse(changeRouteIsBelowTheRoute(.large))
        XCTAssertTrue(changeRouteIsBelowTheRoute(.accessibility5))
    }
}
