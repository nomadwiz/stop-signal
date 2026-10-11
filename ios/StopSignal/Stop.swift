// The stops the passenger can hail from, bundled as stops.json and cut from the timetable by ios/cut-stops.ts
// (ADR-043). Search and the nearest-first sort run on the device, so no location leaves it (QR8).
import CoreLocation

struct Stop: Decodable, Hashable, Identifiable {
    struct Route: Decodable, Hashable, Identifiable {
        let id: String
        let shortName: String
        let headsign: String

        // ConfirmPanel's destination: the text after the headsign's last " to ", ignoring case, or the headsign whole
        // when it has none (the owner's decision of 11-10-2026).
        var destination: String {
            guard let to = headsign.range(of: " to ", options: [.caseInsensitive, .backwards]) else { return headsign }
            return "To " + headsign[to.upperBound...]
        }
    }

    let id: String
    let code: String
    let name: String
    let lat: Double
    let lon: Double
    let routes: [Route]

    var location: CLLocation { CLLocation(latitude: lat, longitude: lon) }

    static let bundled: [Stop] = {
        struct File: Decodable { let stops: [Stop] }
        return try! JSONDecoder().decode(File.self, from: Data(contentsOf: Bundle.main.url(forResource: "stops", withExtension: "json")!)).stops
    }()

    // The stops whose name or code holds `query`, nearest first, or by name while the device has no location.
    static func found(_ query: String, near here: CLLocation?) -> [Stop] {
        let query = query.trimmingCharacters(in: .whitespaces)
        let matched = query.isEmpty ? bundled : bundled.filter { $0.name.localizedStandardContains(query) || $0.code.contains(query) }
        guard let here else { return matched.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }
        return matched.sorted { here.distance(from: $0.location) < here.distance(from: $1.location) }
    }

    // "40 m" under a kilometre, "1.2 km" from there, as StopRow and OutcomeCard write distances.
    func distance(from here: CLLocation) -> String {
        let metres = here.distance(from: location)
        return metres < 1000 ? "\(Int(metres.rounded())) m" : String(format: "%.1f km", metres / 1000)
    }
}
