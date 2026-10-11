// Stops (design-system README §The four screens): a search field, then StopRows nearest first. No map: a stop is
// found by search or in the list (m1-revised.md §5.3). The location stays on the device (QR8).
import CoreLocation
import SwiftUI

struct StopsScreen: View {
    let model: HailViewModel
    @State private var here: CLLocation?
    @State private var query = ""
    @State private var locator = CLLocationManager()

    init(model: HailViewModel, here: CLLocation? = nil) {
        self.model = model
        _here = State(initialValue: here)
    }

    var body: some View {
        let shown = Stop.found(query, near: here)
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: Tokens.space("space-3")) {
                    ForEach(shown) { stop in
                        NavigationLink(value: stop) { StopRow(stop: stop, distance: here.map(stop.distance)) }
                            .buttonStyle(.plain)
                    }
                }
                .padding(Tokens.space("space-4"))
            }
            .overlay {
                if shown.isEmpty {
                    Text("No stop matches").tokenFont("body").foregroundStyle(Tokens.color("ink-muted"))
                }
            }
            .background(Tokens.color("surface"))
            .navigationTitle("Pick your stop")
            .searchable(text: $query, prompt: "Search stops")
            .navigationDestination(for: Stop.self) { RegisterScreen(stop: $0, model: model) }
            .task {
                // On the list, not the stack, so location updates stop while Register is open. Without permission the
                // list stays in name order, and search still finds every stop.
                locator.requestWhenInUseAuthorization()
                do {
                    for try await update in CLLocationUpdate.liveUpdates() where update.location != nil {
                        here = update.location
                    }
                } catch {}
            }
        }
    }
}
