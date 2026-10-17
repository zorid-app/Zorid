import UIKit
import SwiftUI

// UI metadata only. Rust remains the sole authority for vault entries/content.
struct NativeFilePresentation: Decodable {
    let id: String
    let modifiedMilliseconds: UInt64
    let sizeBytes: UInt64
    enum CodingKeys: String, CodingKey {
        case id
        case modifiedMilliseconds = "mtime_ms"
        case sizeBytes = "size_bytes"
    }
}

struct NativeFileEntry: Decodable {
    enum Kind: String, Decodable { case file, folder }
    let id: String
    let path: String
    let kind: Kind
    let deleted: Bool
    var presentation: NativeFilePresentation?

    var name: String { Self.pathComponents(path).last ?? path }
    var parent: String { Self.pathComponents(path).dropLast().joined(separator: "/") }

    static func pathComponents(_ path: String) -> [String] {
        // Rust splits ASCII slash bytes, including before combining characters.
        path.utf8.split(separator: 47, omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
    }

    static func samePath(_ left: String, _ right: String) -> Bool {
        // Swift String equality folds Unicode canonical equivalents; Rust/JS do
        // not. Keep distinct vault spellings distinct, without normalization.
        left.utf8.elementsEqual(right.utf8)
    }

    static func isValidEntryId(_ value: String) -> Bool {
        // Rust EntryId is an opaque, case-sensitive token, not a UUID.
        let bytes = value.utf8
        return (1...128).contains(bytes.count) && bytes.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    static func isValidPath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 1_048_576, !path.utf8.contains(92),
              !path.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7f...0x9f).contains($0.value) }) else { return false }
        let segments = pathComponents(path)
        guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return false }
        let first = Array(segments[0].utf8.prefix(2))
        if first.count == 2, first[1] == 58,
           (65...90).contains(first[0]) || (97...122).contains(first[0]) { return false }
        return true
    }

    static func isVisiblePath(_ path: String) -> Bool {
        // Match the adapter's visible/nativeNotePath boundary: never expose root
        // .zorid (Rust-reserved), .trash, or any other dot namespace/component.
        isValidPath(path) && pathComponents(path).allSatisfy { $0.utf8.first != 46 }
    }

}

private enum NativePageError: Error { case invalidResponse, unavailable }

struct NativeVaultListing {
    let localStoreId: String
    let entries: [NativeFileEntry]
    let scanComplete: Bool
}

extension NativeMobileSession {
    // Only these fixed read commands are available to native page code. Neither
    // claims a client nor reads file bodies. Request framing stays in the session.
    private enum PageRead: String { case identity, snapshot = "list_snapshot" }

    private func pageRead(_ command: PageRead, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let requestId = String(UInt64.random(in: 1...UInt64.max))
        do {
            let data = try JSONSerialization.data(withJSONObject: ["version": 1, "request_id": requestId,
                                                                    "command": ["method": command.rawValue]])
            guard let header = String(data: data, encoding: .utf8) else { throw NativePageError.invalidResponse }
            request(header: header, body: "") { result in
                completion(result.flatMap { header, body in
                    Result {
                        guard body.isEmpty, let bytes = header.data(using: .utf8),
                              let reply = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                              reply["request_id"] as? String == requestId,
                              reply["version"] as? Int == 1, reply["ok"] as? Bool == true,
                              let object = reply["result"] as? [String: Any] else { throw NativePageError.invalidResponse }
                        return object
                    }
                })
            }
        } catch { completion(.failure(NativePageError.invalidResponse)) }
    }

    func pageListing(completion: @escaping (Result<NativeVaultListing, Error>) -> Void) {
        let timer = NativePhaseTimer()
        let finished: (Result<NativeVaultListing, Error>) -> Void = { result in
            timer.finish(.listing)
            completion(result)
        }
        pageRead(.identity) { identityResult in
            switch identityResult {
            case .failure(let error): finished(.failure(error))
            case .success(let object):
                guard let identity = object["identity"] as? [String: Any],
                      let storeId = identity["local_store_id"] as? String, !storeId.isEmpty else {
                    finished(.failure(NativePageError.invalidResponse)); return
                }
                self.pageRead(.snapshot) { snapshotResult in
                    switch snapshotResult {
                    case .failure(let error): finished(.failure(error))
                    case .success(let snapshot):
                        do {
                            struct Row: Decodable { let state: NativeFileEntry; let presentation: NativeFilePresentation? }
                            struct Snapshot: Decodable { let entries: [Row]; let cursor: String }
                            let bytes = try JSONSerialization.data(withJSONObject: snapshot)
                            let decoded = try JSONDecoder().decode(Snapshot.self, from: bytes)
                            let entries = try decoded.entries.map { row -> NativeFileEntry in
                                if let metadata = row.presentation {
                                    guard metadata.id == row.state.id,
                                          metadata.modifiedMilliseconds <= 9_007_199_254_740_991,
                                          metadata.sizeBytes <= 9_007_199_254_740_991,
                                          row.state.kind != .folder || metadata.sizeBytes == 0 else { throw NativePageError.invalidResponse }
                                }
                                var entry = row.state
                                entry.presentation = row.presentation
                                return entry
                            }
                            guard !decoded.cursor.isEmpty, entries.allSatisfy({ !$0.deleted && NativeFileEntry.isValidEntryId($0.id) && NativeFileEntry.isValidPath($0.path) }),
                                  Set(entries.map(\.id)).count == entries.count,
                                  Set(entries.map { Data($0.path.utf8) }).count == entries.count else { throw NativePageError.invalidResponse }
                            self.context { context in
                                let reconciliation = context["reconciliation"] as? [String: Any]
                                finished(.success(NativeVaultListing(localStoreId: storeId, entries: entries.filter { NativeFileEntry.isVisiblePath($0.path) },
                                                                      scanComplete: reconciliation?["complete"] as? Bool == true)))
                            }
                        } catch { finished(.failure(NativePageError.invalidResponse)) }
                    }
                }
            }
        }
    }

    func recordNoteOpened(path: String, entryId: String, onValidated: @escaping (String) -> Void = { _ in }, completion: @escaping (Result<Void, Error>) -> Void) {
        guard NativeFileEntry.isVisiblePath(path), NativeFileEntry.isValidEntryId(entryId) else {
            completion(.failure(NativePageError.invalidResponse)); return
        }
        pageListing { result in
            completion(result.flatMap { listing in
                Result {
                    guard let entry = listing.entries.first(where: { $0.id == entryId && NativeFileEntry.samePath($0.path, path) && $0.kind == .file }) else {
                        throw NativePageError.unavailable
                    }
                    // Valid activation is independent of device-local history IO.
                    onValidated(entry.id)
                    try NativeRecentStore.record(entryId: entry.id, vaultId: self.vault.id, storeId: listing.localStoreId)
                }
            })
        }
    }
}

private enum NativeRecentStore {
    private struct Open: Codable {
        let vaultId: UUID
        let storeId: String
        let entryId: String
        let openedAt: Date
    }
    private static let key = "native.note-opens.v1"

    private static func read() throws -> [Open] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return try JSONDecoder().decode([Open].self, from: data)
    }

    static func record(entryId: String, vaultId: UUID, storeId: String) throws {
        // Callbacks from the core bridge complete on main; history has one owner.
        dispatchPrecondition(condition: .onQueue(.main))
        var records = try read()
        records.removeAll { $0.vaultId == vaultId && $0.storeId == storeId && $0.entryId == entryId }
        records.insert(Open(vaultId: vaultId, storeId: storeId, entryId: entryId, openedAt: Date()), at: 0)
        let retained = Array(records.prefix(300))
        UserDefaults.standard.set(try JSONEncoder().encode(retained), forKey: key)
    }

    static func entries(vaultId: UUID, listing: NativeVaultListing) throws -> [NativeFileEntry] {
        let byId = Dictionary(uniqueKeysWithValues: listing.entries.map { ($0.id, $0) })
        return try read().filter { $0.vaultId == vaultId && $0.storeId == listing.localStoreId }
            .sorted { $0.openedAt > $1.openedAt }
            .compactMap { byId[$0.entryId] }.filter { $0.kind == .file && NativeFileEntry.isVisiblePath($0.path) }
    }
}

private enum NativePage: String, CaseIterable {
    case recents, files
    var title: String { self == .recents ? "Recents" : "Files" }
    var symbol: String { self == .recents ? "clock" : "folder" }
}

// Folder/note identities survive rename; root has no entry ID. Paths are only
// fresh snapshot locators. History is bounded RAM owned by one vault coordinator.
private enum NativeRoute: Equatable {
    case page(NativePage, folderId: String?)
    case note(String)
}

private struct NativePagePreferences {
    private static let key = "native.notes.mode.v1"
    private static let legacyKey = "native.pages.v1"
    var selected: NativePage

    init(defaults: UserDefaults = .standard) {
        if let saved = defaults.string(forKey: Self.key) {
            selected = NativePage(rawValue: saved) ?? .recents
        } else if defaults.stringArray(forKey: Self.legacyKey)?.isEmpty == true {
            selected = .recents
        } else {
            // Settings is a sheet now. Invalid/legacy Settings selections fall
            // back to Recents; both note modes are always available.
            selected = defaults.string(forKey: Self.legacyKey + ".selected").flatMap(NativePage.init(rawValue:)) ?? .recents
        }
        persist(to: defaults)
    }

    func persist(to defaults: UserDefaults = .standard) {
        defaults.set(selected.rawValue, forKey: Self.key)
        defaults.removeObject(forKey: Self.legacyKey)
        defaults.removeObject(forKey: Self.legacyKey + ".selected")
    }
}

// One coordinator owns the session. A hidden native page never opens another
// host while its editor is active, and never claims the editor's client lease.
@MainActor
private final class NativePagesCoordinator {
    private let vault: LocalVault
    private let root: URL
    private var session: NativeMobileSession?
    private var generation = 0
    private var editorOpenGeneration = 0
    private var busy = false
    private var editorActive = false
    private var chooseVaultRequested = false
    private var visible = false
    private var refreshRequested = false
    private var refreshWork: DispatchWorkItem?
    private var refreshGeneration = 0
    private var initialListingPending = true
    private var history: [NativeRoute] = []
    private var historyStoreId: String?
    private var historyIndex = -1
    private var pendingHistoryIndex: Int?
    private var awaitingNoteActivation = false
    private var routeFailureOnReturn = false
    private weak var activeEditor: NativeEditorContainer?
    weak var owner: NativePagesController?

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        self.vault = vault
        self.root = root
        self.session = session
    }

    func record(_ route: NativeRoute) {
        guard pendingHistoryIndex == nil else { return }
        if history.indices.contains(historyIndex), history[historyIndex] == route { updateRouteControls(); return }
        history = Array(history.prefix(historyIndex + 1))
        history.append(route)
        if history.count > 100 { history.removeFirst(history.count - 100) }
        historyIndex = history.count - 1
        updateRouteControls()
    }

    func recordPageNavigation(_ route: NativeRoute) {
        guard !editorActive else { return }
        // Cancel admission, not the in-flight Rust read/host ownership. Its reply
        // must still clear loading (or close a failed host), without pushing.
        editorOpenGeneration += 1
        // A new mode or Settings presentation wins over a staged history
        // destination while its read is still in flight.
        pendingHistoryIndex = nil
        awaitingNoteActivation = false
        record(route)
    }

    private func updateRouteControls() {
        let available = pendingHistoryIndex == nil && !busy
        let back = available && historyIndex > 0
        let forward = available && historyIndex + 1 < history.count
        owner?.setRouteAvailability(back: back, forward: forward)
        activeEditor?.setRouteAvailability(back: back, forward: forward)
    }

    func traverse(_ direction: Int) {
        guard direction == -1 || direction == 1, !busy, pendingHistoryIndex == nil,
              UIApplication.shared.applicationState == .active else { return }
        let target = historyIndex + direction
        guard history.indices.contains(target) else { return }
        if editorActive {
            guard let editor = activeEditor, editor.navigationController?.topViewController === editor else { return }
            pendingHistoryIndex = target
            updateRouteControls()
            editor.leaveForNativeRoute { [weak self] ok in
                guard let self = self else { return }
                if !ok { self.pendingHistoryIndex = nil; self.updateRouteControls() }
            }
        } else {
            guard pageActive else { return }
            pendingHistoryIndex = target
            updateRouteControls()
            cancelQueuedRefresh()
            load(refresh: true)
        }
    }

    private func completeTraversal(_ listing: NativeVaultListing, session: NativeMobileSession) {
        guard let target = pendingHistoryIndex, history.indices.contains(target) else { return }
        let route = history[target]
        switch route {
        case .page(let page, let folderId):
            let folder = folderId.flatMap { id in listing.entries.first { $0.id == id && $0.kind == .folder } }
            guard (folderId == nil || folder != nil), owner?.supports(page) == true else {
                traversalUnavailable(); return
            }
            historyIndex = target
            pendingHistoryIndex = nil
            owner?.applyRoute(page: page, folder: folder)
            updateRouteControls()
        case .note(let id):
            guard let entry = listing.entries.first(where: { $0.id == id && $0.kind == .file }) else {
                traversalUnavailable(); return
            }
            // Resolving identity authorizes handoff, not successful activation.
            // Keep the cursor staged until the web confirms this exact entry.
            awaitingNoteActivation = true
            transfer(session, initialEntry: entry, origin: owner?.originTitle ?? "Pages")
            updateRouteControls()
        }
    }

    private func traversalUnavailable() {
        pendingHistoryIndex = nil
        owner?.showRouteUnavailable()
        updateRouteControls()
    }

    private var pageActive: Bool {
        guard visible, !editorActive, UIApplication.shared.applicationState == .active,
              let owner = owner, owner.navigationController?.topViewController === owner,
              let scene = owner.viewIfLoaded?.window?.windowScene else { return false }
        return scene.activationState == .foregroundActive
    }

    func setVisible(_ visible: Bool) {
        self.visible = visible
        if visible { scheduleAutomaticRefresh() } else { cancelQueuedRefresh() }
    }

    func cancelQueuedRefresh() {
        refreshGeneration += 1
        refreshWork?.cancel()
        refreshWork = nil
        refreshRequested = false
    }

    // Lifecycle events are debounced into one pending refresh, never a polling
    // loop. Continuously visible external writes await a future Rust-backed
    // change-notification seam; root-only vnode watches miss nested file writes.
    func scheduleAutomaticRefresh() {
        guard pageActive else { return }
        if chooseVaultRequested { finishChooseVault(); return }
        refreshRequested = true
        guard !busy, refreshWork == nil else { return }
        let ticket = refreshGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.refreshGeneration == ticket else { return }
            self.refreshWork = nil
            guard self.pageActive, !self.busy, self.refreshRequested else { return }
            self.refreshRequested = false
            self.load(refresh: !self.initialListingPending)
        }
        refreshWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    func foregroundRefresh() {
        guard pageActive else { return }
        initialListingPending = false
        scheduleAutomaticRefresh()
    }

    private func drainAutomaticRefresh() {
        if chooseVaultRequested { finishChooseVault(); return }
        if refreshRequested { scheduleAutomaticRefresh() }
    }

    func load(refresh: Bool = false, completion: @escaping () -> Void = {}) {
        guard pageActive, !busy, !editorActive else { completion(); return }
        let finished: () -> Void = { [weak self] in
            completion()
            self?.drainAutomaticRefresh()
        }
        busy = true
        initialListingPending = false
        updateRouteControls()
        generation += 1
        let ticket = generation
        owner?.setLoading()
        if let session = session {
            if refresh { refreshThenRead(session, ticket: ticket, completion: finished) }
            else { read(session, ticket: ticket, completion: finished) }
            return
        }
        NativeMobileSession.open(vault: vault, root: root) { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else {
                if case .success(let session) = result { session.close {} }
                finished()
                return
            }
            switch result {
            case .success(let session):
                self.session = session
                if self.pageActive { self.read(session, ticket: ticket, completion: finished) }
                else { self.busy = false; finished() }
            case .failure:
                self.busy = false
                if self.pageActive { self.owner?.showLoadFailure() }
                self.pendingHistoryIndex = nil
                self.updateRouteControls()
                finished()
            }
        }
    }

    private func refreshThenRead(_ session: NativeMobileSession, ticket: Int, completion: @escaping () -> Void) {
        session.refresh { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { completion(); return }
            switch result {
            case .success:
                guard self.pageActive else { self.busy = false; completion(); return }
                self.read(session, ticket: ticket, completion: completion)
            case .failure: self.fail(session, ticket: ticket, completion: completion)
            }
        }
    }

    private func read(_ session: NativeMobileSession, ticket: Int, completion: @escaping () -> Void) {
        session.pageListing { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { completion(); return }
            switch result {
            case .success(let listing):
                self.busy = false
                if self.pageActive {
                    if let priorStore = self.historyStoreId, priorStore != listing.localStoreId {
                        self.history = []
                        self.historyIndex = -1
                        self.pendingHistoryIndex = nil
                        self.awaitingNoteActivation = false
                        self.routeFailureOnReturn = true
                        self.owner?.resetFolderRoute()
                    }
                    self.historyStoreId = listing.localStoreId
                    self.owner?.showListing(listing)
                    if self.pendingHistoryIndex != nil { self.completeTraversal(listing, session: session) }
                    else if let route = self.owner?.currentRoute { self.record(route) }
                    if self.routeFailureOnReturn {
                        self.routeFailureOnReturn = false
                        self.owner?.showRouteUnavailable()
                    }
                }
                self.updateRouteControls()
                completion()
            case .failure: self.fail(session, ticket: ticket, completion: completion)
            }
        }
    }

    private func fail(_ session: NativeMobileSession, ticket: Int, missingSelection: Bool = false, completion: @escaping () -> Void = {}) {
        // A failed/fenced host must not be reused by every retry. Complete close
        // before allowing retry so a new host cannot overlap this one.
        self.session = nil
        busy = true
        session.close { [weak self] in
            guard let self = self, self.generation == ticket else { completion(); return }
            self.busy = false
            self.pendingHistoryIndex = nil
            self.updateRouteControls()
            if self.pageActive { self.owner?.showLoadFailure(missingSelection: missingSelection) }
            completion()
            self.drainAutomaticRefresh()
        }
    }

    func reload() async {
        guard pageActive else { return }
        if busy { scheduleAutomaticRefresh(); return }
        cancelQueuedRefresh()
        await withCheckedContinuation { continuation in load(refresh: true) { continuation.resume() } }
    }

    func openEditor(entry: NativeFileEntry?, origin: String) {
        guard pageActive, !busy, !editorActive, let session = session, owner?.navigationController != nil else { return }
        generation += 1
        let ticket = generation
        editorOpenGeneration += 1
        let navigationTicket = editorOpenGeneration
        guard let entry = entry else { transfer(session, initialEntry: nil, origin: origin); return }
        busy = true
        owner?.setLoading()
        // The row's path is only a display locator. Resolve its stable identity
        // again; never open a replacement entry that has reused the old path.
        session.pageListing { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { return }
            switch result {
            case .success(let listing):
                guard self.pageActive else { self.busy = false; return }
                guard self.editorOpenGeneration == navigationTicket else {
                    // A newer native tab/folder choice wins over this lookup.
                    self.busy = false
                    self.owner?.showListing(listing)
                    self.updateRouteControls()
                    self.drainAutomaticRefresh()
                    return
                }
                guard let current = listing.entries.first(where: { $0.id == entry.id && $0.kind == .file }) else {
                    self.fail(session, ticket: ticket, missingSelection: true)
                    return
                }
                self.transfer(session, initialEntry: current, origin: origin)
            case .failure: self.fail(session, ticket: ticket)
            }
        }
    }

    private func transfer(_ session: NativeMobileSession, initialEntry: NativeFileEntry?, origin: String) {
        guard let navigation = owner?.navigationController else { busy = false; return }
        busy = false
        cancelQueuedRefresh()
        self.session = nil
        editorActive = true
        let launch = initialEntry.map(NativeEditorLaunch.entry) ?? .newNote
        let editor = NativeEditorContainer(session: session, launch: launch, originTitle: origin) { [weak self] in
            guard let self = self else { return }
            self.editorActive = false
            self.activeEditor = nil
            if self.awaitingNoteActivation {
                self.awaitingNoteActivation = false
                self.pendingHistoryIndex = nil
                self.routeFailureOnReturn = true
            }
            if self.pendingHistoryIndex == nil, let route = self.owner?.currentRoute { self.record(route) }
        }
        activeEditor = editor
        editor.onNoteOpened = { [weak self, weak editor] id in
            guard let self = self, let editor = editor, self.activeEditor === editor, self.editorActive else { return }
            if self.awaitingNoteActivation {
                self.awaitingNoteActivation = false
                if let target = self.pendingHistoryIndex, self.history.indices.contains(target), self.history[target] == .note(id) {
                    self.historyIndex = target
                    self.pendingHistoryIndex = nil
                    self.updateRouteControls()
                    return
                }
                // A different successfully activated note is a new user route.
                self.pendingHistoryIndex = nil
            }
            self.record(.note(id))
        }
        editor.onNavigate = { [weak self] direction in self?.traverse(direction) }
        updateRouteControls()
        navigation.pushViewController(editor, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func chooseVault() {
        guard !editorActive else { return }
        // A full-screen Settings sheet may finish dismissal before UIKit sends
        // viewDidAppear. Retain intent until the page is active and reads drain.
        chooseVaultRequested = true
        finishChooseVault()
    }

    private func finishChooseVault() {
        guard chooseVaultRequested, pageActive, !busy, !editorActive else { return }
        chooseVaultRequested = false
        cancelQueuedRefresh()
        busy = true
        generation += 1
        let session = self.session
        self.session = nil
        let finish = { [weak self] in
            guard let self = self else { return }
            self.owner?.navigationController?.popViewController(animated: !UIAccessibility.isReduceMotionEnabled)
        }
        if let session = session { session.close(completion: finish) } else { finish() }
    }
}

// Presentation state and local preferences belong to this model; UIKit owns the
// push/pop flow and Rust owns the snapshot. No parallel SwiftUI navigation stack.
@MainActor
private final class NativePagesModel: ObservableObject {
    let vault: LocalVault
    @Published private(set) var preferences = NativePagePreferences()
    @Published private(set) var rows: [NativeFileEntry] = []
    @Published private(set) var folder = ""
    @Published private(set) var status = "Loading vault…"
    @Published private(set) var loading = true
    @Published private(set) var canCreateNote = false
    @Published private(set) var emptyMessage = ""
    @Published private(set) var focusGeneration = 0
    private var listing: NativeVaultListing?
    private var folderId: String?
    var onRouteChanged: ((NativeRoute) -> Void)?
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    var currentRoute: NativeRoute { .page(preferences.selected, folderId: preferences.selected == .files ? folderId : nil) }

    func setRouteAvailability(back: Bool, forward: Bool) { canGoBack = back; canGoForward = forward }
    func supports(_ page: NativePage) -> Bool { NativePage.allCases.contains(page) }
    func applyRoute(page: NativePage, folder: NativeFileEntry?) {
        preferences.selected = page
        preferences.persist()
        self.folder = folder?.path ?? ""
        folderId = folder?.id
        focusedEntryId = nil
        render()
        focusGeneration += 1
    }
    func showRouteUnavailable() {
        status = "That route is no longer available. Choose a current file or folder."
        UIAccessibility.post(notification: .announcement, argument: status)
    }
    @Published private(set) var expandedFolderIds: Set<String> = []
    private var rowDepths: [String: Int] = [:]
    private var childCounts: [String: Int] = [:]
    private(set) var focusedEntryId: String?
    private var restoringFocus = false

    init(vault: LocalVault) { self.vault = vault }
    var heading: String { preferences.selected == .files && !folder.isEmpty ? folder : preferences.selected.title }
    var isInFolder: Bool { preferences.selected == .files && !folder.isEmpty }

    func setLoading() {
        loading = true
        status = listing == nil ? "Loading vault…" : "Updating vault…"
        render()
    }
    func showLoadFailure(missingSelection: Bool = false) {
        loading = false
        listing = nil
        status = missingSelection
            ? "The selected note is no longer available. Pull down to see the current files."
            : "Could not load this vault safely. Pull down to retry or reopen the vault. Your files have not been changed."
        render()
        focusedEntryId = nil
        restoringFocus = false
        focusGeneration += 1
        UIAccessibility.post(notification: .announcement, argument: "Could not load vault")
    }
    func showListing(_ listing: NativeVaultListing) {
        loading = false
        self.listing = listing
        status = listing.scanComplete ? "" : "The vault scan is incomplete. Some files may be unavailable. Pull down to retry."
        if let id = folderId, let current = listing.entries.first(where: { $0.id == id && $0.kind == .folder }) { folder = current.path }
        else { folder = ""; folderId = nil }
        render()
        if restoringFocus {
            if !rows.contains(where: { $0.id == focusedEntryId }) { focusedEntryId = nil }
            focusGeneration += 1
            restoringFocus = false
        }
    }
    func select(_ page: NativePage) {
        guard supports(page), preferences.selected != page else { return }
        preferences.selected = page
        preferences.persist()
        focusedEntryId = nil
        render()
        onRouteChanged?(currentRoute)
    }
    func beginSettingsPresentation() {
        // Opening a sheet is newer UI intent too. Cancel any staged route/file
        // admission without changing the current Notes mode or route history.
        onRouteChanged?(currentRoute)
    }
    func enter(_ folder: NativeFileEntry) {
        guard !loading, folder.kind == .folder else { return }
        self.folder = folder.path
        folderId = folder.id
        render()
        onRouteChanged?(currentRoute)
    }
    func parentFolder() {
        guard !loading else { return }
        folder = NativeFileEntry.pathComponents(folder).dropLast().joined(separator: "/")
        folderId = listing?.entries.first(where: { $0.kind == .folder && NativeFileEntry.samePath($0.path, folder) })?.id
        if folderId == nil { folder = "" }
        render()
        onRouteChanged?(currentRoute)
    }
    func willOpen(_ entry: NativeFileEntry?) {
        focusedEntryId = entry?.id
        restoringFocus = true
    }
    func toggleFolder(_ entry: NativeFileEntry) {
        guard entry.kind == .folder else { return }
        if expandedFolderIds.contains(entry.id) { expandedFolderIds.remove(entry.id) }
        else { expandedFolderIds.insert(entry.id) }
        render()
    }

    func depth(for entry: NativeFileEntry) -> Int { rowDepths[entry.id] ?? 0 }

    func metadata(for entry: NativeFileEntry) -> String {
        if preferences.selected == .recents { return entry.parent.isEmpty ? vault.name : entry.parent }
        var parts: [String] = []
        if let milliseconds = entry.presentation?.modifiedMilliseconds {
            parts.append(DateFormatter.localizedString(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000), dateStyle: .short, timeStyle: .none))
        }
        if entry.kind == .folder {
            let count = childCounts[entry.id] ?? 0
            parts.append("\(count) \(count == 1 ? "item" : "items")")
        } else if let bytes = entry.presentation?.sizeBytes, let count = Int64(exactly: bytes) {
            parts.append(ByteCountFormatter.string(fromByteCount: count, countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }

    private func render() {
        rows = []
        rowDepths = [:]
        childCounts = [:]
        var historyFailed = false
        if let listing = listing {
            if preferences.selected == .recents {
                do { rows = try NativeRecentStore.entries(vaultId: vault.id, listing: listing) }
                catch { historyFailed = true }
            } else {
                let groups = Dictionary(grouping: listing.entries, by: { Data($0.parent.utf8) }).mapValues { entries in
                    entries.sorted {
                        if $0.kind != $1.kind { return $0.kind == .folder }
                        let order = $0.name.localizedStandardCompare($1.name)
                        return order == .orderedSame ? $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) : order == .orderedAscending
                    }
                }
                let folders = listing.entries.filter { $0.kind == .folder }
                expandedFolderIds.formIntersection(Set(folders.map(\.id)))
                childCounts = Dictionary(uniqueKeysWithValues: folders.map { ($0.id, groups[Data($0.path.utf8)]?.count ?? 0) })
                // Iterative flattening keeps even deeply nested folders off the
                // Swift call stack. IDs own expansion; paths only locate children.
                var pending = (groups[Data(folder.utf8)] ?? []).reversed().map { ($0, 0) }
                while let (entry, depth) = pending.popLast() {
                    rows.append(entry)
                    rowDepths[entry.id] = depth
                    if entry.kind == .folder && expandedFolderIds.contains(entry.id) {
                        pending.append(contentsOf: (groups[Data(entry.path.utf8)] ?? []).reversed().map { ($0, depth + 1) })
                    }
                }
            }
        }
        if historyFailed { status = "Recent history could not be read. Your files are available in Files." }
        else if let listing = listing {
            status = listing.scanComplete ? "" : "The vault scan is incomplete. Some files may be unavailable. Pull down to retry."
        }
        canCreateNote = !loading && listing != nil
        if loading { emptyMessage = "" }
        else if listing == nil || historyFailed { emptyMessage = "" }
        else if listing?.scanComplete != true { emptyMessage = "No entries are available from the incomplete scan." }
        else if preferences.selected == .recents { emptyMessage = "Notes you open appear here. Browse Files or create a new note to get started." }
        else { emptyMessage = "This folder is empty. Create a new note to get started." }
    }
}

final class NativePagesController: UIViewController {
    private let model: NativePagesModel
    private let coordinator: NativePagesCoordinator
    private var hosting: UIHostingController<NativePagesView>?
    private var activityObservers: [NSObjectProtocol] = []

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        model = NativePagesModel(vault: vault)
        coordinator = NativePagesCoordinator(vault: vault, root: root, session: session)
        super.init(nibName: nil, bundle: nil)
        coordinator.owner = self
    }
    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onRouteChanged = { [weak self] route in self?.coordinator.recordPageNavigation(route) }
        coordinator.record(model.currentRoute)
        let pages = NativePagesView(model: model, navigate: { [weak self] direction in self?.coordinator.traverse(direction) }, open: { [weak self] entry in
            guard let self = self else { return }
            self.model.willOpen(entry)
            self.coordinator.openEditor(entry: entry, origin: self.model.preferences.selected.title)
        }, chooseVault: { [weak self] in self?.coordinator.chooseVault() }, refresh: { [weak self] in
            if let self = self { await self.coordinator.reload() }
        })
        let hosting = UIHostingController(rootView: pages)
        self.hosting = hosting
        view.backgroundColor = .systemBackground
        // A UIKit container marker does not propagate through SwiftUI's AX
        // environment and overwrite Settings/heading/tab/button identifiers.
        view.accessibilityIdentifier = "native.pages"
        view.isAccessibilityElement = false
        hosting.view.backgroundColor = .systemBackground
        hosting.view.clipsToBounds = false
        view.clipsToBounds = false
        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        hosting.didMove(toParent: self)
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.coordinator.foregroundRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.coordinator.cancelQueuedRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self, let scene = notification.object as? UIWindowScene,
                  scene === self.viewIfLoaded?.window?.windowScene else { return }
            self.coordinator.foregroundRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self, let scene = notification.object as? UIWindowScene,
                  scene === self.viewIfLoaded?.window?.windowScene else { return }
            self.coordinator.cancelQueuedRefresh()
        })
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        coordinator.setVisible(true)
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        coordinator.setVisible(false)
        navigationController?.setNavigationBarHidden(false, animated: false)
    }
    deinit {
        for observer in activityObservers { NotificationCenter.default.removeObserver(observer) }
    }
    fileprivate var currentRoute: NativeRoute { model.currentRoute }
    fileprivate var originTitle: String { model.preferences.selected.title }
    fileprivate func supports(_ page: NativePage) -> Bool { model.supports(page) }
    fileprivate func applyRoute(page: NativePage, folder: NativeFileEntry?) { model.applyRoute(page: page, folder: folder) }
    fileprivate func showRouteUnavailable() { model.showRouteUnavailable() }
    fileprivate func resetFolderRoute() { model.applyRoute(page: model.preferences.selected, folder: nil) }
    fileprivate func setRouteAvailability(back: Bool, forward: Bool) { model.setRouteAvailability(back: back, forward: forward) }
    fileprivate func setLoading() { model.setLoading() }
    fileprivate func showListing(_ listing: NativeVaultListing) { model.showListing(listing) }
    fileprivate func showLoadFailure(missingSelection: Bool = false) { model.showLoadFailure(missingSelection: missingSelection) }
}

@MainActor
private struct NativePagesView: View {
    @ObservedObject var model: NativePagesModel
    let navigate: (Int) -> Void
    let open: (NativeFileEntry?) -> Void
    let chooseVault: () -> Void
    let refresh: () async -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace
    @AccessibilityFocusState private var focus: Focus?
    @State private var showingSettings = false
    @State private var chooseVaultAfterDismiss = false

    private enum Focus: Hashable { case settings, compose, heading, folderHeading, entry(String) }
    private var currentHeadingFocus: Focus { model.isInFolder ? .folderHeading : .heading }
    private var motion: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9) }

    private var selectedMode: Binding<NativePage> {
        Binding(get: { model.preferences.selected }, set: { page in
            withAnimation(motion) { model.select(page) }
            focus = .heading
        })
    }

    var body: some View {
        VStack(spacing: 0) {
            // Draw glass above the opaque TabView sibling so its diffuse shadow
            // can cross the header boundary rather than being overpainted there.
            topBar.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 12).zIndex(1)
            TabView {
                pageContent.tabItem {
                    Label("Notes", systemImage: "note.text")
                        .accessibilityIdentifier("native.pages.tab.notes")
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
        .sheet(isPresented: $showingSettings, onDismiss: {
            if chooseVaultAfterDismiss {
                chooseVaultAfterDismiss = false
                chooseVault()
            } else { focus = .settings }
        }) { settingsContent }
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.vault.name)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.pages.vault-name")
            Menu {
                Picker("Notes view", selection: selectedMode) {
                    ForEach(NativePage.allCases, id: \.self) { page in
                        Label(page.title, systemImage: page.symbol)
                            .tag(page)
                            .accessibilityIdentifier("native.pages.mode.\(page.rawValue)")
                    }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: 8) {
                    Text(model.preferences.selected.title).font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "chevron.down").font(.body.weight(.semibold))
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Notes view")
            .accessibilityValue(model.preferences.selected.title)
            .accessibilityHint("Choose Recents or Files")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("native.pages.heading")
            .accessibilityFocused($focus, equals: .heading)
            .padding(.horizontal, 20)
            if model.isInFolder {
                Text(model.heading).font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("native.files.heading")
                    .accessibilityFocused($focus, equals: .folderHeading)
                    .padding(.horizontal, 20)
            }
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.footnote)
                    .foregroundColor(contrast == .increased ? .primary : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.pages.status")
                    .padding(.horizontal, 20)
            }
            if model.isInFolder {
                Button { withAnimation(motion) { model.parentFolder() }; focus = currentHeadingFocus } label: {
                    Label("Parent folder", systemImage: "chevron.left").frame(minHeight: 44)
                }
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.files.parent")
                .disabled(model.loading)
            }
            if model.loading && !model.rows.isEmpty {
                ProgressView("Updating vault").font(.footnote).padding(.horizontal, 20)
            }
            entryList
        }
    }

    @ViewBuilder private var topBar: some View {
        if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
            GlassEffectContainer(spacing: 8) { tabControls }
        } else { tabControls }
    }

    private var tabControls: some View {
        HStack(spacing: 8) {
            if model.isInFolder {
                NativeHistoryControls(backEnabled: model.canGoBack && !model.loading,
                                      forwardEnabled: model.canGoForward && !model.loading,
                                      identifierPrefix: "native.pages", navigate: navigate)
            } else {
                Button {
                    model.beginSettingsPresentation()
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape").padding(12).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .modifier(PageControlSurface(id: "settings", namespace: glassNamespace))
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("native.pages.settings")
                .accessibilityFocused($focus, equals: .settings)
            }
            Spacer(minLength: 0)
            Button { open(nil) } label: {
                Image(systemName: "square.and.pencil").padding(12).frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .modifier(PageControlSurface(id: "compose", namespace: glassNamespace))
            .accessibilityLabel("New note")
            .accessibilityIdentifier("native.pages.new-note")
            .disabled(!model.canCreateNote)
            .accessibilityFocused($focus, equals: .compose)
        }
        .font(.system(size: 17))
        .foregroundColor(.primary)
    }

    private var entryList: some View {
        ScrollViewReader { proxy in
            List {
                if model.loading && model.rows.isEmpty {
                    NativeLoadingSkeleton(editor: false).padding(.vertical, 12)
                        .listRowSeparator(.hidden)
                } else if model.rows.isEmpty {
                    Text(model.emptyMessage)
                        .font(.body)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 100, alignment: .center)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("native.pages.empty")
                }
                ForEach(model.rows, id: \.id) { entry in
                    HStack(spacing: 0) {
                        if model.preferences.selected == .files {
                            if entry.kind == .folder {
                                Button {
                                    withAnimation(motion) { model.toggleFolder(entry) }
                                } label: {
                                    Image(systemName: model.expandedFolderIds.contains(entry.id) ? "chevron.down" : "chevron.right")
                                        .font(.body.weight(.semibold)).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(model.expandedFolderIds.contains(entry.id) ? "Collapse" : "Expand") \(entry.name)\(entry.parent.isEmpty ? "" : ", in " + entry.parent)")
                                .accessibilityValue(model.expandedFolderIds.contains(entry.id) ? "Expanded" : "Collapsed")
                                .accessibilityIdentifier("native.folder.expand.\(entry.id)")
                                .disabled(model.loading)
                            } else { Color.clear.frame(width: 44, height: 44).accessibilityHidden(true) }
                        }
                        Button {
                            if entry.kind == .folder {
                                withAnimation(motion) { model.enter(entry) }
                                focus = currentHeadingFocus
                            } else { open(entry) }
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: entry.kind == .folder ? "folder.fill" : "doc.text")
                                    .font(.title2)
                                    .foregroundColor(entry.kind == .folder ? .accentColor : .secondary)
                                    .frame(minWidth: 28, minHeight: 44).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.name).font(.body).foregroundColor(.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    let metadata = model.metadata(for: entry)
                                    if !metadata.isEmpty {
                                        Text(metadata).font(.caption).foregroundColor(.secondary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(!entry.parent.isEmpty
                                            ? "\(entry.name), \(entry.parent)" : entry.name)
                        .accessibilityValue(entry.kind == .folder ? "Folder, \(model.metadata(for: entry))" : model.metadata(for: entry))
                        .accessibilityHint(entry.kind == .folder ? "Opens folder contents" : "Opens in the editor. Return here when finished.")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("native.entry.\(entry.id)")
                        .disabled(model.loading)
                        .accessibilityFocused($focus, equals: .entry(entry.id))
                    }
                    .padding(.leading, CGFloat(min(model.depth(for: entry), 8)) * 12)
                    .listRowSeparator(model.preferences.selected == .files ? .visible : .hidden)
                    .id(entry.id)
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 44)
            .accessibilityIdentifier("native.pages.entries")
            .refreshable { await refresh() }
            .onChange(of: model.focusGeneration) { _ in
                if let id = model.focusedEntryId {
                    proxy.scrollTo(id, anchor: .center)
                    DispatchQueue.main.async { focus = .entry(id) }
                } else { focus = currentHeadingFocus }
            }
        }
    }

    private var settingsContent: some View {
        NavigationView {
            Form {
                Section {
                    Text("\(model.vault.name) · On this device")
                    Button("Choose vault") {
                        // Finish the native modal dismissal before closing the
                        // unleased page host and popping to the vault picker.
                        chooseVaultAfterDismiss = true
                        showingSettings = false
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("native.settings.choose-vault")
                }
            }
            .accessibilityIdentifier("native.settings")
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingSettings = false }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("native.settings.done")
                }
            }
        }
        .navigationViewStyle(.stack)
    }

}

// Real Liquid Glass is restricted to the functional top controls. Content stays
// on native solid surfaces. Accessibility preferences choose the opaque fallback.
private struct PageControlSurface: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    var selected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
            content
                .glassEffect(selected ? .regular.tint(Color(uiColor: .tertiarySystemFill)).interactive() : .regular.interactive(), in: Capsule())
                .glassEffectID(id, in: namespace)
                .glassEffectTransition(reduceMotion ? .identity : .matchedGeometry)
        } else {
            content.background(selected ? Color(uiColor: .tertiarySystemFill) : Color(uiColor: .secondarySystemBackground), in: Capsule())
        }
    }
}
