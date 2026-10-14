// Outcome (design-system README §The four screens): OutcomeCard for one of exactly three outcomes, then its MainAction.
// Each outcome has its own glyph, word, sound and haptic, so it is told apart without sight (QR4; ADR-038).
import SwiftUI

extension Outcome {
    struct Words {
        let tag: String
        let title: String
        let detail: String
        let action: String
        // "Done", under a cannot card's fallback (the owner's decision 4 of 14-10-2026).
        let secondary: String?
    }

    // OutcomeCard's words, with the route's short name in place of the README's "70". No time is shown, because the
    // outcome carries none (the owner's decisions 1 to 3 of 14-10-2026). A cannot-hail's `reason` chooses its card;
    // `feed`'s is also the card for a reason the app does not know.
    func words(route: Stop.Route) -> Words {
        let bus = route.shortName
        let ask = "Ask someone at the stop, or raise your hand when you hear a bus."
        switch (outcome, reason) {
        case ("confirmed", _):
            // ConfirmPanel's destination, with "To" in lower case after the route, or the headsign whole.
            let destination = route.destination.hasPrefix("To ") ? " to \(route.destination.dropFirst(3))" : ", \(route.destination)"
            return Words(tag: "Confirmed", title: "The driver will stop", detail: "Route \(bus)\(destination). Be ready at the front of the stop.", action: "Done", secondary: nil)
        case ("unacknowledged", _):
            return Words(tag: "Not confirmed", title: "Signal the driver as well", detail: "Your hail reached the \(bus), but the driver hasn't confirmed.", action: "Done", secondary: nil)
        case (_, "deadline"):
            let next = nextDistanceM.map { " The next \(bus) is \(Stop.distance($0)) away." } ?? ""
            return Words(tag: "Could not hail", title: "Signal this bus yourself", detail: "This \(bus) is too close to stop safely, so no hail was sent.\(next)", action: "Hail the next \(bus)", secondary: "Done")
        case (_, "stale"):
            return Words(tag: "Could not hail", title: "Signal the driver yourself", detail: "We couldn't hail the \(bus): live times for this bus stopped updating. \(ask)", action: "Hail the next \(bus)", secondary: "Done")
        default:
            return Words(tag: "Could not hail", title: "Signal the driver yourself", detail: "We couldn't hail the \(bus): live bus times aren't available for this stop. \(ask)", action: "Try again", secondary: "Done")
        }
    }

    // StatusGlyph's solid shape, the colour token and signals.md's signal. The stream sends only three outcomes
    // (ADR-032 decision 3), so anything but confirmed and unacknowledged is cannot-hail.
    var look: (glyph: String, tone: String, cue: Cue) {
        switch outcome {
        case "confirmed": ("checkmark.circle.fill", "confirmed", .confirmed)
        case "unacknowledged": ("exclamationmark.triangle.fill", "unacknowledged", .unacknowledged)
        default: ("xmark.octagon.fill", "cannot-hail", .cannotHail)
        }
    }
}

// The card: glyph and tag, then title and detail, on the outcome's tint with a strong border in its colour. VoiceOver
// reads tag, title and detail in that order, as one element.
struct OutcomeCard: View {
    let outcome: Outcome
    let words: Outcome.Words

    var body: some View {
        let look = outcome.look
        let accent = Tokens.color(look.tone)
        VStack(alignment: .leading, spacing: Tokens.space("space-4")) {
            HStack(spacing: Tokens.space("space-2")) {
                Image(systemName: look.glyph)
                    .tokenFont("large-title")
                    .imageScale(.large)
                    .foregroundStyle(accent)
                Text(words.tag).tokenFont("footnote").textCase(.uppercase).foregroundStyle(accent)
            }
            Text(words.title).tokenFont("large-title").foregroundStyle(Tokens.color("ink"))
            Text(words.detail).tokenFont("body").foregroundStyle(Tokens.color("ink"))
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Tokens.space("space-6"))
        .padding(.horizontal, Tokens.space("space-4"))
        .bordered(fill: "\(look.tone)-soft", stroke: look.tone, strong: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(announcement(words))
    }
}

private func announcement(_ words: Outcome.Words) -> String {
    "\(words.tag). \(words.title). \(words.detail)"
}

struct OutcomeScreen: View {
    let model: HailViewModel
    let registration: HailViewModel.Registration
    let outcome: Outcome
    let play: @MainActor (Cue, String) -> Void
    @State private var arming = false
    @State private var failed = false

    init(model: HailViewModel, registration: HailViewModel.Registration, outcome: Outcome, play: @escaping @MainActor (Cue, String) -> Void = Signals.play(_:announcing:)) {
        self.model = model
        self.registration = registration
        self.outcome = outcome
        self.play = play
    }

    var body: some View {
        let words = outcome.words(route: registration.shown)
        VStack(spacing: 0) {
            ScrollView { OutcomeCard(outcome: outcome, words: words) }
            Spacer(minLength: Tokens.space("space-6"))
            VStack(spacing: Tokens.space("space-3")) {
                // A cannot card's main action is its fallback, which arms the same route and stop; Done is under it.
                MainAction(label: words.action) { words.secondary == nil ? model.done() : arm() }
                if let secondary = words.secondary {
                    MainAction(label: secondary, secondary: true) { model.done() }
                }
            }
            // Neither leaves while a fallback's Register is in flight, so Done never lands on Stops just before Armed.
            .disabled(arming)
        }
        .padding(.horizontal, Tokens.space("space-4"))
        .padding(.top, Tokens.space("space-12"))
        .padding(.bottom, Tokens.space("space-4"))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.color("surface"))
        // The sound and haptic first, then VoiceOver's tag, title and detail (signals.md §Rules).
        .onChange(of: outcome, initial: true) { play(outcome.look.cue, announcement(words)) }
        // Register's arming-failure alert (ADR-038, annotated 11-10-2026).
        .alert("Signal the driver yourself", isPresented: $failed) {
            Button("Try again") { arm() }
            Button("Close", role: .cancel) {}
        } message: {
            Text("We couldn't arm your hail.")
        }
    }

    // One registration per tap. Only a successful one leaves Outcome.
    private func arm() {
        guard !arming else { return }
        arming = true
        Task {
            defer { arming = false }
            do { try await model.register(stop: registration.stop, route: registration.route, duration: 0) } catch { failed = true }
        }
    }
}
