// The passenger app (S10): SwiftUI views over HailViewModel (ADR-012 decision 2), styled from tokens.json (ADR-038).
import SwiftUI

@main
struct StopSignalApp: App {
    var body: some Scene {
        WindowGroup {
            // ponytail: the name alone until the Stops screen (#54) takes its place.
            Text("StopSignal")
                .tokenFont("headline")
                .foregroundStyle(Tokens.color("ink"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Tokens.color("surface"))
        }
    }
}
