// Register (design-system README §The four screens): ConfirmPanel's route and stop, each with Change, then MainAction
// "Arm hail for the 70". A stop with several routes asks for the route first; one with a single route goes straight to
// the check. Lead time stays off Register, and the registration carries duration 0 (ADR-038; the owner's decision of
// 11-10-2026).
import os
import SwiftUI

// B7's second clock (ADR-046): an interval from Register's Arm tap to the Armed screen's onAppear, which SwiftUI calls
// as it adds Armed, before Armed's first frame is drawn. StopSignalUITests reads it. A failed Register
// closes it too, so Try again opens a fresh one; Outcome's own arming opens none.
let b7 = OSLog(subsystem: "com.nomadwiz.StopSignal", category: "B7")

struct RegisterScreen: View {
    let stop: Stop
    let model: HailViewModel
    @State private var route: Stop.Route?
    @State private var failed = false
    @State private var arming = false
    @Environment(\.dismiss) private var dismiss

    init(stop: Stop, model: HailViewModel) {
        self.stop = stop
        self.model = model
        _route = State(initialValue: stop.routes.count == 1 ? stop.routes[0] : nil)
    }

    var body: some View {
        Group {
            if let route {
                VStack(spacing: 0) {
                    ConfirmPanel(route: route, stop: stop, onEditRoute: { self.route = nil }, onEditStop: { dismiss() })
                    Spacer(minLength: Tokens.space("space-8"))
                    MainAction(label: "Arm hail for the \(route.shortName)") { arm(route) }
                        .disabled(arming)
                }
                .padding(Tokens.space("space-4"))
                .onAppear {
                    AccessibilityNotification.Announcement("Route \(route.shortName) \(route.destination), from \(stop.name), stop \(stop.code).").post()
                }
            } else {
                ScrollView {
                    VStack(spacing: Tokens.space("space-3")) {
                        ForEach(stop.routes) { choice in
                            Button { route = choice } label: { RouteRow(route: choice) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(Tokens.space("space-4"))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.color("surface"))
        // The first line says what to do instead (design-system README §Principles 3).
        .alert("Signal the driver yourself", isPresented: $failed) {
            Button("Try again") { if let route { arm(route) } }
            Button("Close", role: .cancel) {}
        } message: {
            Text("We couldn't arm your hail.")
        }
    }

    // One registration per tap: a second tap while the first is in flight does nothing.
    private func arm(_ route: Stop.Route) {
        guard !arming else { return }
        arming = true
        os_signpost(.begin, log: b7, name: "Arm")
        Task {
            defer { arming = false }
            do { try await model.register(stop: stop, route: route.id, duration: 0) } catch {
                os_signpost(.end, log: b7, name: "Arm")
                failed = true
            }
        }
    }
}
