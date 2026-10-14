// The hail shown, on the lock screen and in the Dynamic Island (S10; LiveActivity; the owner's decisions 48 to 51 of
// 14-10-2026). HailViewModel says what the activity shows; LiveActivities hands that to ActivityKit as it changes.
// ActivityKit has not marked Activity Sendable; the app touches it only on the main actor.
@preconcurrency import ActivityKit
import Observation

// What the activity shows, and whether it has ended.
struct LockScreen: Equatable {
    let route: String
    let state: HailActivity.ContentState
    // Ended with ActivityKit's default dismissal, which keeps it on the lock screen for up to four hours: an outcome,
    // or a departure after a delivered hail (decision 50).
    let ended: Bool
}

extension Armed {
    // LiveActivity's words (decision 48): ArmedStatus's first line shortened, because the route chip carries the route,
    // and one short phrase.
    func brief(stop: String) -> (title: String, detail: String) {
        switch self {
        case .waiting: ("Waiting · \(stop)", "We'll hail in time for it to stop")
        case .sent: ("Hail sent", "Waiting for driver to confirm")
        case .moved: ("Hail moved", "Now on the next bus")
        case .stale: ("Be ready to signal", "Lost live times for this bus")
        case .unreachable: ("Signal the driver yourself", "Can't reach StopSignal")
        case .left(delivered: false): ("Go back to the stop", "We won't hail until you're back")
        case .left(delivered: true): ("Hail finished", "If you're not on the bus, arm a new hail")
        }
    }
}

extension HailViewModel {
    // What the activity shows of the hail shown. Nil removes it at once: Cancel hail and Done leave no hail shown.
    // An outcome shows OutcomeCard's title and solid glyph, with no detail (decision 49). A departure after a delivered
    // hail shows "Hail finished" even while unreachable shows, because closing the session ends unreachable.
    var lockScreen: LockScreen? {
        guard let registration else { return nil }
        let route = registration.shown
        if let outcome {
            let look = outcome.look
            return LockScreen(route: route.shortName, state: .init(title: outcome.words(route: route).title, detail: nil, glyph: look.glyph, tone: look.tone), ended: true)
        }
        let state = live ? armed : .left(delivered: true)
        let brief = state.brief(stop: registration.stop.name)
        return LockScreen(route: route.shortName, state: .init(title: brief.title, detail: brief.detail, glyph: state.glyph, tone: state.tone), ended: !live)
    }
}

// Follows the app's HailViewModel into ActivityKit. It observes the model, not a view, so the activity follows the hail
// while the phone is locked. Updates are the app's own, with no remote push, so the app has no aps-environment
// entitlement; and no update sets an AlertConfiguration, because the outcome's sound is the one Signals plays.
@MainActor
enum LiveActivities {
    private static var current: Activity<HailActivity>?
    private static var shown: LockScreen?
    private static var applying: Task<Void, Never>?

    // Called once, at launch: an activity left showing by an earlier launch ends at once.
    static func follow(_ model: HailViewModel) {
        applying = Task { await removeAll() }
        observe(model)
    }

    private static func observe(_ model: HailViewModel) {
        let screen = withObservationTracking { model.lockScreen } onChange: {
            Task { @MainActor in observe(model) }
        }
        let previous = shown
        shown = screen
        // Each change waits for the one before it, so ActivityKit meets them in order.
        applying = Task { [applying] in
            await applying?.value
            await show(screen, after: previous)
        }
    }

    private static func show(_ screen: LockScreen?, after previous: LockScreen?) async {
        guard screen != previous else { return }
        guard let screen else { return await removeAll() }
        let content = ActivityContent(state: screen.state, staleDate: nil)
        if previous?.ended == false {
            if screen.ended { await current?.end(content, dismissalPolicy: .default) } else { await current?.update(content) }
            return
        }
        // A new hail, after none or after an ended one, which goes at once. A request is made in the foreground, where
        // arming is; one the system refuses, as when Live Activities are off, leaves the hail without an activity.
        await removeAll()
        guard !screen.ended else { return }
        current = try? Activity.request(attributes: HailActivity(route: screen.route), content: content)
    }

    // ponytail: ending an activity that has already ended, to remove it at once, is not shown by ActivityKit's
    // documentation; Done after an outcome relies on it. A device check confirms it.
    private static func removeAll() async {
        await current?.end(nil, dismissalPolicy: .immediate)
        for activity in Activity<HailActivity>.activities where activity.id != current?.id {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        current = nil
    }
}
