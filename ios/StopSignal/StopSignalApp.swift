// The passenger app (S10): SwiftUI views over HailViewModel (ADR-012 decision 2), styled from tokens.json (ADR-038).
import SwiftUI

@main
struct StopSignalApp: App {
    // ponytail: the service's address until #50 deploys it over HTTPS.
    @State private var model = HailViewModel(api: HailApi(base: URL(string: "http://localhost:8080")!, handle: Handle.current()), fixes: DeviceFixes())

    var body: some Scene {
        WindowGroup { RootView(model: model) }
    }
}

// Stops until a hail is armed, then Armed until an outcome. Armed replaces Stops' navigation stack rather than being
// pushed on it, so it has no back button and no swipe-back (design-system README §The four screens).
struct RootView: View {
    let model: HailViewModel

    var body: some View {
        if let registration = model.registration {
            if let outcome = model.outcome {
                // ponytail: the outcome's name alone until the Outcome screen (#62) takes its place.
                Text(outcome.outcome ?? "")
                    .tokenFont("large-title")
                    .foregroundStyle(Tokens.color("ink"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Tokens.color("surface"))
            } else {
                ArmedScreen(model: model, registration: registration)
            }
        } else {
            StopsScreen(model: model)
        }
    }
}
