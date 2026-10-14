// Armed (design-system README §The four screens): ArmedStatus, then MainAction "Cancel hail". It has no back button
// and no swipe-back; the passenger leaves it only by cancelling or by an outcome (m1-revised.md §5.3; ADR-038).
import os
import SwiftUI

// ArmedStatus's six states (components/ArmedStatus/README.md). `left` carries whether a hail was delivered, which
// chooses its words, tone and signal.
enum Armed: Equatable {
    case waiting, sent, moved, stale, unreachable
    case left(delivered: Bool)

    // ArmedStatus's words, with the route's short name and the stop's code in place of the README's "70" and "6543".
    // The `moved` detail names no time, because the status event carries none (the owner's decision 1 of 13-10-2026).
    func words(route: String, stop: String) -> (tag: String, title: String, detail: String) {
        switch self {
        case .waiting: ("Waiting", "Waiting for the \(route)", "We'll hail the bus in time for it to stop for you. Stay at the stop.")
        case .sent: ("Hail sent", "Hail sent to the \(route)", "The bus is close. Waiting for the driver to confirm.")
        case .moved: ("Hail moved", "Hail moved to the next \(route)", "The first bus was on a different trip. Your hail is now on the next \(route).")
        case .stale: ("Lost live times", "Be ready to signal the driver", "We've lost live times for this \(route), so we may not be able to hail it. We'll still hail it if its times come back in time.")
        case .unreachable: ("No connection", "Signal the driver yourself", "We can't reach StopSignal right now, so your hail may not reach the driver. We'll keep trying.")
        case .left(delivered: false): ("Away from stop", "Go back to the stop to hail", "You moved away from stop \(stop), so we won't hail until you're back.")
        case .left(delivered: true): ("Away from stop", "Hail finished", "You moved away from stop \(stop) after we hailed the bus. If you're not on the bus, arm a new hail.")
        }
    }

    // StatusGlyph's SF Symbol for the state.
    var glyph: String {
        switch self {
        case .waiting: "dot.radiowaves.left.and.right"
        case .sent: "arrow.right"
        case .moved: "arrow.left.arrow.right"
        case .stale: "exclamationmark.triangle"
        case .unreachable: "antenna.radiowaves.left.and.right.slash"
        case .left: "figure.walk.departure"
        }
    }

    // The tone's token: the plain signal card for waiting and for left after a delivered hail, blue for sent and
    // moved, orange for the states that sound the heads-up.
    var tone: String? {
        switch self {
        case .waiting, .left(delivered: true): nil
        case .sent, .moved: "confirmed"
        case .stale, .unreachable, .left(delivered: false): "unacknowledged"
        }
    }

    // signals.md's Armed-screen changes; every change into waiting is one light tap (the owner's decision 2 of
    // 13-10-2026).
    var cue: Cue {
        switch self {
        case .waiting: .tap
        case .sent: .tick
        case .moved: .ticks
        case .stale, .unreachable, .left(delivered: false): .headsUp
        case .left(delivered: true): .none
        }
    }
}

// The status panel: glyph, tag, title and detail on the state's tone, read by VoiceOver as one sentence.
struct ArmedStatus: View {
    let state: Armed
    let words: (tag: String, title: String, detail: String)

    var body: some View {
        let accent = Tokens.color(state.tone ?? "ink")
        HStack(alignment: .top, spacing: Tokens.space("space-3")) {
            Image(systemName: state.glyph)
                .tokenFont("title")
                .foregroundStyle(accent)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Tokens.space("space-1")) {
                Text(words.tag).tokenFont("footnote").textCase(.uppercase).foregroundStyle(state.tone == nil ? Tokens.color("ink-muted") : accent)
                Text(words.title).tokenFont("large-title").foregroundStyle(Tokens.color("ink"))
                Text(words.detail).tokenFont("body").foregroundStyle(Tokens.color("ink"))
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Tokens.space("space-4"))
        .bordered(fill: state.tone.map { "\($0)-soft" } ?? "surface-raised", stroke: state.tone ?? "line")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(words.title). \(words.detail)")
    }
}

struct ArmedScreen: View {
    let model: HailViewModel
    let registration: HailViewModel.Registration
    let play: @MainActor (Cue, String) -> Void
    @State private var cancelling = false

    init(model: HailViewModel, registration: HailViewModel.Registration, play: @escaping @MainActor (Cue, String) -> Void = Signals.play(_:announcing:)) {
        self.model = model
        self.registration = registration
        self.play = play
    }

    var body: some View {
        let state = model.armed
        let words = state.words(route: registration.shown.shortName, stop: registration.stop.code)
        VStack(spacing: 0) {
            ScrollView { ArmedStatus(state: state, words: words) }
            Spacer(minLength: Tokens.space("space-6"))
            MainAction(label: "Cancel hail") { cancel() }
                .disabled(cancelling)
        }
        .padding(.horizontal, Tokens.space("space-4"))
        .padding(.top, Tokens.space("space-12"))
        .padding(.bottom, Tokens.space("space-4"))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tokens.color("surface"))
        // Arming is a change into the first state shown, so it plays too.
        .onChange(of: state, initial: true) { play(state.cue, "\(words.title). \(words.detail)") }
        .onAppear { os_signpost(.end, log: b7, name: "Arm") }
    }

    // One cancel per tap. A failed one leaves the model showing unreachable, with Cancel hail still there.
    private func cancel() {
        guard !cancelling else { return }
        cancelling = true
        Task {
            defer { cancelling = false }
            try? await model.cancel()
        }
    }
}
