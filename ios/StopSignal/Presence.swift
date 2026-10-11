// Presence at the registered stop, sensed on the device while a hail is armed (S12; ADR-010's fine tier). The fixes stay
// here: only the transitions they make leave the device, as presence/start and presence/end (QR8; ADR-031 decision 2).
import CoreLocation

struct Fix: Sendable {
    let location: CLLocation
    let stationary: Bool

    // ADR-045: a phone arrives within 50 m of the stop and leaves beyond 100 m, so a fix between the two changes
    // nothing. A fix of unknown accuracy or one worse than 50 m changes nothing, nor does one taken while stationary.
    func present(at stop: CLLocation, was present: Bool) -> Bool {
        let accuracy = location.horizontalAccuracy
        guard !stationary, accuracy >= 0, accuracy <= 50 else { return present }
        return location.distance(from: stop) <= (present ? 100 : 50)
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
