// Presence at the registered stop, sensed on the device while a hail is armed (S12; ADR-010's fine tier). The fixes stay
// here: only the transitions they make leave the device, as presence/start and presence/end (QR8; ADR-031 decision 2).
import CoreLocation

struct Fix: Sendable {
    let location: CLLocation
    let stationary: Bool

    var accurate: Bool { location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 50 }

    // ADR-045: a phone arrives within 50 m of the stop and leaves beyond 100 m, so a fix between the two changes
    // nothing. A fix of unknown accuracy or one worse than 50 m changes nothing, nor does one taken while stationary,
    // unless the session has had no decisive fix yet (nil), which arming waits for (decision 5, decided 12-10-2026).
    // A new session starts unknown (nil), so its first fix outside the gap reports either way: the service holds a
    // passenger's presence at a stop until a presence-end (ADR-040, annotated 07-10-2026), and a session closed on
    // cancel or cannot-hail while present sends none.
    func present(at stop: CLLocation, was present: Bool?) -> Bool? {
        guard accurate, present == nil || !stationary else { return present }
        let metres = location.distance(from: stop)
        return metres <= 50 ? true : metres > 100 ? false : present
    }
}

// The phone's fixes from when the armed session opens until the view model drops the stream. A protocol so that tests
// send fixes without Core Location (ADR-012).
@MainActor
protocol Fixes {
    func open() -> AsyncStream<Fix>
}

// A CLBackgroundActivitySession keeps live updates coming with the screen locked under When In Use authorisation, given
// the Location updates background mode, and only a session made in the foreground becomes active
// (CLBackgroundActivitySession.h; ADR-009, annotated 02-10-2026). The view model opens this when Arm is tapped.
struct DeviceFixes: Fixes {
    func open() -> AsyncStream<Fix> {
        AsyncStream { feed in
            let session = CLBackgroundActivitySession()
            let updates = Task {
                defer { feed.finish() }
                do {
                    for try await update in CLLocationUpdate.liveUpdates() {
                        guard let location = update.location else { continue }
                        // iOS 18 renames isStationary to stationary, so the iOS 17 branch warns as deprecated.
                        let stationary = if #available(iOS 18, *) { update.stationary } else { update.isStationary }
                        feed.yield(Fix(location: location, stationary: stationary))
                    }
                } catch {}
            }
            feed.onTermination = { _ in
                updates.cancel()
                session.invalidate()
            }
        }
    }
}
