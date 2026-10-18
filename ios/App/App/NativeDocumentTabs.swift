import Foundation
import Combine

// Device-local presentation metadata only. Never persist paths as identity,
// note content, editor state, host handles or Rust ownership in this model.
struct NativeTabDocument: Codable, Hashable {
    let vaultID: UUID
    // Keep the native DTO witness opaque and byte-exact; current stores emit
    // canonical UUID strings, but Swift does not reinterpret that authority.
    let localStoreID: String
    let stableFileID: String
    let displayTitle: String

    init(vaultID: UUID, localStoreID: String, stableFileID: String, displayTitle: String) throws {
        guard Self.isIdentityToken(localStoreID), Self.isIdentityToken(stableFileID),
              !displayTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              displayTitle.utf8.count <= 1024,
              !displayTitle.unicodeScalars.contains(where: { $0.value < 32 || (127...159).contains($0.value) }) else {
            throw NativeDocumentTabsError.invalidMetadata
        }
        self.vaultID = vaultID
        self.localStoreID = localStoreID
        self.stableFileID = stableFileID
        self.displayTitle = displayTitle
    }

    private static func isIdentityToken(_ value: String) -> Bool {
        (1...128).contains(value.utf8.count) && value.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        })
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(vaultID.uuidString.lowercased(), forKey: .vaultID)
        try values.encode(localStoreID, forKey: .localStoreID)
        try values.encode(stableFileID, forKey: .stableFileID)
        try values.encode(displayTitle, forKey: .displayTitle)
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case vaultID, localStoreID, stableFileID, displayTitle
    }

    init(from decoder: Decoder) throws {
        try rejectUnknownTabKeys(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(vaultID: values.decode(UUID.self, forKey: .vaultID),
                      localStoreID: values.decode(String.self, forKey: .localStoreID),
                      stableFileID: values.decode(String.self, forKey: .stableFileID),
                      displayTitle: values.decode(String.self, forKey: .displayTitle))
    }
}

struct NativeDocumentTab: Codable, Identifiable, Hashable {
    let id: UUID
    let document: NativeTabDocument?
    var displayTitle: String { document?.displayTitle ?? "Home" }
    var isHome: Bool { document == nil }

    init(id: UUID = UUID(), document: NativeTabDocument? = nil) {
        self.id = id
        self.document = document
    }

    private enum Kind: String, Codable { case home, file }
    private enum CodingKeys: String, CodingKey, CaseIterable { case id, kind, document }

    init(from decoder: Decoder) throws {
        try rejectUnknownTabKeys(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .home:
            guard !values.contains(.document) else { throw NativeDocumentTabsError.invalidMetadata }
            document = nil
        case .file:
            document = try values.decode(NativeTabDocument.self, forKey: .document)
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id.uuidString.lowercased(), forKey: .id)
        try values.encode(isHome ? Kind.home : Kind.file, forKey: .kind)
        if let document = document { try values.encode(document, forKey: .document) }
    }
}

enum NativeDocumentTabsError: LocalizedError {
    case invalidMetadata, busy, unknownTab, tabLimit, metadataLimit, staleTicket, invalidAcknowledgement

    var errorDescription: String? {
        switch self {
        case .invalidMetadata: return "Tab information is invalid. Your files have not been changed."
        case .busy: return "Wait for the current tab change to finish."
        case .unknownTab: return "This tab is no longer available."
        case .tabLimit: return "Tab limit reached. Close a tab to add another."
        case .metadataLimit: return "Saved tab information is full. Close a tab before opening another."
        case .staleTicket, .invalidAcknowledgement: return "The active tab changed. Try the action again."
        }
    }
}

@MainActor
final class NativeDocumentTabs: ObservableObject {
    let vaultID: UUID
    static let maximumTabs = 64
    static let maximumMetadataBytes = 131_072

    enum Intent: Equatable {
        case select(UUID)
        case replaceSelected(NativeTabDocument)
        case replaceSelectedWithHome
        case openInNewTab(NativeTabDocument)
        case newHome
        case close(UUID)
    }

    struct IntentTicket: Equatable, Identifiable {
        let id: UUID
        let intent: Intent
        let sourceOwnerID: UUID
        fileprivate let modelID: UUID
        fileprivate let sourceRevision: UUID
        let sourceTab: NativeDocumentTab
        let destinationTab: NativeDocumentTab
        fileprivate let proposedTabs: [NativeDocumentTab]
    }

    // An opaque, transient metadata capability, never a save or lease receipt.
    // Its initializer and full witness are inaccessible outside this source file.
    struct ActiveDocumentBindingTicket: Equatable, Identifiable {
        let id: UUID
        let tabID: UUID
        let sourceOwnerID: UUID
        fileprivate let modelID: UUID
        fileprivate let sourceRevision: UUID
        fileprivate let admissionRevision: UUID
        fileprivate let sourceTab: NativeDocumentTab
    }

    // These are coordinator assertions, not a save operation. Produce one only
    // after the matching ticket's active editor has saved/quiesced AND its host
    // and client lease have acknowledged close. noActiveEditor requires the same
    // coordinator to prove no editor/host/lease exists, including on restore.
    enum Acknowledgement {
        case editorClosed(sourceTabID: UUID, sourceOwnerID: UUID)
        case noActiveEditor(sourceOwnerID: UUID)
    }

    enum RestoreDisposition: Equatable { case fresh, restored, rejected }
    let restoreDisposition: RestoreDisposition

    // Publish the committed collection/selection together: observers cannot see
    // a closed selected tab or a replacement paired with the previous selection.
    private struct State {
        let revision = UUID()
        let tabs: [NativeDocumentTab]
        let selectedTabID: UUID
    }
    private let modelID = UUID()
    // Even a cancelled navigation attempt supersedes an earlier binding event.
    private var admissionRevision = UUID()
    @Published private var state: State
    @Published private(set) var pendingIntent: IntentTicket?

    var tabs: [NativeDocumentTab] { state.tabs }
    var selectedTabID: UUID { state.selectedTabID }
    var selectedTab: NativeDocumentTab {
        // State is constructed only from a validated restore or a prepared plan.
        state.tabs.first(where: { $0.id == state.selectedTabID })!
    }
    var canAddTab: Bool { tabs.count < Self.maximumTabs && pendingIntent == nil }

    // Only explicit absence creates Home. Invalid persisted bytes must enter
    // caller recovery, never manufacture a replacement for a pending tab UUID.
    init(vaultID: UUID) {
        self.vaultID = vaultID
        let home = NativeDocumentTab()
        state = State(tabs: [home], selectedTabID: home.id)
        restoreDisposition = .fresh
    }

    init(restoring data: Data, vaultID: UUID) throws {
        guard !data.isEmpty, data.count <= Self.maximumMetadataBytes,
              let metadata = try? JSONDecoder().decode(Metadata.self, from: data),
              metadata.isValid, metadata.vaultID == vaultID else {
            throw NativeDocumentTabsError.invalidMetadata
        }
        self.vaultID = vaultID
        state = State(tabs: metadata.tabs, selectedTabID: metadata.selectedTabID)
        restoreDisposition = .restored
    }

    // Callers freshly resolve destinationTab.document using its own vault UUID,
    // opaque local store ID and stable file ID; never infer scope from another tab.
    // A missing/deleted/inaccessible target is an activation error, not authority
    // to silently open a path or remove restored metadata. Cancel the ticket on
    // failed save/resolution/close. Do not start a second host while waiting.
    // sourceOwnerID is a transient coordinator generation, not a Rust lease.
    // Resolve availability before commit; once close succeeds and commit occurs,
    // later target-open failure stays on the chosen tab with caller-owned retry.
    func prepare(_ intent: Intent, sourceOwnerID: UUID) throws -> IntentTicket {
        guard pendingIntent == nil else { throw NativeDocumentTabsError.busy }
        var proposed = tabs
        var destination = selectedTab
        switch intent {
        case .select(let id):
            guard let tab = proposed.first(where: { $0.id == id }) else { throw NativeDocumentTabsError.unknownTab }
            destination = tab
        case .replaceSelected(let document):
            guard document.vaultID == vaultID else { throw NativeDocumentTabsError.invalidMetadata }
            destination = NativeDocumentTab(id: selectedTabID, document: document)
            proposed[proposed.firstIndex(where: { $0.id == selectedTabID })!] = destination
        case .replaceSelectedWithHome:
            destination = NativeDocumentTab(id: selectedTabID)
            proposed[proposed.firstIndex(where: { $0.id == selectedTabID })!] = destination
        case .openInNewTab(let document):
            guard document.vaultID == vaultID else { throw NativeDocumentTabsError.invalidMetadata }
            guard proposed.count < Self.maximumTabs else { throw NativeDocumentTabsError.tabLimit }
            destination = NativeDocumentTab(document: document)
            proposed.append(destination)
        case .newHome:
            guard proposed.count < Self.maximumTabs else { throw NativeDocumentTabsError.tabLimit }
            destination = NativeDocumentTab()
            proposed.append(destination)
        case .close(let id):
            guard let index = proposed.firstIndex(where: { $0.id == id }) else { throw NativeDocumentTabsError.unknownTab }
            proposed.remove(at: index)
            if proposed.isEmpty {
                destination = NativeDocumentTab()
                proposed = [destination]
            } else if id == selectedTabID {
                destination = proposed[min(index, proposed.count - 1)]
            }
        }
        // Escaped JSON can exceed the byte budget even with individually valid
        // titles. Reject before admitting a plan that could not be persisted.
        let metadata = Metadata(vaultID: vaultID, tabs: proposed, selectedTabID: destination.id)
        _ = try encode(metadata)
        let ticket = IntentTicket(id: UUID(), intent: intent, sourceOwnerID: sourceOwnerID,
                                  modelID: modelID, sourceRevision: state.revision, sourceTab: selectedTab,
                                  destinationTab: destination, proposedTabs: proposed)
        admissionRevision = UUID()
        pendingIntent = ticket
        return ticket
    }

    func commit(_ ticket: IntentTicket, acknowledgement: Acknowledgement) throws {
        guard ticket.modelID == modelID, pendingIntent == ticket, state.revision == ticket.sourceRevision,
              selectedTab == ticket.sourceTab else { throw NativeDocumentTabsError.staleTicket }
        switch acknowledgement {
        case .editorClosed(let sourceTabID, let sourceOwnerID):
            guard sourceTabID == ticket.sourceTab.id, sourceOwnerID == ticket.sourceOwnerID else {
                throw NativeDocumentTabsError.invalidAcknowledgement
            }
        case .noActiveEditor(let sourceOwnerID):
            guard sourceOwnerID == ticket.sourceOwnerID else { throw NativeDocumentTabsError.invalidAcknowledgement }
        }
        state = State(tabs: ticket.proposedTabs, selectedTabID: ticket.destinationTab.id)
        pendingIntent = nil
    }

    func cancel(_ ticket: IntentTicket) throws {
        guard pendingIntent == ticket else { throw NativeDocumentTabsError.staleTicket }
        pendingIntent = nil
    }

    // The caller invokes this only for a freshly validated activation from its
    // CURRENT single editor/container. No host is closed, opened or authorized.
    // Preparing a binding neither reserves navigation nor changes persisted state.
    func prepareActiveDocumentBinding(tabID: UUID, sourceOwnerID: UUID) throws -> ActiveDocumentBindingTicket {
        guard pendingIntent == nil else { throw NativeDocumentTabsError.busy }
        guard selectedTabID == tabID else { throw NativeDocumentTabsError.unknownTab }
        return ActiveDocumentBindingTicket(id: UUID(), tabID: tabID, sourceOwnerID: sourceOwnerID,
                                           modelID: modelID, sourceRevision: state.revision,
                                           admissionRevision: admissionRevision, sourceTab: selectedTab)
    }

    // This is the sole exception to close-before-navigation: update metadata for
    // an ALREADY active, freshly validated document (new note, rename or link).
    // currentOwnerID is a coordinator assertion of the current host generation,
    // not Rust lease authority. Check it again after asynchronous validation.
    func bindActiveDocument(_ document: NativeTabDocument, using ticket: ActiveDocumentBindingTicket,
                            currentOwnerID: UUID) throws {
        guard pendingIntent == nil else { throw NativeDocumentTabsError.busy }
        guard ticket.modelID == modelID, ticket.sourceRevision == state.revision,
              ticket.admissionRevision == admissionRevision, ticket.tabID == selectedTabID,
              ticket.sourceTab == selectedTab else { throw NativeDocumentTabsError.staleTicket }
        guard ticket.sourceOwnerID == currentOwnerID else { throw NativeDocumentTabsError.invalidAcknowledgement }
        guard document.vaultID == vaultID else { throw NativeDocumentTabsError.invalidMetadata }
        var proposed = tabs
        proposed[proposed.firstIndex(where: { $0.id == selectedTabID })!] =
            NativeDocumentTab(id: selectedTabID, document: document)
        let metadata = Metadata(vaultID: vaultID, tabs: proposed, selectedTabID: selectedTabID)
        _ = try encode(metadata)
        // A new revision consumes this ticket and all competing bindings, even
        // when document metadata is identical. Selection and other tabs stay put.
        state = State(tabs: proposed, selectedTabID: selectedTabID)
    }

    // Normal checkpoints describe only committed UI state.
    func encodedMetadata() throws -> Data {
        try encode(Metadata(vaultID: vaultID, tabs: tabs, selectedTabID: selectedTabID))
    }

    // A durable prospective handoff, not a selection or host mutation. The
    // coordinator must retain this exact plan through its save/ACK/close gates;
    // persisting these bytes never authorizes commit or creates a close receipt.
    func encodedMetadata(for ticket: IntentTicket) throws -> Data {
        guard ticket.modelID == modelID, pendingIntent == ticket,
              state.revision == ticket.sourceRevision, selectedTab == ticket.sourceTab else {
            throw NativeDocumentTabsError.staleTicket
        }
        return try encode(Metadata(vaultID: vaultID, tabs: ticket.proposedTabs,
                                   selectedTabID: ticket.destinationTab.id))
    }

    private func encode(_ metadata: Metadata) throws -> Data {
        guard metadata.isValid, metadata.vaultID == vaultID else { throw NativeDocumentTabsError.invalidMetadata }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let bytes = try encoder.encode(metadata)
        guard bytes.count <= Self.maximumMetadataBytes else { throw NativeDocumentTabsError.metadataLimit }
        return bytes
    }

    // Caller owns a device-local preferences key/domain. This is not sync state
    // and provides no durable note-save receipt. Keep this key out of vault data.
    func saveMetadata(to defaults: UserDefaults, key: String) throws {
        guard !key.isEmpty, key.utf8.count <= 256 else { throw NativeDocumentTabsError.invalidMetadata }
        defaults.set(try encodedMetadata(), forKey: key)
    }

    private struct Metadata: Codable {
        let version: Int
        let vaultID: UUID
        let tabs: [NativeDocumentTab]
        let selectedTabID: UUID
        var isValid: Bool {
            version == 2 && tabs.allSatisfy({ $0.document == nil || $0.document?.vaultID == vaultID }) && (1...64).contains(tabs.count) && Set(tabs.map(\.id)).count == tabs.count &&
                tabs.contains(where: { $0.id == selectedTabID })
        }
        private enum CodingKeys: String, CodingKey, CaseIterable { case version, vaultID, tabs, selectedTabID }
        init(vaultID: UUID, tabs: [NativeDocumentTab], selectedTabID: UUID) {
            self.version = 2
            self.vaultID = vaultID
            self.tabs = tabs
            self.selectedTabID = selectedTabID
        }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(version, forKey: .version)
            try values.encode(vaultID.uuidString.lowercased(), forKey: .vaultID)
            try values.encode(tabs, forKey: .tabs)
            try values.encode(selectedTabID.uuidString.lowercased(), forKey: .selectedTabID)
        }
        init(from decoder: Decoder) throws {
            try rejectUnknownTabKeys(decoder, allowed: CodingKeys.allCases.map(\.rawValue))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            version = try values.decode(Int.self, forKey: .version)
            guard version == 2 else { throw NativeDocumentTabsError.invalidMetadata }
            vaultID = try values.decode(UUID.self, forKey: .vaultID)
            // Bound element allocation too, rather than decoding an arbitrary array
            // before checking the limit. The outer byte cap bounds string parsing.
            var collection = try values.nestedUnkeyedContainer(forKey: .tabs)
            var decoded: [NativeDocumentTab] = []
            while !collection.isAtEnd {
                guard decoded.count < 64 else { throw NativeDocumentTabsError.invalidMetadata }
                decoded.append(try collection.decode(NativeDocumentTab.self))
            }
            tabs = decoded
            selectedTabID = try values.decode(UUID.self, forKey: .selectedTabID)
            guard isValid else { throw NativeDocumentTabsError.invalidMetadata }
        }
    }
}

private struct TabMetadataKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private func rejectUnknownTabKeys(_ decoder: Decoder, allowed: [String]) throws {
    let container = try decoder.container(keyedBy: TabMetadataKey.self)
    guard container.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
        throw NativeDocumentTabsError.invalidMetadata
    }
}
