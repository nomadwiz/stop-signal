// The design system's colours, type styles, spacing and target sizes, read at run time from tokens.json
// (ADR-038 decisions 1 and 3). tokens.json is a byte-identical copy of doc/design/design-system/tokens.json in
// nomadwiz/stop-signal-doc; recopy it whenever ADR-038 records a new version of the design system.
import SwiftUI

enum Tokens {
    private struct File: Decodable, Sendable {
        struct List<Token: Decodable & Sendable>: Decodable, Sendable { let tokens: [Token] }
        struct Value: Decodable { let name: String; let value: String }
        struct Colour: Decodable { let name: String; let value: [String: String] }
        struct Style: Decodable { let name: String; let family: String?; let fontSize: String; let fontWeight: Int }
        struct Types: Decodable { let groups: [Group] }
        struct Group: Decodable { let styles: [Style] }

        let color: List<Colour>
        let type: Types
        let spacing: List<Value>
        let radius: List<Value>
        let size: List<Value>
    }

    struct TypeStyle {
        let relativeTo: Font.TextStyle
        let size: CGFloat
        let weight: Font.Weight
        let design: Font.Design
    }

    private static let file = try! JSONDecoder().decode(File.self, from: Data(contentsOf: Bundle.main.url(forResource: "tokens", withExtension: "json")!))

    // Follows the system appearance, and takes the Increased contrast theme when Increase Contrast is on
    // (design-system README §Colour).
    static func color(_ name: String) -> Color {
        let value = file.color.tokens.first { $0.name == name }!.value
        return Color(uiColor: UIColor { traits in
            let theme = traits.accessibilityContrast == .high ? "contrast" : traits.userInterfaceStyle == .dark ? "dark" : "light"
            let rgb = Int(value[theme]!.dropFirst(), radix: 16)!
            return UIColor(red: CGFloat(rgb >> 16 & 0xff) / 255, green: CGFloat(rgb >> 8 & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
        })
    }

    static func space(_ name: String) -> CGFloat { points(file.spacing.tokens, name) }
    static func size(_ name: String) -> CGFloat { points(file.size.tokens, name) }
    static func radius(_ name: String) -> CGFloat { points(file.radius.tokens, name) }

    // An iOS style's size is its size at the default Large setting; `tokenFont` scales it with Dynamic Type relative to
    // the Apple text style it stands for, so no point size is fixed (design-system README §Type).
    static func type(_ name: String) -> TypeStyle {
        let style = file.type.groups.flatMap(\.styles).first { $0.name == name }!
        let relativeTo: Font.TextStyle = switch name {
        case "route-number", "large-title": .largeTitle
        case "title": .title
        case "headline": .headline
        case "footnote": .footnote
        default: .body
        }
        let weight: Font.Weight = switch style.fontWeight {
        case 800: .heavy
        case 700: .bold
        case 600: .semibold
        default: .regular
        }
        return TypeStyle(relativeTo: relativeTo, size: px(style.fontSize), weight: weight, design: style.family == "rounded" ? .rounded : .default)
    }

    private static func points(_ tokens: [File.Value], _ name: String) -> CGFloat {
        px(tokens.first { $0.name == name }!.value)
    }

    // tokens.json writes lengths as "16px"; one CSS px is one iOS point.
    private static func px(_ value: String) -> CGFloat {
        CGFloat(Double(value.dropLast(2))!)
    }
}

private struct TokenFont: ViewModifier {
    let style: Tokens.TypeStyle
    @ScaledMetric private var size: CGFloat

    init(_ name: String) {
        style = Tokens.type(name)
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.relativeTo)
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: style.weight, design: style.design))
    }
}

extension View {
    func tokenFont(_ name: String) -> some View {
        modifier(TokenFont(name))
    }
}
