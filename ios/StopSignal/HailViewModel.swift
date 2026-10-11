// The passenger app's view model (ADR-012 decision 2): the hail as the device last asked for it, and the register
// and cancel intents. It holds no session state of its own; the service's coordinator does, and says so through
// the outcome stream. The screens (#54, #55, #62) bind to it.
import Observation

@MainActor
@Observable
final class HailViewModel {
    struct Registration: Equatable {
        let stop: String
        let route: String
    }

    private(set) var registration: Registration?
    private let api: HailApi

    init(api: HailApi) {
        self.api = api
    }

    func register(stop: String, route: String, duration: Int) async throws {
        try await api.register(stop: stop, route: route, duration: duration)
        registration = Registration(stop: stop, route: route)
    }

    func cancel() async throws {
        guard let registration else { return }
        try await api.cancel(stop: registration.stop, route: registration.route)
        self.registration = nil
    }
}
