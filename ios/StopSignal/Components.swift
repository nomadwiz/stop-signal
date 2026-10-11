// The design system's components that Stops and Register use (ADR-038): RouteChip, StopRow, ConfirmPanel and
// MainAction, after components/<Name>/README.md for behaviour and words and components/bundle.css for layout.
import SwiftUI

// A fill with a `line`-style border and no shadow; the border is `border-strong` in Increased contrast, and on the
// large route chip (design-system README §Layout and touch).
private struct Bordered: ViewModifier {
    let fill: String
    let stroke: String
    let radius: String
    var strong = false
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.radius(radius), style: .circular)
        content
            .background(Tokens.color(fill), in: shape)
            .overlay(shape.strokeBorder(Tokens.color(stroke), lineWidth: Tokens.size(strong || contrast == .increased ? "border-strong" : "border-control")))
            .contentShape(shape)
    }
}

extension View {
    func bordered(fill: String = "surface-raised", stroke: String = "line", radius: String = "radius-md", strong: Bool = false) -> some View {
        modifier(Bordered(fill: fill, stroke: stroke, radius: radius, strong: strong))
    }
}

// Always ink on a raised ground, never coloured by route (RouteChip). The small chip's 36 × 26 is bundle.css's.
struct RouteChip: View {
    let route: String
    var large = false

    var body: some View {
        Group {
            if large { Text(route).tokenFont("route-number") } else { Text(route).font(.system(.subheadline, design: .rounded, weight: .heavy)) }
        }
        .foregroundStyle(Tokens.color("ink"))
        .padding(.horizontal, Tokens.space(large ? "space-3" : "space-2"))
        .frame(minWidth: large ? 96 : 36, minHeight: large ? nil : 26)
        .bordered(stroke: "ink", radius: "radius-sm", strong: large)
        // A route number never wraps or shrinks; the text beside it does.
        .fixedSize()
        .accessibilityLabel("Route \(route)")
    }
}

// One stop: the whole row is the button, read by VoiceOver as one sentence (StopRow).
struct StopRow: View {
    let stop: Stop
    let distance: String?

    var body: some View {
        HStack(spacing: Tokens.space("space-3")) {
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.name).tokenFont("headline").foregroundStyle(Tokens.color("ink"))
                Text("Stop \(stop.code)" + (distance.map { " · \($0)" } ?? "")).tokenFont("footnote").foregroundStyle(Tokens.color("ink-muted"))
                Flow(spacing: Tokens.space("space-1")) {
                    ForEach(stop.routes) { RouteChip(route: $0.shortName) }
                }
                .padding(.top, Tokens.space("space-1"))
            }
            .wraps()
            Chevron()
        }
        .row()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(stop.name), stop \(stop.code)\(distance.map { ", \($0) away" } ?? ""). Routes \(stop.routes.map(\.shortName).joined(separator: ", ")).")
        .accessibilityAddTraits(.isButton)
    }
}

// One of a stop's routes, for choosing between them: StopRow's look with the route chip leading (the owner's
// decision of 11-10-2026).
struct RouteRow: View {
    let route: Stop.Route

    var body: some View {
        HStack(spacing: Tokens.space("space-3")) {
            RouteChip(route: route.shortName)
            Text(route.destination).tokenFont("headline").foregroundStyle(Tokens.color("ink")).wraps()
            Chevron()
        }
        .row()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Route \(route.shortName), \(route.destination)")
        .accessibilityAddTraits(.isButton)
    }
}

private struct Chevron: View {
    var body: some View {
        Image(systemName: "chevron.right").foregroundStyle(Tokens.color("ink-muted"))
    }
}

private extension View {
    // Takes the row's spare width and wraps rather than truncates: route and stop names are never cut off with "…"
    // (design-system README §Type).
    func wraps() -> some View {
        fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }

    func row() -> some View {
        padding(.vertical, Tokens.space("space-3"))
            .padding(.horizontal, Tokens.space("space-4"))
            .frame(maxWidth: .infinity, minHeight: Tokens.size("target-standard"), alignment: .leading)
            .bordered()
    }
}

// Register's check: route and stop together, each with its own Change (ConfirmPanel). At the accessibility text
// sizes each row stacks, so nothing truncates (design-system README §Type).
struct ConfirmPanel: View {
    let route: Stop.Route
    let stop: Stop
    let onEditRoute: () -> Void
    let onEditStop: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let row = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: Tokens.space("space-4"))) : AnyLayout(HStackLayout(spacing: Tokens.space("space-4")))
        VStack(alignment: .leading, spacing: Tokens.space("space-4")) {
            row {
                // The destination beside the chip while it fits on one line there, and under it when it does not, so
                // no word breaks.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Tokens.space("space-4")) { chip; destination }
                    VStack(alignment: .leading, spacing: Tokens.space("space-2")) { chip; destination }
                }
                .wraps()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Route \(route.shortName), \(route.destination)")
                change("Change route", onEditRoute)
            }
            Rectangle().fill(Tokens.color("line")).frame(height: 1).accessibilityHidden(true)
            row {
                VStack(alignment: .leading) {
                    label("Stop")
                    Text(stop.name).tokenFont("headline").foregroundStyle(Tokens.color("ink"))
                    label("Stop \(stop.code)")
                }
                .wraps()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Stop, \(stop.name), stop \(stop.code)")
                change("Change stop", onEditStop)
            }
        }
        .padding(Tokens.space("space-4"))
        .bordered()
    }

    private var chip: some View { RouteChip(route: route.shortName, large: true) }

    private var destination: some View {
        VStack(alignment: .leading) {
            label("Route")
            Text(route.destination).tokenFont("headline").foregroundStyle(Tokens.color("ink"))
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).tokenFont("footnote").foregroundStyle(Tokens.color("ink-muted"))
    }

    private func change(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text("Change")
                .tokenFont("headline")
                .foregroundStyle(Tokens.color("ink"))
                .padding(.horizontal, Tokens.space("space-4"))
                .frame(minWidth: Tokens.size("target-standard"), minHeight: Tokens.size("target-standard"))
                .bordered(radius: "radius-lg")
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// The screen's one main action: full width, 64 pt tall, signal yellow with an ink border (MainAction).
struct MainAction: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .tokenFont("headline")
                .foregroundStyle(Tokens.color("on-signal"))
                .multilineTextAlignment(.center)
                .padding(.horizontal, Tokens.space("space-4"))
                .frame(maxWidth: .infinity, minHeight: Tokens.size("target-primary"))
                .bordered(fill: "signal", stroke: "ink", radius: "radius-lg")
        }
        .buttonStyle(.plain)
    }
}

// Lays its children in rows, wrapping to the next row when one is full, so route chips never run off a row.
struct Flow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, point) in zip(subviews, arrange(subviews, width: bounds.width).points) {
            subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> (points: [CGPoint], size: CGSize) {
        var points: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (points, CGSize(width: widest, height: y + rowHeight))
    }
}
