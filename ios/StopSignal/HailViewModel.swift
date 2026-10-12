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
    // Whether the phone is at the registered stop, by ADR-045's rule; nil until the session's first decisive fix.
    private(set) var present: Bool?
    // Whether a hail was delivered to the driver, which decides what a departure does (ADR-010 decision 1; ADR-040).
    private(set) var delivered = false
    // The registered hail's latest outcome.
    private(set) var outcome: Outcome?
    private var sensing: Task<Void, Never>?
    private var listening: Task<Void, Never>?
    private let api: HailApi
    private let fixes: Fixes
    private let wait: Duration

    // ponytail: an assumption, not a measured time. How long arming waits for a first decisive fix before Register
    // goes ahead without one (the owner's decision of 12-10-2026). Measure a cold fix on a device to set it.
    static let firstFixWait = Duration.seconds(5)

    init(api: HailApi, fixes: Fixes, wait: Duration = firstFixWait) {
        self.api = api
        self.fixes = fixes
        self.wait = wait
    }

    // The session opens before the registration's round trip, while the passenger is still tapping Arm, because only
    // a session made in the foreground becomes active (CLBackgroundActivitySession.h; ADR-009, annotated 02-10-2026).
    // Its first decisive fix is reported before Register, so a hail never commits on an arrival the service holds from
    // an earlier session (ADR-045 decision 5). Arming replaces any session before it.
    func register(stop: Stop, route: String, duration: Int) async throws {
        close()
        (present, delivered, outcome) = (nil, false, nil)
        let opened = fixes.open()
        let (first, reported) = AsyncStream.makeStream(of: Void.self)
        sensing = Task { await sense(stop, opened, reported) }
        let timer = Task { [wait] in
            try? await Task.sleep(for: wait)
            reported.finish()
        }
        for await _ in first {}
        timer.cancel()
        do {
            try await api.register(stop: stop.id, route: route, duration: duration)
        } catch {
            close()
            throw error
        }
        registration = Registration(stop: stop.id, route: route)
        listening = Task { await listen() }
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
        sensing?.cancel()
        listening?.cancel()
        (sensing, listening) = (nil, nil)
    }

    // A closed session's task is cancelled, but its stream still hands over fixes already buffered, and the view
    // model's state belongs to the newest session, so each step checks for cancellation first. `reported` finishes
    // once the first decisive fix is reported, which lets arming send Register; a first fix between 50 and 100 m is not
    // decisive, so the wait goes on (the owner's decision 28 of 12-10-2026).
    // ponytail: a failed transition is not retried, and the stream is not reopened; #55 shows unreachable and re-arms.
    private func sense(_ stop: Stop, _ fixes: AsyncStream<Fix>, _ reported: AsyncStream<Void>.Continuation) async {
        defer { reported.finish() }
        for await fix in fixes where !Task.isCancelled {
            defer { if present != nil { reported.finish() } }
            guard let now = fix.present(at: stop.location, was: present, first: present == nil), now != present else { continue }
            present = now
            if now {
                try? await api.presenceStart(stop: stop.id)
            } else {
                try? await api.presenceEnd(stop: stop.id)
                // Cancelling the session ends the loop at its next wait, and that ends the fixes' stream.
                if delivered, !Task.isCancelled { close() }
            }
        }
    }

    private func listen() async {
        try? await api.outcomes { event in
            guard !Task.isCancelled, event.stop == registration?.stop, event.route == registration?.route else { return }
            if event.status == "sent" || event.status == "moved" || event.outcome == "confirmed" || event.outcome == "unacknowledged" {
                delivered = true
            }
            if event.outcome != nil { outcome = event }
            // ponytail: a hail delivered just before a departure reached the service was spent by it, but `sent` can
            // arrive after this device left, and the session then stays open until cancel. Closing here instead could
            // cancel that presence-end in flight.
            if event.outcome == "cannot-hail" { close() }
        }
    }
}
