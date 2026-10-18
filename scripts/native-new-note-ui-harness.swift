// Boundary doubles only. Root NewNote methods and NativeDocumentTabs are actual.
enum TestFailure: Error { case injected }
@MainActor enum Trace { static var events: [String] = [] }
struct LocalVault { let id: UUID; let clientId: String }
final class FakeSession { let vault: LocalVault; init(_ vault: LocalVault) { self.vault = vault } }
struct NativeExclusiveSessionBinding {
    let session: FakeSession; let localStoreId: String
    let finish: (Result<Void, Error>) -> Void
}
@MainActor final class NativeNewNoteRequest {
    struct Intent { let creationID: UUID; let tabID: UUID }
    struct Selection { let creationID: String; let tabID: String }
    struct HandoffToken { let creationID: UUID; let tabID: UUID }
    struct Handoff { let document: NativeTabDocument; let token: HandoffToken }
    enum Action { case inspectPending, create(Intent), resumePending }
    enum Outcome { case clear, rejected(Selection), pending(Selection), ready(Handoff) }
    enum Failure: Error { case invalidJournal }
    static var instances: [NativeNewNoteRequest] = []
    let id: Int
    let binding: NativeExclusiveSessionBinding
    var retainsReservation = true
    var actions: [Action] = []
    var executeCompletion: ((Result<Outcome, Error>) -> Void)?
    var ackCompletion: ((Result<Void, Error>) -> Void)?
    init(binding: NativeExclusiveSessionBinding) {
        self.binding = binding; id = Self.instances.count
        Self.instances.append(self); Trace.events.append("helper:\(id)")
    }
    func execute(_ action: Action, completion: @escaping (Result<Outcome, Error>) -> Void) {
        actions.append(action); executeCompletion = completion
        switch action {
        case .inspectPending: Trace.events.append("inspect:\(id)")
        case .resumePending: Trace.events.append("resume:\(id)")
        case .create(let intent): Trace.events.append("create:\(intent.creationID):\(intent.tabID)")
        }
    }
    func deliver(_ outcome: Outcome, release: Bool = true) {
        if release { retainsReservation = false; binding.finish(.success(())); Trace.events.append("release:\(id)") }
        let callback = executeCompletion!; executeCompletion = nil; callback(.success(outcome))
    }
    func fail() { let callback = executeCompletion!; executeCompletion = nil; callback(.failure(TestFailure.injected)) }
    func acknowledgeHandoff(_ token: HandoffToken, completion: @escaping (Result<Void, Error>) -> Void) {
        Trace.events.append("ack:\(id)"); ackCompletion = completion
    }
    func ack(_ success: Bool) {
        let callback = ackCompletion!; ackCompletion = nil
        if success { retainsReservation = false; binding.finish(.success(())); Trace.events.append("release:\(id)"); callback(.success(())) }
        else { callback(.failure(TestFailure.injected)) }
    }
}
@MainActor final class NativePagesController {
    let vault: LocalVault; var isNativePageRouteRestorationReady = true
    var documentTabTransitionRetired = false
    var blocked = false, canResume = false; var lends = 0
    init(_ vault: LocalVault) { self.vault = vault }
    func setNewNoteState(blocked: Bool, message: String = "", canResume: Bool = false) {
        self.blocked = blocked; self.canResume = canResume
    }
    func lendNewNoteSession(completion: @escaping (Result<NativeExclusiveSessionBinding, Error>) -> Void) {
        lends += 1; Trace.events.append("lend:\(lends)")
        completion(.success(.init(session: FakeSession(vault), localStoreId: "store", finish: { _ in })))
    }
}
@MainActor final class NativeTabMetadataStore {
    static var stores: [UUID: NativeTabMetadataStore] = [:]
    var saves: [Data] = []; var failNext = false
    func save(_ bytes: Data) throws {
        Trace.events.append("save")
        if failNext { failNext = false; throw TestFailure.injected }
        saves.append(bytes)
    }
}
@MainActor final class NativeDocumentTabCoordinator {
    let model: NativeDocumentTabs; let owner: UUID
    var closeCompletion: ((Result<Void, Error>) -> Void)?
    var closePresenter: NativePagesController?
    var retryClose: (() -> Void)?
    var opens = 0
    init(_ model: NativeDocumentTabs, _ owner: UUID) { self.model = model; self.owner = owner }
    func historyNavigationOwner(for pages: NativePagesController) -> UUID? { owner }
    func performNativeRoute(from pages: NativePagesController, retry: (() -> Void)?, completion: @escaping (Result<Void, Error>) -> Void) {
        Trace.events.append("close-request"); closeCompletion = completion; closePresenter = pages; retryClose = retry
    }
    func close(_ success: Bool, pages: NativePagesController, retired: Bool? = nil) {
        pages.documentTabTransitionRetired = retired ?? success
        Trace.events.append(success ? "close-ACK" : "close-failure")
        let callback = closeCompletion!; closeCompletion = nil
        callback(success ? .success(()) : .failure(TestFailure.injected))
    }
    func finishDocumentTabOverview() { opens += 1; Trace.events.append("activate-existing") }
}
@MainActor final class FakeNavigation { var topViewController: NativePagesController? }
@MainActor final class NativeVaultPicker {
    private var navigationController: FakeNavigation? = FakeNavigation()
    private var documentTabs: NativeDocumentTabCoordinator?
    private weak var boundPages: NativePagesController?
    private var boundPagesOwner: UUID?
    private static func retainedTabMetadataStore(vaultID: UUID) throws -> NativeTabMetadataStore {
        if let store = NativeTabMetadataStore.stores[vaultID] { return store }
        let store = NativeTabMetadataStore(); NativeTabMetadataStore.stores[vaultID] = store; return store
    }
    // INSERT ACTUAL ROOT GLUE
}

extension NativeVaultPicker {
    @MainActor static func runChecks() throws {
        var checks = 0
        func check(_ value: Bool, _ label: String) {
            precondition(value, label); checks += 1; print("PASS \(label)")
        }
        func fixture() -> (NativeVaultPicker, NativePagesController, NativeDocumentTabCoordinator, UUID, NativeTabMetadataStore) {
            NativeNewNoteRequest.instances = []; Trace.events = []
            let vault = LocalVault(id: UUID(), clientId: UUID().uuidString.lowercased())
            let root = NativeVaultPicker(), pages = NativePagesController(vault), owner = UUID()
            let tabs = NativeDocumentTabCoordinator(NativeDocumentTabs(vaultID: vault.id), owner)
            root.boundPages = pages; root.boundPagesOwner = owner; root.documentTabs = tabs
            root.navigationController?.topViewController = pages
            let store = try! retainedTabMetadataStore(vaultID: vault.id)
            return (root, pages, tabs, owner, store)
        }
        func inspectClear(_ root: NativeVaultPicker, _ pages: NativePagesController, _ owner: UUID) {
            root.inspectNewNote(pages: pages, vault: pages.vault, owner: owner)
            NativeNewNoteRequest.instances.last!.deliver(.clear)
        }
        func handoff(_ pages: NativePagesController, _ cid: UUID, _ tab: UUID) throws -> NativeNewNoteRequest.Handoff {
            .init(document: try .init(vaultID: pages.vault.id, localStoreID: "store", stableFileID: "stable", displayTitle: "Untitled"), token: .init(creationID: cid, tabID: tab))
        }
        do {
            let (root,pages,tabs,owner,store) = fixture(); let tab = tabs.model.selectedTabID
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            check(root.newNoteReservation == nil && pages.lends == 0, "create blocked before startup inspection")
            root.inspectNewNote(pages: pages, vault: pages.vault, owner: owner)
            let inspection = NativeNewNoteRequest.instances[0]
            check(inspection.actions.count == 1 && store.saves.isEmpty, "startup inspect never saves or creates")
            inspection.deliver(.clear)
            store.failNext = true; root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            let reservation = root.newNoteReservation!, cid = reservation.intent!.creationID
            check(pages.canResume && pages.blocked && pages.lends == 1, "original metadata failure retains actionable reservation without creation")
            root.resumeNewNote(pages: pages, owner: owner)
            let creation = NativeNewNoteRequest.instances[1]
            if case .create(let intent) = creation.actions[0] { check(intent.creationID == cid && intent.tabID == tab, "pre-journal retry preserves original CID and tab") }
            else { preconditionFailure("expected create") }
            check(Trace.events.lastIndex(of: "save")! < Trace.events.firstIndex(where: { $0.hasPrefix("create:") })!, "original metadata precedes durable create")
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            check(NativeNewNoteRequest.instances.count == 2 && root.newNoteReservation === reservation, "duplicate FAB keeps exact reservation")
            creation.fail(); root.resumeNewNote(pages: pages, owner: owner)
            check(root.newNoteReservation?.helper === creation && creation.actions.count == 2 && pages.lends == 2, "uncertainty retries retained creation helper without new loan")
            store.failNext = true; creation.deliver(.ready(try handoff(pages,cid,tab)))
            let ticket = reservation.ticket!
            check(tabs.model.pendingIntent == ticket && tabs.model.selectedTab.isHome && NativeNewNoteRequest.instances.count == 2, "prospective metadata failure retains exact ticket before ACK")
            let prospective = try tabs.model.encodedMetadata(for: ticket)
            root.resumeNewNote(pages: pages, owner: owner)
            let ack = NativeNewNoteRequest.instances[2]
            check(ack !== creation && ack.binding.session.vault.clientId == creation.binding.session.vault.clientId, "ACK uses fresh helper with original client")
            check(store.saves.last == prospective && tabs.model.pendingIntent == ticket, "retry persists exact pending ticket bytes")
            check(Trace.events.firstIndex(of: "release:1")! < Trace.events.firstIndex(of: "ack:2")!, "creation release precedes fresh ACK")
            check(tabs.closeCompletion == nil && tabs.opens == 0, "ACK gate prevents close and activation")
            ack.ack(false); root.resumeNewNote(pages: pages, owner: owner)
            check(reservation.helper === ack && NativeNewNoteRequest.instances.count == 3 && tabs.model.pendingIntent == ticket, "ACK failure retries same helper and ticket")
            ack.ack(true)
            check(tabs.closeCompletion != nil && tabs.opens == 0 && tabs.model.selectedTab.isHome, "ACK release requests close without early commit")
            check(Trace.events.firstIndex(of: "release:2")! < Trace.events.firstIndex(of: "close-request")!, "ACK release precedes Pages close request")
            tabs.close(false,pages: pages); root.resumeNewNote(pages: pages, owner: owner)
            check(tabs.model.pendingIntent == ticket && NativeNewNoteRequest.instances.count == 3, "Pages close failure keeps same ticket without another ACK loan")
            tabs.close(true,pages: pages)
            check(tabs.model.pendingIntent == nil && tabs.model.selectedTabID == tab && tabs.model.selectedTab.document?.stableFileID == "stable", "actual close ACK commits exact original tab and stable document")
            check(tabs.opens == 1 && root.newNoteReservation == nil, "successful handoff activates existing document once")
            print("TRACE " + Trace.events.joined(separator: " → "))
        }
        do {
            let (root,pages,tabs,owner,_) = fixture(), cid = UUID()
            let tab = tabs.model.selectedTabID
            root.inspectNewNote(pages: pages, vault: pages.vault, owner: owner)
            let inspection = NativeNewNoteRequest.instances[0]
            inspection.deliver(.pending(.init(creationID: cid.uuidString, tabID: tab.uuidString)), release: false)
            check(pages.canResume && tabs.opens == 0 && inspection.actions.count == 1, "startup pending exposes Resume without auto-create")
            root.resumeNewNote(pages: pages, owner: owner)
            if case .create(let intent) = inspection.actions.last! { check(intent.creationID == cid && intent.tabID == tab, "pending Resume retries original inspected identity") }
            else { preconditionFailure("expected retained CID create retry") }
            inspection.deliver(.ready(try handoff(pages,cid,tab)))
            check(root.newNoteReservation?.ticket != nil && NativeNewNoteRequest.instances.count == 2, "pending explicit Resume progresses original ticket")
        }
        do {
            let (root,pages,tabs,owner,_) = fixture(), cid = UUID(), missingTab = UUID()
            root.inspectNewNote(pages: pages, vault: pages.vault, owner: owner)
            NativeNewNoteRequest.instances[0].deliver(.ready(try handoff(pages,cid,missingTab)))
            check(tabs.opens == 0 && root.newNoteReservation?.ticket == nil && pages.canResume, "startup ready remains explicit Resume")
            root.resumeNewNote(pages: pages, owner: owner)
            check(pages.canResume && root.newNoteReservation?.intent?.tabID == missingTab && tabs.model.tabs.count == 1 && tabs.model.pendingIntent == nil && NativeNewNoteRequest.instances.count == 1, "missing original tab fails actionably without fallback UUID or host")
        }
        do {
            let (root,pages,_,owner,_) = fixture()
            inspectClear(root,pages,owner)
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            let helper = NativeNewNoteRequest.instances[1], old = root.newNoteReservation!
            root.boundPagesOwner = UUID()
            helper.fail()
            check(root.newNoteReservation === old && pages.canResume, "stale owner callback cannot discard original reservation")
        }
        do {
            let (root,pages,tabs,owner,_) = fixture(), missing = UUID(), cid = UUID()
            root.inspectNewNote(pages: pages, vault: pages.vault, owner: owner)
            let inspection = NativeNewNoteRequest.instances[0]
            inspection.deliver(.pending(.init(creationID: cid.uuidString, tabID: missing.uuidString)), release: false)
            root.resumeNewNote(pages: pages, owner: owner)
            check(pages.canResume && inspection.actions.count == 1 && tabs.model.pendingIntent == nil && pages.lends == 1, "missing pending original tab never dispatches retry create")
        }
        do {
            let (root,pages,tabs,owner,_) = fixture()
            inspectClear(root,pages,owner)
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            let request = root.newNoteReservation!, intent = request.intent!
            NativeNewNoteRequest.instances[1].deliver(.ready(try handoff(pages,intent.creationID,intent.tabID)))
            let ticket = request.ticket!
            root.boundPagesOwner = UUID()
            NativeNewNoteRequest.instances[2].ack(true)
            check(tabs.closeCompletion == nil && tabs.model.pendingIntent == ticket && root.newNoteReservation === request && pages.canResume, "delayed ACK after owner change retains action without old close authority")
        }
        do {
            let (root,pages,tabs,owner,_) = fixture()
            inspectClear(root,pages,owner)
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            let request = root.newNoteReservation!, intent = request.intent!
            NativeNewNoteRequest.instances[1].deliver(.ready(try handoff(pages,intent.creationID,intent.tabID)))
            let ticket = request.ticket!
            NativeNewNoteRequest.instances[2].ack(true)
            tabs.close(false,pages: pages,retired: true)
            let recoveryPresenter = NativePagesController(pages.vault)
            root.navigationController?.topViewController = recoveryPresenter
            tabs.retryClose!()
            check(tabs.closePresenter === recoveryPresenter && tabs.model.pendingIntent == ticket && NativeNewNoteRequest.instances.count == 3 && request.acknowledged, "post-retirement recovery presenter retries same ticket without helper or ACK replay")
            tabs.close(true,pages: pages)
            check(tabs.opens == 1 && tabs.model.selectedTabID == intent.tabID && tabs.model.selectedTab.document?.stableFileID == "stable", "recovery presenter closes before exact original-tab activation")
        }
        do {
            let (root,pages,tabs,owner,_) = fixture()
            inspectClear(root,pages,owner)
            root.createNewNote(pages: pages, vault: pages.vault, owner: owner)
            let request = root.newNoteReservation!, intent = request.intent!
            NativeNewNoteRequest.instances[1].deliver(.ready(try handoff(pages,intent.creationID,intent.tabID)))
            let ticket = request.ticket!
            NativeNewNoteRequest.instances[2].ack(true)
            let newerOwner = UUID(); root.boundPagesOwner = newerOwner
            tabs.close(true,pages: pages)
            check(tabs.model.pendingIntent == ticket && tabs.opens == 0 && root.boundPagesOwner == newerOwner && root.newNoteReservation === request && pages.canResume, "delayed close ACK cannot commit or clear newer owner")
        }
        print("PASS \(checks) focused actual-root NewNote host checks; UIKit/transport/Rust runtime unverified")
    }
}
@main struct NativeNewNoteUIHarness { @MainActor static func main() throws { try NativeVaultPicker.runChecks() } }
