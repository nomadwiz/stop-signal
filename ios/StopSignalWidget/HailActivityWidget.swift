// The widget extension that draws the hail's live activity, which the app starts, updates and ends (LiveActivity;
// bundle.css's .ss-live). The Dynamic Island's compact leading is the route chip, its compact trailing and minimal the
// glyph, and its expanded view the lock-screen layout (the owner's decision 51 of 14-10-2026).
import SwiftUI
import WidgetKit

@main
struct StopSignalWidgets: WidgetBundle {
    var body: some Widget { HailActivityWidget() }
}

struct HailActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: HailActivity.self) { context in
            HailActivityView(route: context.attributes.route, state: context.state)
                .padding(Tokens.space("space-4"))
                .activityBackgroundTint(HailActivity.color(HailActivity.background))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    HailActivityView(route: context.attributes.route, state: context.state)
                }
            } compactLeading: {
                Chip(route: context.attributes.route, compact: true)
            } compactTrailing: {
                Glyph(state: context.state)
            } minimal: {
                Glyph(state: context.state)
            }
        }
    }
}

// The route chip, then the title over the detail. An outcome, which has no detail, adds its solid glyph where the
// design system's minutes were (decision 49); a live state draws nothing there, as LiveActivity does for no minutes,
// and shows its glyph only in the Dynamic Island's compact views. VoiceOver reads the route, title and detail as one
// element.
struct HailActivityView: View {
    let route: String
    let state: HailActivity.ContentState

    var body: some View {
        HStack(spacing: Tokens.space("space-3")) {
            Chip(route: route)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.title).font(.headline).foregroundStyle(HailActivity.color(HailActivity.text))
                if let detail = state.detail {
                    Text(detail).font(.subheadline).foregroundStyle(HailActivity.color(HailActivity.secondary))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if state.detail == nil { Glyph(state: state).font(.title2) }
        }
        .accessibilityElement(children: .combine)
    }
}

// Signal yellow with on-signal text, never coloured by route (RouteChip). 40 points high on the lock screen, as
// bundle.css's .ss-live .ss-route, and to the Dynamic Island's height in its compact view.
struct Chip: View {
    let route: String
    var compact = false

    var body: some View {
        Text(route)
            .font(.system(compact ? .subheadline : .title2, design: .rounded, weight: .heavy))
            .foregroundStyle(HailActivity.color(HailActivity.onChip))
            .padding(.horizontal, Tokens.space(compact ? "space-1" : "space-2"))
            .frame(minWidth: compact ? nil : Tokens.size("target-standard"), minHeight: compact ? nil : 40)
            .background(HailActivity.color(HailActivity.chip), in: RoundedRectangle(cornerRadius: Tokens.radius("radius-sm")))
            .fixedSize()
            .accessibilityLabel("Route \(route)")
    }
}

// StatusGlyph's symbol in its tone's dark value, which suits the activity's dark ground, or white for the plain card.
// Decorative: the words beside it are what VoiceOver reads.
struct Glyph: View {
    let state: HailActivity.ContentState

    var body: some View {
        Image(systemName: state.glyph)
            .foregroundStyle(state.tone.map(Tokens.color) ?? HailActivity.color(HailActivity.text))
            .environment(\.colorScheme, .dark)
            .accessibilityHidden(true)
    }
}
