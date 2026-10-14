// The passenger app's view model (ADR-012 decision 2): the hail as the device last asked for it, the register and
// cancel intents, and the armed session that senses presence at the stop (S12). It holds no hail state of its own;
// the service's coordinator does, and says so through the outcome stream. The screens (#54, #55, #62) bind to it.
import Observation

@MainActor
@Observable
final class HailViewModel {
    struct Registration: Equatable {
        let stop: Stop
        let route: String

        // The route as the stop lists it, or its id alone where the stop does not list it.
        var shown: Stop.Route { stop.routes.first { $0.id == route } ?? Stop.Route(id: route, shortName: route, headsign: route) }
    }

    private(set) var registration: Registration?
    // The hail the armed session belongs to. Done clears `registration`, the hail shown, but not this, so the stream's
    // events still reach the session and a later cannot-hail still closes it (ADR-040).
    private var session: Registration?
    // Whether the phone is at the registered stop, by ADR-045's rule; nil until the session's first decisive fix.
    private(set) var present: Bool?
    // Whether a hail was delivered to the driver, which decides what a departure does (ADR-010 decision 1; ADR-040).
    private(set) var delivered = false
    // The registered hail's latest outcome.
    private(set) var outcome: Outcome?
    // The last status the stream sent. A status sent while the stream was closed is not replayed, so after a reopen
    // this is the last one received (the owner's decision 5 of 13-10-2026).
    private(set) var status = "waiting"
    // The outcome stream is closed, or the latest request failed: StopSignal is unreachable (ADR-038, annotated
    // 11-10-2026).
    private var closed = false
    private var failed = false
    // Cancel hail is in flight, so a reopen does not register the hail again.
    private var withdrawing = false
    private var sensing: Task<Void, Never>?
    private var listening: Task<Void, Never>?
    // A reopen's presence report and Register, which a cancel and a sensed transition wait for, so the service never
    // meets either before them: a cancel first would have the hail armed anew once it is withdrawn, and a presence-end
    // first would leave the passenger present at a stop they have left.
    private var rejoining: Task<Void, Never>?
    private let api: HailApi
    private let fixes: Fixes
    private let wait: Duration
    private let reopen: Duration

    // ponytail: an assumption, not a measured time. How long arming waits for a first decisive fix before Register
    // goes ahead without one (the owner's decision of 12-10-2026). Measure a cold fix on a device to set it.
    static let firstFixWait = Duration.seconds(5)

    // ponytail: a fixed wait between attempts to reopen a closed stream; back off if a device shows it costs battery.
    static let reopenWait = Duration.seconds(5)

    init(api: HailApi, fixes: Fixes, wait: Duration = firstFixWait, reopen: Duration = reopenWait) {
        self.api = api
        self.fixes = fixes
        self.wait = wait
        self.reopen = reopen
    }

    // What ArmedStatus shows (ADR-038). Unreachable outranks the rest, because nothing else holds while StopSignal
    // cannot be reached. Away from the stop, left outranks the service's status: the passenger has to act. A first
    // decisive fix beyond 100 m at arming is left with nothing delivered (the owner's decision 3 of 13-10-2026).
    var armed: Armed {
        if closed || failed { return .unreachable }
        if present == false { return .left(delivered: delivered) }
        return switch status {
        case "sent": .sent
        case "moved": .moved
        case "stale": .stale
        default: .waiting
        }
    }

    // The hail shown is live: waiting, sent, moved, stale, or left with nothing delivered, and no outcome (ADR-038,
    // annotated 11-10-2026 and 12-10-2026).
    var live: Bool { outcome == nil && !(present == false && delivered) }

    // The session opens before the registration's round trip, while the passenger is still tapping Arm, because only
    // a session made in the foreground becomes active (CLBackgroundActivitySession.h; ADR-009, annotated 02-10-2026).
    // Its first decisive fix is reported before Register, so a hail never commits on an arrival the service holds from
    // an earlier session (ADR-045 decision 5). Arming replaces any session before it.
    func register(stop: Stop, route: String, duration: Int) async throws {
        close()
        (present, delivered, status, withdrawing) = (nil, false, "waiting", false)
        let opened = fixes.open()
        let (first, reported) = AsyncStream.makeStream(of: Void.self)
        sensing = Task { await sense(stop, opened, reported) }
        let timer = Task { [wait] in
            try? await Task.sleep(for: wait)
            // A decisive fix within the wait holds Register until its report completes; `sense` finishes it then.
            // ponytail: a stalled report holds Register up to URLSession's 60 s default; shorten presence requests'
            // timeout if a device shows it.
            if present == nil { reported.finish() }
        }
        for await _ in first {}
        timer.cancel()
        do {
            try await api.register(stop: stop.id, route: route, duration: duration)
        } catch {
            close()
            throw error
        }
        // The outcome clears only now, so a failed "Hail the next 70" leaves the passenger on Outcome.
        let registration = Registration(stop: stop, route: route)
        (self.registration, session, outcome) = (registration, registration, nil)
        listening = Task { await listen(registration, duration) }
    }

    // Done leaves Outcome for Stops. It neither cancels the hail nor ends the session, which stays open until a
    // cannot-hail, a departure after a delivered hail or the next arming closes it (ADR-040; the owner's decision 4 of
    // 14-10-2026). An outcome after Done is not shown.
    func done() {
        registration = nil
    }

    // A failed cancel leaves the hail armed and shows unreachable, with Cancel hail still there.
    func cancel() async throws {
        guard let registration else { return }
        withdrawing = true
        await rejoining?.value
        do {
            try await api.cancel(stop: registration.stop.id, route: registration.route)
        } catch {
            (failed, withdrawing) = (true, false)
            throw error
        }
        close()
        (self.registration, session) = (nil, nil)
    }

    // The session stays open through confirmed and unacknowledged, and closes on cancel, on cannot-hail, or on a
    // departure after a delivered hail (ADR-040, annotated 11-10-2026). Dropping the fixes ends it. Nothing is tried
    // once it closes, so unreachable ends with it.
    private func close() {
        sensing?.cancel()
        listening?.cancel()
        rejoining?.cancel()
        (sensing, listening, rejoining, closed, failed) = (nil, nil, nil, false, false)
    }

    // A closed session's task is cancelled, but its stream still hands over fixes already buffered, and the view
    // model's state belongs to the newest session, so each step checks for cancellation first. `reported` finishes
    // once the first decisive fix is reported, which lets arming send Register; a first fix between 50 and 100 m is not
    // decisive, so the wait goes on (ADR-045 decision 5, decided 12-10-2026). A fix waits for a reopen's presence
    // report and Register, so a transition it senses never reaches the service before the older report (ADR-040).
    // ponytail: a failed transition is not retried; it shows unreachable until a later request succeeds.
    private func sense(_ stop: Stop, _ fixes: AsyncStream<Fix>, _ reported: AsyncStream<Void>.Continuation) async {
        defer { reported.finish() }
        for await fix in fixes where !Task.isCancelled {
            defer { if present != nil { reported.finish() } }
            await rejoining?.value
            guard !Task.isCancelled else { return }
            guard let now = fix.present(at: stop.location, was: present), now != present else { continue }
            present = now
            await attempt { try await now ? api.presenceStart(stop: stop.id) : api.presenceEnd(stop: stop.id) }
            // Cancelling the session ends the loop at its next wait, and that ends the fixes' stream.
            if !now, delivered, !Task.isCancelled { close() }
        }
    }

    // A request the session's own close cancelled is not a failure.
    private func attempt(_ request: () async throws -> Void) async {
        do {
            try await request()
            if !Task.isCancelled { failed = false }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }

    // Holds the outcome stream open, and reopens it whenever it closes. On a reopen, while the hail shown is live, the
    // app reports its presence, if it has had a decisive fix, and then registers again (the owner's decision 4 of
    // 13-10-2026), so a service that lost the hail, as a restart does, holds it and the passenger's presence again. A
    // service that still holds them changes nothing for either (`case 'register'` in coordinator.ts). The reopen runs
    // after the stream's replay, so an outcome sent while it was closed has already ended the hail shown, and a
    // replayed cannot-hail has closed the session (#168).
    private func listen(_ registration: Registration, _ duration: Int) async {
        var reopening = false
        while !Task.isCancelled {
            try? await api.outcomes(opened: { [self] in
                if reopening, live, !withdrawing {
                    let stop = registration.stop.id
                    let rejoin = Task {
                        if let present { await attempt { try await present ? api.presenceStart(stop: stop) : api.presenceEnd(stop: stop) } }
                        await attempt { try await api.register(stop: stop, route: registration.route, duration: duration) }
                    }
                    rejoining = rejoin
                    await rejoin.value
                }
                if !Task.isCancelled { closed = false }
            }) { [self] event in
                if !Task.isCancelled { receive(event) }
            }
            guard !Task.isCancelled else { return }
            (closed, reopening) = (true, true)
            try? await Task.sleep(for: reopen)
        }
    }

    func receive(_ event: Outcome) {
        guard event.stop == session?.stop.id, event.route == session?.route else { return }
        if event.status == "sent" || event.status == "moved" || event.outcome == "confirmed" || event.outcome == "unacknowledged" {
            delivered = true
        }
        if let status = event.status { self.status = status }
        if event.outcome != nil { outcome = event }
        // ponytail: a hail delivered just before a departure reached the service was spent by it, but `sent` can
        // arrive after this device left, and the session then stays open until cancel. Closing here instead could
        // cancel that presence-end in flight.
        if event.outcome == "cannot-hail" { close() }
    }
}
