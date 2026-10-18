import UIKit
import SwiftUI
import CoreFoundation

// Transport names only: command/Markdown behavior remains in the shared editor.
enum NativeEditorAction: String, CaseIterable {
    case insertLink, insertTable, insertCodeBlock, insertHorizontalRule
    case bold, italic, strikethrough, inlineCode
    case undo, redo, dismissKeyboard
}

struct NativeEditorState: Equatable {
    let focused: Bool
    let editable: Bool
    let canUndo: Bool
    let canRedo: Bool
    let selectionCollapsed: Bool
    let composing: Bool
    let interactionActive: Bool
    let navigationRevision: UInt64
    static let inactive = NativeEditorState(focused: false, editable: false, canUndo: false, canRedo: false,
                                            selectionCollapsed: false, composing: true, interactionActive: true,
                                            navigationRevision: 0)
    var isUnsafeDisable: Bool {
        !focused && !editable && !canUndo && !canRedo && !selectionCollapsed && composing && interactionActive
    }
    var permitsRouteGesture: Bool { !focused && !editable && selectionCollapsed && !composing && !interactionActive }

    static func decode(_ payload: [String: Any]) -> NativeEditorState? {
        guard Set(payload.keys) == Set(["focused", "editable", "canUndo", "canRedo", "selectionCollapsed",
                                       "composing", "interactionActive", "navigationRevision"]) else { return nil }
        func boolean(_ key: String) -> Bool? {
            guard let value = payload[key] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
            return value.boolValue
        }
        guard let focused = boolean("focused"), let editable = boolean("editable"),
              let undo = boolean("canUndo"), let redo = boolean("canRedo"),
              let collapsed = boolean("selectionCollapsed"), let composing = boolean("composing"),
              let interaction = boolean("interactionActive"),
              let revision = payload["navigationRevision"] as? NSNumber,
              CFGetTypeID(revision) != CFBooleanGetTypeID() else { return nil }
        let number = revision.doubleValue
        guard number.isFinite, number >= 0, number <= 9_007_199_254_740_991, number.rounded(.down) == number else { return nil }
        return NativeEditorState(focused: focused, editable: editable, canUndo: undo, canRedo: redo,
                                 selectionCollapsed: collapsed, composing: composing, interactionActive: interaction,
                                 navigationRevision: UInt64(number))
    }
}

// Per physical editor realm. Temporary/malformed disables never reset the
// semantic producer watermark or authorize navigation.
struct NativeEditorStateValidator {
    enum Failure: Error, Equatable { case invalid, stale }
    private(set) var lastValidated: NativeEditorState?
    mutating func validate(_ state: NativeEditorState?) throws -> NativeEditorState {
        guard let state = state else { throw Failure.invalid }
        if state.isUnsafeDisable { return .inactive }
        if let prior = lastValidated,
           state.navigationRevision < prior.navigationRevision
            || (state.navigationRevision == prior.navigationRevision && state != prior) { throw Failure.stale }
        lastValidated = state
        return state
    }
}

@MainActor
final class NativeKeyboardToolbarModel: ObservableObject {
    @Published var state = NativeEditorState.inactive
    @Published var actionsAvailable = false
    var canAct: Bool { actionsAvailable && state.focused && state.editable }
}

@MainActor
struct NativeKeyboardToolbarView: View {
    @ObservedObject var model: NativeKeyboardToolbarModel
    let perform: (NativeEditorAction) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace

    var body: some View {
        Group {
            if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
                GlassEffectContainer(spacing: 8) {
                    controls
                        .glassEffect(.regular, in: Capsule())
                        .glassEffectID("editor-keyboard-toolbar", in: glassNamespace)
                        .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
                }
            } else {
                controls.background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                    .overlay(Capsule().stroke(Color(uiColor: .separator), lineWidth: contrast == .increased ? 2 : 0.5))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .ignoresSafeArea(.keyboard, edges: .bottom)
    }

    private var controls: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    Menu {
                        action("Insert link", symbol: "link", .insertLink)
                        action("Insert table", symbol: "tablecells", .insertTable)
                        action("Insert code block", symbol: "chevron.left.forwardslash.chevron.right", .insertCodeBlock)
                        action("Insert horizontal rule", symbol: "minus", .insertHorizontalRule)
                    } label: { icon("plus") }
                    .accessibilityLabel("Insert")
                    .accessibilityIdentifier("native.editor.insert")
                    Menu {
                        action("Bold", symbol: "bold", .bold)
                        action("Italic", symbol: "italic", .italic)
                        action("Strikethrough", symbol: "strikethrough", .strikethrough)
                        action("Inline code", symbol: "chevron.left.forwardslash.chevron.right", .inlineCode)
                    } label: { icon("textformat") }
                    .accessibilityLabel("Formatting")
                    .accessibilityIdentifier("native.editor.format")
                    Button { perform(.undo) } label: { icon("arrow.uturn.backward") }
                        .disabled(!model.state.canUndo)
                        .accessibilityLabel("Undo")
                        .accessibilityIdentifier("native.editor.undo")
                    Button { perform(.redo) } label: { icon("arrow.uturn.forward") }
                        .disabled(!model.state.canRedo)
                        .accessibilityLabel("Redo")
                        .accessibilityIdentifier("native.editor.redo")
                }
            }
            Divider().frame(height: 24).accessibilityHidden(true)
            Button { perform(.dismissKeyboard) } label: { icon("keyboard.chevron.compact.down") }
                .accessibilityLabel("Dismiss keyboard")
                .accessibilityIdentifier("native.editor.dismiss-keyboard")
        }
        .padding(.horizontal, 8)
        .font(.body)
        .foregroundColor(.primary)
        .buttonStyle(.plain)
        .disabled(!model.canAct)
    }

    private func icon(_ symbol: String) -> some View {
        Image(systemName: symbol).padding(8).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    }
    private func action(_ title: String, symbol: String, _ command: NativeEditorAction) -> some View {
        Button { perform(command) } label: { Label(title, systemImage: symbol) }
            .accessibilityIdentifier("native.editor.action.\(command.rawValue)")
    }
}
