import UIKit
import SwiftUI

// UI metadata only. Rust remains the sole authority for vault entries/content.
struct NativeFileEntry: Decodable {
    enum Kind: String, Decodable { case file, folder }
    let id: String
    let path: String
    let kind: Kind
    let deleted: Bool

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
        pageRead(.identity) { identityResult in
            switch identityResult {
            case .failure(let error): completion(.failure(error))
            case .success(let object):
                guard let identity = object["identity"] as? [String: Any],
                      let storeId = identity["local_store_id"] as? String, !storeId.isEmpty else {
                    completion(.failure(NativePageError.invalidResponse)); return
                }
                self.pageRead(.snapshot) { snapshotResult in
                    switch snapshotResult {
                    case .failure(let error): completion(.failure(error))
                    case .success(let snapshot):
                        do {
                            struct Row: Decodable { let state: NativeFileEntry }
                            struct Snapshot: Decodable { let entries: [Row]; let cursor: String }
                            let bytes = try JSONSerialization.data(withJSONObject: snapshot)
                            let decoded = try JSONDecoder().decode(Snapshot.self, from: bytes)
                            let entries = decoded.entries.map(\.state)
                            guard !decoded.cursor.isEmpty, entries.allSatisfy({ !$0.deleted && NativeFileEntry.isValidEntryId($0.id) && NativeFileEntry.isValidPath($0.path) }),
                                  Set(entries.map(\.id)).count == entries.count,
                                  Set(entries.map { Data($0.path.utf8) }).count == entries.count else { throw NativePageError.invalidResponse }
                            self.context { context in
                                let reconciliation = context["reconciliation"] as? [String: Any]
                                completion(.success(NativeVaultListing(localStoreId: storeId, entries: entries.filter { NativeFileEntry.isVisiblePath($0.path) },
                                                                      scanComplete: reconciliation?["complete"] as? Bool == true)))
                            }
                        } catch { completion(.failure(NativePageError.invalidResponse)) }
                    }
                }
            }
        }
    }

    func recordNoteOpened(path: String, entryId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        guard NativeFileEntry.isVisiblePath(path), NativeFileEntry.isValidEntryId(entryId) else {
            completion(.failure(NativePageError.invalidResponse)); return
        }
        pageListing { result in
            completion(result.flatMap { listing in
                Result {
                    guard let entry = listing.entries.first(where: { $0.id == entryId && NativeFileEntry.samePath($0.path, path) && $0.kind == .file }) else {
                        throw NativePageError.unavailable
                    }
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

private struct NativePagePreferences {
    private static let key = "native.pages.v1"
    var pages: [NativePage]
    var selected: NativePage

    init() {
        let defaults = UserDefaults.standard
        let saved = (defaults.stringArray(forKey: Self.key) ?? ["recents", "files"]).compactMap(NativePage.init(rawValue:))
        pages = saved.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        if pages.isEmpty { pages = [.recents, .files] }
        let prior = defaults.string(forKey: Self.key + ".selected").flatMap(NativePage.init(rawValue:))
        if let prior = prior, pages.contains(prior) { selected = prior }
        else { selected = pages[0] }
    }

    func persist() {
        UserDefaults.standard.set(pages.map(\.rawValue), forKey: Self.key)
        UserDefaults.standard.set(selected.rawValue, forKey: Self.key + ".selected")
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
    private var busy = false
    private var editorActive = false
    weak var owner: NativePagesController?

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        self.vault = vault
        self.root = root
        self.session = session
    }

    func load(refresh: Bool = false, completion: @escaping () -> Void = {}) {
        guard !busy, !editorActive else { completion(); return }
        busy = true
        generation += 1
        let ticket = generation
        owner?.setLoading()
        if let session = session {
            if refresh { refreshThenRead(session, ticket: ticket, completion: completion) }
            else { read(session, ticket: ticket, completion: completion) }
            return
        }
        NativeMobileSession.open(vault: vault, root: root) { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else {
                if case .success(let session) = result { session.close {} }
                completion()
                return
            }
            switch result {
            case .success(let session): self.session = session; self.read(session, ticket: ticket, completion: completion)
            case .failure: self.busy = false; self.owner?.showLoadFailure(); completion()
            }
        }
    }

    private func refreshThenRead(_ session: NativeMobileSession, ticket: Int, completion: @escaping () -> Void) {
        session.refresh { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { completion(); return }
            switch result {
            case .success: self.read(session, ticket: ticket, completion: completion)
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
                self.owner?.showListing(listing)
                completion()
            case .failure: self.fail(session, ticket: ticket, completion: completion)
            }
        }
    }

    private func fail(_ session: NativeMobileSession, ticket: Int, missingSelection: Bool = false, completion: @escaping () -> Void = {}) {
        // A failed/fenced host must not be reused by every retry. Complete close
        // before making Reload usable so a new host cannot overlap this one.
        self.session = nil
        busy = true
        session.close { [weak self] in
            guard let self = self, self.generation == ticket else { completion(); return }
            self.busy = false
            self.owner?.showLoadFailure(missingSelection: missingSelection)
            completion()
        }
    }

    func reload() async {
        await withCheckedContinuation { continuation in load(refresh: true) { continuation.resume() } }
    }

    func openEditor(entry: NativeFileEntry?, origin: String) {
        guard !busy, !editorActive, let session = session, owner?.navigationController != nil else { return }
        generation += 1
        let ticket = generation
        guard let entry = entry else { transfer(session, initialEntry: nil, origin: origin); return }
        busy = true
        owner?.setLoading()
        // The row's path is only a display locator. Resolve its stable identity
        // again; never open a replacement entry that has reused the old path.
        session.pageListing { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { return }
            switch result {
            case .success(let listing):
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
        self.session = nil
        editorActive = true
        let editor = NativeEditorContainer(session: session, initialEntry: initialEntry, originTitle: origin) { [weak self] in
            self?.editorActive = false
        }
        navigation.pushViewController(editor, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func chooseVault() {
        guard !busy, !editorActive else { return }
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
    @Published private(set) var canOpenEditor = false
    @Published private(set) var emptyMessage = ""
    @Published private(set) var focusGeneration = 0
    private var listing: NativeVaultListing?
    private(set) var focusedEntryId: String?
    private var restoringFocus = false

    init(vault: LocalVault) { self.vault = vault }
    var heading: String { preferences.selected == .files && !folder.isEmpty ? folder : preferences.selected.title }
    var isInFolder: Bool { preferences.selected == .files && !folder.isEmpty }

    func setLoading() {
        loading = true
        listing = nil
        status = "Loading vault…"
        render()
    }
    func showLoadFailure(missingSelection: Bool = false) {
        loading = false
        listing = nil
        status = missingSelection
            ? "The selected note is no longer available. Reload to see the current files."
            : "Could not load this vault safely. Reload to try again. Your files have not been changed."
        render()
        focusedEntryId = nil
        restoringFocus = false
        focusGeneration += 1
        UIAccessibility.post(notification: .announcement, argument: "Could not load vault")
    }
    func showListing(_ listing: NativeVaultListing) {
        loading = false
        self.listing = listing
        status = listing.scanComplete ? "" : "The vault scan is incomplete. Some files may be unavailable. Open the editor for recovery."
        if !folder.isEmpty && !listing.entries.contains(where: { NativeFileEntry.samePath($0.path, folder) && $0.kind == .folder }) { folder = "" }
        render()
        if restoringFocus {
            if !rows.contains(where: { $0.id == focusedEntryId }) { focusedEntryId = nil }
            focusGeneration += 1
            restoringFocus = false
        }
    }
    func select(_ page: NativePage) {
        preferences.selected = page
        preferences.persist()
        focusedEntryId = nil
        render()
    }
    func toggle(_ page: NativePage) {
        if preferences.pages.contains(page) {
            guard preferences.pages.count > 1 else { return }
            preferences.pages.removeAll { $0 == page }
            if preferences.selected == page { preferences.selected = preferences.pages[0] }
        } else { preferences.pages.append(page) }
        preferences.persist()
        render()
    }
    func enter(_ folder: NativeFileEntry) { self.folder = folder.path; render() }
    func parentFolder() {
        folder = NativeFileEntry.pathComponents(folder).dropLast().joined(separator: "/")
        render()
    }
    func willOpen(_ entry: NativeFileEntry?) {
        focusedEntryId = entry?.id
        restoringFocus = true
    }
    private func render() {
        rows = []
        var historyFailed = false
        if let listing = listing {
            if preferences.selected == .recents {
                do { rows = try NativeRecentStore.entries(vaultId: vault.id, listing: listing) }
                catch { historyFailed = true }
            } else {
                rows = listing.entries.filter { NativeFileEntry.samePath($0.parent, folder) }.sorted {
                    if $0.kind != $1.kind { return $0.kind == .folder }
                    return $0.name.localizedStandardCompare($1.name) == .orderedAscending
                }
            }
        }
        if historyFailed { status = "Recent history could not be read. Your files are available in Files." }
        else if let listing = listing {
            status = listing.scanComplete ? "" : "The vault scan is incomplete. Some files may be unavailable. Open the editor for recovery."
        }
        canOpenEditor = !loading && listing != nil
        if loading { emptyMessage = "" }
        else if listing == nil || historyFailed { emptyMessage = "" }
        else if listing?.scanComplete != true { emptyMessage = "No entries are available from the incomplete scan." }
        else if preferences.selected == .recents { emptyMessage = "Notes you open appear here. Browse Files or open the editor to get started." }
        else { emptyMessage = "This folder is empty. Open the editor to create a note." }
    }
}

final class NativePagesController: UIViewController {
    private let model: NativePagesModel
    private let coordinator: NativePagesCoordinator
    private var hosting: UIHostingController<NativePagesView>?

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        model = NativePagesModel(vault: vault)
        coordinator = NativePagesCoordinator(vault: vault, root: root, session: session)
        super.init(nibName: nil, bundle: nil)
        coordinator.owner = self
    }
    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let pages = NativePagesView(model: model, open: { [weak self] entry in
            guard let self = self else { return }
            self.model.willOpen(entry)
            self.coordinator.openEditor(entry: entry, origin: self.model.preferences.selected.title)
        }, chooseVault: { [weak self] in self?.coordinator.chooseVault() }, refresh: { [weak self] in
            if let self = self { await self.coordinator.reload() }
        })
        let hosting = UIHostingController(rootView: pages)
        self.hosting = hosting
        view.backgroundColor = .systemBackground
        hosting.view.backgroundColor = .systemBackground
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
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        coordinator.load()
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.setNavigationBarHidden(false, animated: false)
    }
    fileprivate func setLoading() { model.setLoading() }
    fileprivate func showListing(_ listing: NativeVaultListing) { model.showListing(listing) }
    fileprivate func showLoadFailure(missingSelection: Bool = false) { model.showLoadFailure(missingSelection: missingSelection) }
}

@MainActor
private struct NativePagesView: View {
    @ObservedObject var model: NativePagesModel
    let open: (NativeFileEntry?) -> Void
    let chooseVault: () -> Void
    let refresh: () async -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var typeSize
    @Namespace private var glassNamespace
    @State private var sheet: PageSheet?
    @State private var sheetOrigin: Focus = .settings
    @State private var chooseVaultAfterDismiss = false
    @AccessibilityFocusState private var focus: Focus?

    private enum PageSheet: String, Identifiable { case settings, pages; var id: String { rawValue } }
    private enum Focus: Hashable { case settings, plus, heading, entry(String) }
    private var motion: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            topBar.padding(.horizontal, 16).padding(.top, 12)
            Text(model.heading)
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("native.pages.heading")
                .accessibilityFocused($focus, equals: .heading)
                .padding(.horizontal, 20)
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.footnote)
                    .foregroundColor(contrast == .increased ? .primary : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.pages.status")
                    .padding(.horizontal, 20)
            }
            pageActions.padding(.horizontal, 16)
            entryList
        }
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("native.pages")
        .sheet(item: $sheet, onDismiss: {
            if chooseVaultAfterDismiss {
                chooseVaultAfterDismiss = false
                chooseVault()
            } else { focus = sheetOrigin }
        }) { destination in
            sheetContent(destination)
        }
    }

    @ViewBuilder private var topBar: some View {
        if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
            GlassEffectContainer(spacing: 8) { tabControls }
        } else { tabControls }
    }

    private var tabControls: some View {
        HStack(spacing: 10) {
            Button {
                sheetOrigin = .settings
                sheet = .settings
            } label: { Image(systemName: "gearshape").padding(12).frame(minWidth: 44, minHeight: 44) }
                .buttonStyle(.plain)
                .modifier(PageControlSurface(id: "settings", namespace: glassNamespace))
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("native.pages.settings")
                .accessibilityFocused($focus, equals: .settings)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.preferences.pages, id: \.self) { page in
                        pageButton(page)
                    }
                }.padding(.vertical, 4)
            }
            .accessibilityIdentifier("native.pages.tabs")
            Button {
                sheetOrigin = .plus
                sheet = .pages
            } label: { Image(systemName: "plus").padding(12).frame(minWidth: 44, minHeight: 44) }
                .buttonStyle(.plain)
                .modifier(PageControlSurface(id: "plus", namespace: glassNamespace))
                .accessibilityLabel("Manage pages")
                .accessibilityIdentifier("native.pages.add")
                .disabled(model.loading)
                .accessibilityFocused($focus, equals: .plus)
        }
        .font(.body)
        .foregroundColor(.primary)
    }

    private func pageButton(_ page: NativePage) -> some View {
        let selected = page == model.preferences.selected
        return Button {
            withAnimation(motion) { model.select(page) }
            focus = .heading
        } label: {
            HStack(spacing: 8) {
                Image(systemName: page.symbol)
                if selected { Text(page.title).fixedSize().transition(.opacity) }
            }
            .font(.body.weight(selected ? .semibold : .regular))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .modifier(PageControlSurface(id: page.rawValue, namespace: glassNamespace, selected: selected))
        .accessibilityLabel(page.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("native.pages.tab.\(page.rawValue)")
        .disabled(model.loading)
        .transition(reduceMotion ? .opacity : .scale(scale: 0.95).combined(with: .opacity))
    }

    @ViewBuilder private var pageActions: some View {
        if typeSize.isAccessibilitySize { VStack(alignment: .leading, spacing: 4) { actionButtons } }
        else { HStack(spacing: 12) { actionButtons } }
    }
    @ViewBuilder private var actionButtons: some View {
        if model.isInFolder {
            Button { withAnimation(motion) { model.parentFolder() }; focus = .heading } label: {
                Label("Parent folder", systemImage: "chevron.left").padding(.horizontal, 4).frame(minHeight: 44)
            }.accessibilityIdentifier("native.files.parent")
        }
        Button { Task { await refresh() } } label: {
            Label("Reload", systemImage: "arrow.clockwise").padding(.horizontal, 4).frame(minHeight: 44)
        }
        .disabled(model.loading)
        .accessibilityIdentifier("native.pages.refresh")
        Button { open(nil) } label: {
            Text("Open editor").padding(.horizontal, 4).frame(minHeight: 44)
        }
        .disabled(!model.canOpenEditor)
        .accessibilityIdentifier("native.pages.open-editor")
    }

    private var entryList: some View {
        ScrollViewReader { proxy in
            List {
                if model.loading {
                    HStack { Spacer(); ProgressView("Loading vault"); Spacer() }
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
                    Button {
                        if entry.kind == .folder {
                            withAnimation(motion) { model.enter(entry) }
                            focus = .heading
                        } else { open(entry) }
                    } label: {
                        HStack(spacing: 16) {
                            Image(systemName: entry.kind == .folder ? "folder" : "doc.text")
                                .foregroundColor(.secondary)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.name).font(.body).foregroundColor(.primary)
                                if model.preferences.selected == .recents {
                                    Text(entry.parent.isEmpty ? model.vault.name : entry.parent)
                                        .font(.caption).foregroundColor(.secondary)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption).foregroundColor(.secondary).accessibilityHidden(true)
                        }
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .id(entry.id)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(model.preferences.selected == .recents && !entry.parent.isEmpty
                                        ? "\(entry.name), \(entry.parent)" : entry.name)
                    .accessibilityValue(entry.kind == .folder ? "Folder" : "")
                    .accessibilityHint(entry.kind == .folder ? "Opens folder" : "Opens in the editor. Return here when finished.")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier("native.entry.\(entry.id)")
                    .accessibilityFocused($focus, equals: .entry(entry.id))
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
                } else { focus = .heading }
            }
        }
    }

    private func sheetContent(_ destination: PageSheet) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(destination == .settings ? "Settings" : "Pages").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Spacer()
                Button("Done") { sheet = nil }.frame(minWidth: 44, minHeight: 44)
            }.padding(.horizontal, 20).padding(.top, 16)
            if destination == .settings {
                Text("\(model.vault.name) · On this device").font(.body).padding(.horizontal, 20)
                Button("Choose vault") {
                    // Dismiss this presentation before the owning navigation pop.
                    chooseVaultAfterDismiss = true
                    sheet = nil
                }
                .frame(minHeight: 44)
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.settings.choose-vault")
                .disabled(model.loading)
                Spacer()
            } else {
                Text("Choose the pages in your tab row. Recents and Files are available now.")
                    .font(.body).padding(.horizontal, 20)
                List(NativePage.allCases, id: \.self) { page in
                    let included = model.preferences.pages.contains(page)
                    Button {
                        withAnimation(motion) { model.toggle(page) }
                    } label: {
                        HStack {
                            Label(page.title, systemImage: page.symbol)
                            Spacer()
                            Text(included ? "Remove" : "Add").foregroundColor(.secondary)
                        }.frame(minHeight: 44)
                    }
                    .disabled(included && model.preferences.pages.count == 1)
                    .accessibilityLabel("\(included ? "Remove" : "Add") \(page.title)")
                    .accessibilityIdentifier("native.pages.configure.\(page.rawValue)")
                }.listStyle(.plain)
            }
        }
        .foregroundColor(.primary)
        .background(Color(uiColor: .systemBackground))
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
