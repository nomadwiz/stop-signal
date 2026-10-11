// The passenger app (S10): SwiftUI views over HailViewModel (ADR-012 decision 2), styled from tokens.json (ADR-038).
import SwiftUI

@main
struct StopSignalApp: App {
    // ponytail: the service's address until #50 deploys it over HTTPS.
    @State private var model = HailViewModel(api: HailApi(base: URL(string: "http://localhost:8080")!, handle: Handle.current()))

    var body: some Scene {
        WindowGroup {
            if model.registration == nil {
                StopsScreen(model: model)
            } else {
                // ponytail: ArmedStatus's waiting tag alone until the Armed screen (#55) takes its place.
                Text("Waiting")
                    .tokenFont("headline")
                    .foregroundStyle(Tokens.color("ink"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Tokens.color("surface"))
            }
        }
    }
}
