// The passenger app's view model (ADR-012 decision 2): the hail as the device last asked for it, the register and
// cancel intents, and the armed session that senses presence at the stop (S12). It holds no hail state of its own;
// the service's coordinator does, and says so through the outcome stream. The screens (#54, #55, #62) bind to it.
import Observation

@MainActor
@Observable
final class HailViewModel {
    struct Registration: Equatable {
        let stop: String
        let route: String
    }

    private(set) var registration: Registration?
    // Whether the phone is at the registered stop, by ADR-045's rule.
    private(set) var present = false
    // Whether a hail was delivered to the driver, which decides what a departure does (ADR-010 decision 1; ADR-040).
    private(set) var delivered = false
    // The registered hail's latest outcome.
    private(set) var outcome: Outcome?
    private var armed: Task<Void, Never>?
    private let api: HailApi
    private let fixes: Fixes

    init(api: HailApi, fixes: Fixes) {
        self.api = api
        self.fixes = fixes
    }

    // Arming opens the session here, while the passenger is tapping Arm, because only a session made in the
    // foreground becomes active (ADR-009, annotated 02-10-2026).
    func register(stop: Stop, route: String, duration: Int) async throws {
        try await api.register(stop: stop.id, route: route, duration: duration)
        close()
        registration = Registration(stop: stop.id, route: route)
        (present, delivered, outcome) = (false, false, nil)
        armed = Task {
            async let stream: Void = listen()
            await sense(stop)
            await stream
        }
    }

    func cancel() async throws {
        guard let registration else { return }
        try await api.cancel(stop: registration.stop, route: registration.route)
        close()
        self.registration = nil
    }

    // The session stays open through confirmed and unacknowledged, and closes on cancel, on cannot-hail, or on a
    // departure after a delivered hail (ADR-040, annotated 11-10-2026). Dropping the fixes ends it.
    private func close() {
        armed?.cancel()
        armed = nil
    }

    // ponytail: a failed transition is not retried, and the stream is not reopened; #55 shows unreachable and re-arms.
    private func sense(_ stop: Stop) async {
        for await fix in fixes.open() {
            let now = fix.present(at: stop.location, was: present)
            guard now != present else { continue }
            present = now
            if now {
                try? await api.presenceStart(stop: stop.id)
            } else {
                try? await api.presenceEnd(stop: stop.id)
                // Cancelling the session ends the loop at its next wait, and that ends the fixes' stream.
                if delivered { close() }
            }
        }
    }

    private func listen() async {
        try? await api.outcomes { event in
            guard event.stop == registration?.stop, event.route == registration?.route else { return }
            if event.status == "sent" || event.status == "moved" || event.outcome == "confirmed" || event.outcome == "unacknowledged" {
                delivered = true
            }
            if event.outcome != nil { outcome = event }
            if event.outcome == "cannot-hail" { close() }
        }
    }
}
