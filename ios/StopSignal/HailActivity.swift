// The armed hail's live activity (S10; LiveActivity): what the app starts, updates and ends through ActivityKit, and
// what the widget extension draws on the lock screen and in the Dynamic Island. Both targets build this file.
// No state carries minutes, because neither the status event nor the outcome carries a time (ADR-038).
import ActivityKit
import SwiftUI

struct HailActivity: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let title: String
        // Nil once an outcome ends the activity, which shows only its title (the owner's decision 49 of 14-10-2026).
        let detail: String?
        // StatusGlyph's SF Symbol, and its tone's token, or nil for the plain card's white.
        let glyph: String
        let tone: String?
    }

    // The route's short name, which the chip shows.
    let route: String

    // Fixed colours, not theme tokens, so the activity reads the same on a light or a dark lock screen (LiveActivity).
    static let background = 0x1c1c1e
    static let text = 0xffffff
    static let secondary = 0xd1d1d6
    // The route chip in signal yellow, with on-signal's light value on it.
    static let chip = 0xf5c400
    static let onChip = 0x151515

    static func color(_ rgb: Int) -> Color {
        Color(red: Double(rgb >> 16 & 0xff) / 255, green: Double(rgb >> 8 & 0xff) / 255, blue: Double(rgb & 0xff) / 255)
    }
}
