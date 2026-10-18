import SwiftUI
import UIKit
import OSLog

// Fixed labels only: diagnostics never include paths, note data, or identifiers.
struct NativePhaseTimer {
    enum Phase: String { case open, refresh, listing, editorReady, editorTimeout }
    private let start = ProcessInfo.processInfo.systemUptime
    private static let log = Logger(subsystem: "app.zorid.notes", category: "native-shell")
    func finish(_ phase: Phase) {
        let milliseconds = Int((ProcessInfo.processInfo.systemUptime - start) * 1_000)
        Self.log.info("phase=\(phase.rawValue, privacy: .public) duration_ms=\(milliseconds, privacy: .public)")
    }
}

// Both arrows share ONE material surface. Button hit areas remain separate.
struct NativeHistoryControls: View {
    let backEnabled: Bool
    let forwardEnabled: Bool
    let identifierPrefix: String
    var backLabel = "Back"
    let navigate: (Int) -> Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Group {
            if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
                controls.glassEffect(.regular.interactive(), in: Capsule())
            } else {
                controls.background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                    .overlay(Capsule().stroke(Color(uiColor: .separator), lineWidth: contrast == .increased ? 2 : 0.5))
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 0) {
            Button { navigate(-1) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44).contentShape(Rectangle()) }
                .disabled(!backEnabled)
                .accessibilityLabel(backLabel)
                .accessibilityIdentifier(identifierPrefix + ".back")
            Button { navigate(1) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44).contentShape(Rectangle()) }
                .disabled(!forwardEnabled)
                .accessibilityLabel("Forward")
                .accessibilityIdentifier(identifierPrefix + ".forward")
        }
        .padding(.horizontal, 4)
        .font(.system(size: 17, weight: .semibold))
        .foregroundColor(.primary)
        .buttonStyle(.plain)
    }
}

// Generic shapes, never fake note content or actionable rows. No timers/polling.
struct NativeLoadingSkeleton: View {
    let editor: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: editor ? 24 : 18) {
            if editor {
                RoundedRectangle(cornerRadius: 6).frame(height: 28).padding(.trailing, 80)
            }
            ForEach(0..<(editor ? 7 : 5), id: \.self) { index in
                HStack(spacing: 14) {
                    if !editor { RoundedRectangle(cornerRadius: 5).frame(width: 28, height: 32) }
                    VStack(alignment: .leading, spacing: 8) {
                        RoundedRectangle(cornerRadius: 4).frame(height: 14).padding(.trailing, CGFloat(index % 3) * 28)
                        if !editor { RoundedRectangle(cornerRadius: 3).frame(height: 9).padding(.trailing, 70) }
                    }
                }
            }
        }
        .foregroundColor(Color(uiColor: .tertiaryLabel))
        .opacity(reduceMotion ? 0.6 : (pulse ? 0.35 : 0.65))
        .animation(reduceMotion ? nil : .easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
        .onAppear { pulse = !reduceMotion }
        .onChange(of: reduceMotion) { pulse = !$0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(editor ? "Loading editor" : "Loading vault")
        .accessibilityIdentifier(editor ? "native.editor.loading" : "native.pages.loading")
        .allowsHitTesting(false)
    }
}

struct NativeEditorLoadingView: View {
    var body: some View {
        VStack { NativeLoadingSkeleton(editor: true).padding(24); Spacer(minLength: 0) }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
    }
}
