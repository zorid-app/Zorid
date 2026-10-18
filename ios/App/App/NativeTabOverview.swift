import SwiftUI
import UIKit
import Combine

// A caller-owned, memory-only cache of already captured native snapshots. No
// decoder, vault reads, renderer, WKWebView or live editor is created here.
// Capture/downsample within these limits at the single active host boundary.
@MainActor
final class NativeTabSnapshotCache: ObservableObject {
    static let maximumCount = 12
    static let maximumBytes = 8 * 1024 * 1024
    static let maximumSnapshotBytes = 4 * 1024 * 1024
    static let maximumPixelDimension = 1024

    private struct Entry {
        let image: UIImage
        let cost: Int
    }
    @Published private var entries: [NativeDocumentTab: Entry] = [:]
    private var order: [NativeDocumentTab] = []
    private var cost = 0

    func image(for tab: NativeDocumentTab) -> UIImage? {
        guard !tab.isHome else { return nil }
        return entries[tab]?.image
    }

    // Full metadata key prevents a replacement (same tab UUID, different file or
    // scope) from ever displaying the old file's preview. Home never has pixels.
    @discardableResult
    func insert(_ image: UIImage, for tab: NativeDocumentTab) -> Bool {
        guard !tab.isHome, image.images == nil, let pixels = image.cgImage,
              pixels.width > 0, pixels.height > 0,
              pixels.width <= Self.maximumPixelDimension, pixels.height <= Self.maximumPixelDimension,
              pixels.bytesPerRow > 0,
              pixels.bytesPerRow <= Self.maximumSnapshotBytes / pixels.height else { return false }
        let bytes = pixels.bytesPerRow * pixels.height
        // Forget previous snapshots of this tab, including renamed/replaced files.
        for key in order.filter({ $0.id == tab.id }) { remove(key) }
        while order.count >= Self.maximumCount || cost + bytes > Self.maximumBytes {
            guard let oldest = order.first else { break }
            remove(oldest)
        }
        // Keep only the bounded CGImage, not an animated/encoded source container.
        entries[tab] = Entry(image: UIImage(cgImage: pixels, scale: 1, orientation: image.imageOrientation), cost: bytes)
        cost += bytes
        order.append(tab)
        return true
    }

    // Call after a committed model transition (never after a merely prepared one).
    // It also releases closed/replaced previews immediately, not just on eviction.
    func retainSnapshots(for tabs: [NativeDocumentTab]) {
        let live = Set(tabs.filter { !$0.isHome })
        for key in order.filter({ !live.contains($0) }) { remove(key) }
    }

    func removeAll() {
        entries = [:]
        order = []
        cost = 0
    }

    private func remove(_ key: NativeDocumentTab) {
        if let removed = entries.removeValue(forKey: key) { cost -= removed.cost }
        order.removeAll { $0 == key }
    }
}

// Presentation only: all actions go to the owning coordinator. In particular,
// selecting a card must not dismiss this screen before save/close succeeds.
// onDone returns to the already selected tab through that same coordinator.
@MainActor
struct NativeTabOverview: View {
    @ObservedObject var model: NativeDocumentTabs
    @ObservedObject var snapshots: NativeTabSnapshotCache
    let onIntent: (NativeDocumentTabs.Intent) -> Void
    let onDone: () -> Void
    // On failure, caller cancels the model intent AND clears its busy guard
    // before offering recovery; this view does not cancel save/close work.
    var isInteractionBlocked: Bool = false
    var transitionMessage: String? = nil
    var onRetryTransition: (() -> Void)? = nil
    var onResumeSource: (() -> Void)? = nil
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var actionsBlocked: Bool { isInteractionBlocked || model.pendingIntent != nil }
    private var statusMessage: String? {
        if let message = transitionMessage, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return message
        }
        return actionsBlocked ? "Finishing the current tab change…" : nil
    }

    private func request(_ intent: NativeDocumentTabs.Intent) {
        guard !actionsBlocked else { return }
        onIntent(intent)
    }

    private var columns: [GridItem] {
        dynamicType.isAccessibilitySize ? [GridItem(.flexible())] :
            [GridItem(.adaptive(minimum: 150, maximum: 280), spacing: 20, alignment: .top)]
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                LazyVGrid(columns: columns, alignment: .center, spacing: 24) {
                    ForEach(model.tabs) { tab in card(tab) }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 20)
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height, alignment: .bottom)
            }
        }
        .background(Color(uiColor: .secondarySystemBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: model.tabs)
        // This guards sheet dismissal only. The hosting UIKit coordinator must
        // separately guard Back, edge-pop and every programmatic stack exit.
        .interactiveDismissDisabled(actionsBlocked)
        .onAppear {
            snapshots.retainSnapshots(for: model.tabs)
            announceStatus(statusMessage)
        }
        .onChange(of: statusMessage) { message in announceStatus(message) }
        .onChange(of: model.tabs) { tabs in snapshots.retainSnapshots(for: tabs) }
        .accessibilityIdentifier("native.tabs.overview")
    }

    private func card(_ tab: NativeDocumentTab) -> some View {
        let selected = tab.id == model.selectedTabID
        return VStack(spacing: 10) {
            ZStack(alignment: .topTrailing) {
                Button { request(.select(tab.id)) } label: {
                    thumbnail(tab)
                        .aspectRatio(0.76, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 22, style: .continuous)
                                .strokeBorder(selected ? Color.purple : Color(uiColor: .separator),
                                              lineWidth: selected ? (contrast == .increased ? 5 : 3) : 1)
                        }
                        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(actionsBlocked)
                .accessibilityLabel(Text(tab.displayTitle))
                .accessibilityHint("Select tab")
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("native.tabs.select." + tab.id.uuidString.lowercased())
                .accessibilityAction(named: Text("Close tab")) {
                    request(.close(tab.id))
                }

                // Separate sibling button: closing never also selects the card.
                Button { request(.close(tab.id)) } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .modifier(TabOverviewControlSurface())
                .padding(8)
                .disabled(actionsBlocked)
                .accessibilityLabel(Text("Close \(tab.displayTitle) tab"))
                .accessibilityIdentifier("native.tabs.close." + tab.id.uuidString.lowercased())
            }
            Text(tab.displayTitle)
                .font(.body)
                .multilineTextAlignment(.center)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true) // The select and close buttons name it.
        }
    }

    private func thumbnail(_ tab: NativeDocumentTab) -> some View {
        ZStack {
            Color(uiColor: .systemBackground)
            if let image = snapshots.image(for: tab) {
                // The snapshot is decorative; controls expose native labels.
                GeometryReader { geometry in
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geometry.size.width, height: geometry.size.height)
                        .clipped()
                }
            } else {
                Image(systemName: tab.isHome ? "house" : "doc")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityHidden(true)
    }

    private var footer: some View {
        VStack(spacing: 8) {
            if let message = statusMessage {
                Text(message)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.tabs.transitionStatus")
            }
            if let retry = onRetryTransition {
                Button {
                    if !actionsBlocked { retry() }
                } label: {
                    Text("Retry").padding(.horizontal, 16).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .modifier(TabOverviewControlSurface())
                .disabled(actionsBlocked)
                .accessibilityLabel("Retry tab change")
                .accessibilityIdentifier("native.tabs.retry")
            }
            if let resume = onResumeSource {
                Button {
                    if !actionsBlocked { resume() }
                } label: {
                    Text("Resume editing").padding(.horizontal, 16).frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .modifier(TabOverviewControlSurface())
                .disabled(actionsBlocked)
                .accessibilityLabel("Resume editing")
                .accessibilityIdentifier("native.tabs.resume")
            }
            if model.restoreDisposition == .rejected {
                Text("Saved tabs could not be restored. Your files are unchanged.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.tabs.restoreRejected")
            }
            if model.tabs.count >= NativeDocumentTabs.maximumTabs {
                Text("Tab limit reached. Close a tab to add another.")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if dynamicType.isAccessibilitySize {
                VStack(spacing: 8) {
                    count
                    HStack { newTab; Spacer(minLength: 16); done }
                }
            } else {
                HStack(spacing: 12) {
                    newTab.frame(maxWidth: .infinity, alignment: .leading)
                    count
                    done.frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 12)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private func announceStatus(_ message: String?) {
        guard let message = message else { return }
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    private var count: some View {
        Text(model.tabs.count == 1 ? "1 tab" : "\(model.tabs.count) tabs")
            .font(.headline)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("native.tabs.count")
    }

    private var newTab: some View {
        Button { if model.canAddTab { request(.newHome) } } label: {
            Image(systemName: "plus")
                .font(.title2)
                .frame(width: 52, height: 52)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .modifier(TabOverviewControlSurface())
        .disabled(actionsBlocked || !model.canAddTab)
        .accessibilityLabel("New tab")
        .accessibilityHint(model.tabs.count >= NativeDocumentTabs.maximumTabs ? "Tab limit reached. Close a tab to add another." : "Create an empty Home tab")
        .accessibilityIdentifier("native.tabs.new")
    }

    private var done: some View {
        Button {
            if !actionsBlocked { onDone() }
        } label: {
            Text("Done")
                .font(.headline)
                .padding(.horizontal, 16)
                .frame(minWidth: 72, minHeight: 52)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .modifier(TabOverviewControlSurface())
        .disabled(actionsBlocked)
        .accessibilityLabel("Done")
        .accessibilityHint("Return to selected tab")
        .accessibilityIdentifier("native.tabs.done")
    }
}

private struct TabOverviewControlSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        // Circle is a capsule at equal width/height; use one native shape/API.
        if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
            content.glassEffect(.regular.interactive(), in: Capsule())
        } else {
            content
                .background(Color(uiColor: .tertiarySystemBackground), in: Capsule())
                .overlay(Capsule().stroke(Color(uiColor: .separator), lineWidth: contrast == .increased ? 2 : 1))
        }
    }
}
