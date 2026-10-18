import UIKit
import SwiftUI

// Depends on the owner's NativeDocumentTabCoordinator/NativeDocumentTabs and
// d809's 5742f382+a02b7397 container seams (imported as150ad6dd+99be269a).
// This factory owns presentation reservations, never catalog or navigation.
@MainActor
final class NativeTabDestinationFactory {
    typealias Prepared = NativeDocumentTabCoordinator.PreparedDestination
    typealias NewNoteRecovery = (@escaping (Result<Void, Error>) -> Void) -> Void
    private enum Failure: LocalizedError {
        case busy, stale, unavailable, changed, newNotePending
        var errorDescription: String? {
            switch self {
            case .busy: return "Close the pending document session before opening another tab."
            case .stale: return "This document reservation is no longer current."
            case .changed: return "The selected file is unavailable or belongs to a different vault."
            case .unavailable: return "The document session could not be prepared safely."
            case .newNotePending: return "Resume the retained new-note request from Home before opening another document."
            }
        }
    }
    private final class Reservation {
        let ownerID: UUID
        let tab: NativeDocumentTab
        var session: NativeMobileSession?
        var controller: UIViewController?
        var opening = false, closing = false, cleanupRequested = false, installed = false
        var pendingValidation: NativeTabDocument?
        var newNoteInspection: NativeNewNoteRequest?
        var newNoteRecoveryRequired = false
        var preparation: ((Result<Prepared, Error>) -> Void)?
        var recovery: [(Result<Void, Error>) -> Void] = []
        init(tab: NativeDocumentTab, ownerID: UUID, completion: @escaping (Result<Prepared, Error>) -> Void) {
            self.tab = tab; self.ownerID = ownerID; preparation = completion
        }
    }
    private let resolveVault: (UUID) throws -> (LocalVault, URL)
    // Root attests that ALL prior Pages/editor reservations actually drained.
    // This is not a Rust lease; it must not become true merely on UI dismissal.
    private let admissionReady: () -> Bool
    private let chooseFile: (UUID) -> Void
    private let validatedDocument: (NativeTabDocument, UUID) -> Void
    // Root owns routing; the container owns toolbar items and visibility gates.
    // These callbacks never authorize preloading or a second host.
    private let showTabs: ((UIViewController) -> Void)?
    private let returnToNativePages: ((UIViewController) -> Void)?
    private let navigate: ((NativeEditorContainer, UUID, Int) -> Void)?
    // Root presents an explicit Resume action. Inspection never authorizes a
    // create or a handoff. The supplied exact-reservation cleanup is retryable;
    // root may route to Pages only after its success/actual host-close ACK.
    private let pendingNewNote: ((@escaping NewNoteRecovery) -> Void)?
    private var reservation: Reservation?
    private var retiredOwners: [UUID] = [] // Idempotent cleanup ACKs, bounded RAM only.

    // A scope change may discard only an empty factory or its settled,
    // host-free Home reservation. This never substitutes for a close ACK.
    var canRetireVaultContext: Bool {
        guard let current = reservation else { return true }
        return current.tab.isHome && current.session == nil && !current.opening && !current.closing
            && !current.cleanupRequested && current.preparation == nil && current.recovery.isEmpty
    }

    // Root retains the factory; injected callbacks must capture root weakly.
    init(resolveVault: @escaping (UUID) throws -> (LocalVault, URL),
         admissionReady: @escaping () -> Bool,
         chooseFile: @escaping (UUID) -> Void,
         validatedDocument: @escaping (NativeTabDocument, UUID) -> Void,
         showTabs: ((UIViewController) -> Void)? = nil,
         returnToNativePages: ((UIViewController) -> Void)? = nil,
         navigate: ((NativeEditorContainer, UUID, Int) -> Void)? = nil,
         pendingNewNote: ((@escaping NewNoteRecovery) -> Void)? = nil) {
        self.resolveVault = resolveVault; self.admissionReady = admissionReady
        self.chooseFile = chooseFile; self.validatedDocument = validatedDocument
        self.showTabs = showTabs; self.returnToNativePages = returnToNativePages
        self.navigate = navigate
        self.pendingNewNote = pendingNewNote
    }

    // Adapter for Activation: { [weak factory] tab, owner, done in
    //     factory?.prepare(tab, ownerID: owner, completion: done) }
    // Caller must retain factory through all callbacks; a missing adapter must
    // report a pre-open failure rather than silently dropping completion.
    func prepare(_ tab: NativeDocumentTab, ownerID: UUID,
                 completion: @escaping (Result<Prepared, Error>) -> Void) {
        guard admissionReady(), !retiredOwners.contains(ownerID) else { completion(.failure(Failure.busy)); return }
        if let old = reservation {
            // Home has no host or editor admission to drain. Retiring this exact
            // host-free reservation invalidates its old Choose file button.
            guard old.tab.isHome, old.session == nil, !old.opening, !old.closing,
                  old.preparation == nil, old.recovery.isEmpty else { completion(.failure(Failure.busy)); return }
            retire(old)
        }
        let current = Reservation(tab: tab, ownerID: ownerID, completion: completion)
        reservation = current
        guard let document = tab.document else {
            let home = NativeVaultHomeOpeningController { [weak self, weak current] in
                guard let self = self, let current = current, self.reservation === current,
                      current.tab.isHome, current.session == nil else { return }
                self.chooseFile(current.tab.id)
            }
            current.controller = home
            if showTabs != nil {
                let owner = current.ownerID, tabID = current.tab.id
                home.onShowTabs = { [weak self, weak current] controller in
                    guard let self = self, let current = current, self.reservation === current,
                          current.ownerID == owner, current.tab.id == tabID, current.controller === controller,
                          current.tab.isHome, current.session == nil, !current.opening,
                          !current.closing, !current.cleanupRequested else { return }
                    self.showTabs?(controller)
                }
            }
            deliver(current, .success(Prepared(controller: home, source: nil)))
            return
        }
        do {
            let (vault, root) = try resolveVault(document.vaultID)
            guard vault.id == document.vaultID, root.isFileURL, root.path.hasPrefix("/"), !root.path.utf8.contains(0),
                  NativeFileEntry.isValidEntryId(document.localStoreID),
                  NativeFileEntry.isValidEntryId(document.stableFileID) else { throw Failure.changed }
            current.opening = true
            NativeMobileSession.open(vault: vault, root: root) { [self, current] result in
                current.opening = false
                // Reservation cannot be replaced while open/close is pending.
                guard reservation === current else { return } // Defensive invariant, never grants admission.
                switch result {
                case .failure(let error):
                    // NativeMobileSession.open closes any partially opened host
                    // before reporting failure. No raw handle escaped its queue.
                    failAfterCleanup(current, error: error)
                case .success(let session):
                    current.session = session
                    if current.cleanupRequested { cleanup(current); return }
                    session.pageListing { [self, current, session] result in
                        guard reservation === current, current.session === session else { return }
                        if current.cleanupRequested { cleanup(current); return }
                        do {
                            let listing = try result.get()
                            // A global incomplete-reconciliation warning is not
                            // proof that this freshly listed committed file is
                            // absent. Preserve the session warning unchanged;
                            // require this exact store and live stable identity.
                            guard listing.localStoreId == document.localStoreID else { throw Failure.changed }
                            inspectNewNote(current, session: session, store: listing.localStoreId) { [self, current, session] in
                                guard reservation === current, current.session === session else { return }
                                if current.cleanupRequested { cleanup(current); return }
                                let matches = listing.entries.filter { $0.id == document.stableFileID }
                                guard matches.count == 1, let entry = matches.first, !entry.deleted, entry.kind == .file,
                                      NativeFileEntry.isVisiblePath(entry.path) else {
                                    failAfterCleanup(current, error: Failure.changed); return
                                }
                                installContainer(current, session: session, entry: entry, document: document)
                            }
                        } catch { failAfterCleanup(current, error: error) }
                    }
                }
            }
        } catch { failAfterCleanup(current, error: error) }
    }

    private func inspectNewNote(_ current: Reservation, session: NativeMobileSession,
                                store: String, clear: @escaping () -> Void) {
        guard reservation === current, current.session === session else { return }
        let binding = NativeExclusiveSessionBinding(session: session, localStoreId: store,
            folderId: nil, folderPath: "", finish: { _ in })
        let helper = NativeNewNoteRequest(binding: binding)
        current.newNoteInspection = helper
        current.opening = true // Cleanup must wait for the inspection's exact loan result.
        helper.execute(.inspectPending) { [self, current, session, helper] result in
            guard reservation === current, current.session === session,
                  current.newNoteInspection === helper else { return }
            current.opening = false
            switch result {
            case .success(.clear), .success(.rejected):
                // Both outcomes include the helper's exact release ACK.
                current.newNoteInspection = nil
                clear()
            case .success(.pending), .success(.ready), .failure:
                // A pending read can still hold its admission. Never report a
                // preparation failure (whose contract promises closed hosts)
                // or discard the helper while that ownership is unresolved.
                current.newNoteRecoveryRequired = true
                if current.cleanupRequested { cleanup(current); return }
                pendingNewNote?({ [weak self, weak current] done in
                    guard let self = self, let current = current else { done(.failure(Failure.stale)); return }
                    self.recoverNewNote(current, completion: done)
                })
            }
        }
    }

    private func recoverNewNote(_ current: Reservation,
                                completion: @escaping (Result<Void, Error>) -> Void) {
        guard reservation === current, current.newNoteRecoveryRequired,
              !current.opening, !current.closing else { completion(.failure(Failure.busy)); return }
        current.closing = true
        let close: () -> Void = { [self, current] in
            let closed: () -> Void = { [self, current] in
                guard reservation === current else { completion(.failure(Failure.stale)); return }
                current.closing = false
                current.newNoteInspection = nil
                retire(current)
                deliver(current, .failure(Failure.newNotePending))
                settleRecovery(current, .success(()))
                completion(.success(()))
            }
            if let session = current.session { session.close(completion: closed) } else { closed() }
        }
        if let helper = current.newNoteInspection, helper.retainsReservation {
            helper.closeRetainedReservation { [self, current] result in
                guard reservation === current else { completion(.failure(Failure.stale)); return }
                switch result {
                case .success: close()
                case .failure(let error):
                    // Keep the same helper, session and reservation for retry.
                    current.closing = false
                    settleRecovery(current, .failure(error))
                    completion(.failure(error))
                }
            }
        } else { close() }
    }

    private func installContainer(_ current: Reservation, session: NativeMobileSession,
                                  entry: NativeFileEntry, document: NativeTabDocument) {
        // Construct only; do NOT touch .view, present, push or set a UIKit stack.
        let container = NativeEditorContainer(session: session, launch: .entry(entry), originTitle: "Files")
        current.controller = container
        let owner = current.ownerID
        let identity: () -> Bool = { [weak self, weak current, weak container, weak session] in
            guard let self = self, let current = current, let container = container, let session = session else { return false }
            return self.reservation === current && current.ownerID == owner
                && current.controller === container && current.session === session
        }
        // Identity is deliberately independent of foreground, stack or visibility:
        // the container applies those checks to close/capture/validation itself.
        container.configureDocumentTabOwner(sourceOwnerID: owner, isCurrent: identity)
        if showTabs != nil {
            container.onShowDocumentTabs = { [weak self, weak current, weak container, weak session] in
                guard let self = self, let current = current, let container = container, let session = session,
                      self.reservation === current, current.ownerID == owner, current.installed,
                      current.controller === container, current.session === session,
                      !current.closing, !current.cleanupRequested else { return }
                self.showTabs?(container)
            }
        }
        if returnToNativePages != nil {
            container.onReturnToNativePages = { [weak self, weak current, weak container, weak session] in
                guard let self = self, let current = current, let container = container, let session = session,
                      self.reservation === current, current.ownerID == owner, current.installed,
                      current.controller === container, current.session === session,
                      !current.closing, !current.cleanupRequested else { return }
                self.returnToNativePages?(container)
            }
        }
        if navigate != nil {
            container.onNavigate = { [weak self, weak current, weak container, weak session] direction in
                guard let self = self, let current = current, let container = container, let session = session,
                      direction == -1 || direction == 1,
                      self.reservation === current, current.ownerID == owner, current.installed,
                      current.controller === container, current.session === session,
                      !current.closing, !current.cleanupRequested,
                      UIApplication.shared.applicationState == .active,
                      container.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
                      let nav = container.navigationController, nav.topViewController === container,
                      nav.transitionCoordinator == nil, container.presentedViewController == nil,
                      nav.presentedViewController == nil else { return }
                self.navigate?(container, owner, direction)
            }
        }
        container.onDocumentValidated = { [weak self, weak current, weak container, weak session] validated in
            guard let self = self, let current = current, let container = container, let session = session,
                  self.reservation === current, current.ownerID == owner,
                  current.controller === container, current.session === session, !current.closing,
                  !current.cleanupRequested, validated.vaultID == session.vault.id,
                  validated.localStoreID == document.localStoreID else { return }
            // Native container already validated the actual stable ID via Rust.
            // This can bind a subsequently followed link into the SAME live tab.
            current.pendingValidation = validated
            self.flushValidation(current)
        }
        let source = NativeDocumentTabCoordinator.Source(role: .editor, ownerID: owner, tabID: current.tab.id,
            resolvedDocument: document, controller: container, isCurrent: identity,
            close: { [weak self, weak current] requestedOwner, done in
                guard let self = self, let current = current, requestedOwner == owner,
                      self.reservation === current else { done(.failure(Failure.stale)); return }
                self.closeContainer(current, completion: done)
            }, resume: {}, // Negative lifecycle ACK restores this same editor internally.
            hasTerminalRetirementReceipt: { [weak container] in
                container?.documentTabRetirementReceipt(sourceOwnerID: owner) != nil
            }, capture: { [weak container] done in
                guard let container = container else { done(nil); return }
                container.captureDocumentTabSnapshot(sourceOwnerID: owner, maximumPixelDimension: 1024, completion: done)
            })
        deliver(current, .success(Prepared(controller: container, source: source)))
    }

    // Root calls AFTER registering Source and installing this exact controller.
    // A witness arriving during deferred installation is held, never lost or
    // used to repair metadata by reopening the editor.
    @discardableResult
    func didInstall(ownerID: UUID, tabID: UUID, controller: UIViewController) -> Bool {
        guard let current = reservation, current.ownerID == ownerID, current.tab.id == tabID,
              current.controller === controller, current.session != nil, !current.closing,
              !current.cleanupRequested, let navigation = controller.navigationController,
              navigation.viewControllers.contains(where: { $0 === controller }) else { return false }
        current.installed = true
        flushValidation(current)
        return true
    }
    private func flushValidation(_ current: Reservation) {
        guard reservation === current, current.installed, !current.closing, !current.cleanupRequested,
              let document = current.pendingValidation else { return }
        current.pendingValidation = nil
        validatedDocument(document, current.ownerID)
    }

    // Explicit cleanup of EXACT reservation; never a new open or navigation.
    func recoverReservation(_ ownerID: UUID, completion: @escaping (Result<Void, Error>) -> Void) {
        guard let current = reservation else {
            completion(retiredOwners.contains(ownerID) ? .success(()) : .failure(Failure.stale)); return
        }
        guard current.ownerID == ownerID else { completion(.failure(Failure.stale)); return }
        if let container = current.controller as? NativeEditorContainer,
           current.installed || container.parent != nil {
            // Recovery is not authority to close an installed healthy source.
            // Its registered Source.close owns save/quiesce. A retained exact
            // terminal receipt can still settle this reservation idempotently.
            guard container.documentTabRetirementReceipt(sourceOwnerID: ownerID) != nil else {
                completion(.failure(Failure.busy)); return
            }
            retire(current); completion(.success(())); return
        }
        current.recovery.append(completion)
        current.cleanupRequested = true
        if !current.opening { cleanup(current) }
    }
    private func cleanup(_ current: Reservation) {
        guard reservation === current, !current.opening, !current.closing else { return }
        if current.newNoteRecoveryRequired {
            recoverNewNote(current) { _ in }
            return
        }
        if let container = current.controller as? NativeEditorContainer, container.isViewLoaded {
            closeContainer(current) { [self, current] result in
                if case .success = result { deliver(current, .failure(Failure.stale)) }
            }
        } else {
            // No web view has ever been loaded, so there is no editor consumer
            // to quiesce. Still wait for this exact host's actual close ACK.
            current.closing = true
            let closed: () -> Void = { [self, current] in
                current.closing = false
                retire(current)
                deliver(current, .failure(Failure.stale))
                let callbacks = current.recovery; current.recovery = []
                callbacks.forEach { $0(.success(())) }
            }
            if let session = current.session { session.close(completion: closed) } else { closed() }
        }
    }
    private func closeContainer(_ current: Reservation, completion: @escaping (Result<Void, Error>) -> Void) {
        guard reservation === current, !current.closing,
              let container = current.controller as? NativeEditorContainer else { completion(.failure(Failure.busy)); return }
        if container.documentTabRetirementReceipt(sourceOwnerID: current.ownerID) != nil {
            retire(current); settleRecovery(current, .success(())); completion(.success(())); return
        }
        current.closing = true
        // Capture reservation strongly until the actual container close callback.
        // Do not retire it from onClosed or revoke its identity during cleanup.
        container.closeForDocumentTabTransition(sourceOwnerID: current.ownerID) { [self, current, container] result in
            guard reservation === current else { return }
            current.closing = false
            if container.documentTabRetirementReceipt(sourceOwnerID: current.ownerID) != nil {
                retire(current)
            } else if case .success = result {
                // An unproved success is not permission to open another host.
                settleRecovery(current, .failure(Failure.unavailable))
                completion(.failure(Failure.unavailable)); return
            }
            // A recovery arriving during an ordinary source close joins the
            // same ACK. A terminal receipt is cleanup success even when stale
            // foreground state makes the original navigation result failure.
            settleRecovery(current, reservation === current ? result : .success(()))
            completion(result)
        }
    }
    private func failAfterCleanup(_ current: Reservation, error: Error) {
        guard reservation === current else { return }
        // Preparation has not exposed/loaded an editor container at this point.
        current.closing = true
        let closed: () -> Void = { [self, current] in
            current.closing = false; retire(current); deliver(current, .failure(error))
            let callbacks = current.recovery; current.recovery = []
            callbacks.forEach { $0(.success(())) }
        }
        if let session = current.session { session.close(completion: closed) } else { closed() }
    }
    private func settleRecovery(_ current: Reservation, _ result: Result<Void, Error>) {
        let callbacks = current.recovery; current.recovery = []
        callbacks.forEach { $0(result) }
    }
    private func deliver(_ current: Reservation, _ result: Result<Prepared, Error>) {
        let completion = current.preparation; current.preparation = nil; completion?(result)
    }
    private func retire(_ current: Reservation) {
        guard reservation === current else { return }
        retiredOwners.append(current.ownerID)
        if retiredOwners.count > 32 { retiredOwners.removeFirst(retiredOwners.count - 32) }
        reservation = nil
    }
}

@MainActor
private final class NativeVaultHomeOpeningController: UIViewController {
    var onShowTabs: ((NativeVaultHomeOpeningController) -> Void)?
    private let chooseFile: () -> Void
    init(chooseFile: @escaping () -> Void) { self.chooseFile = chooseFile; super.init(nibName: nil, bundle: nil); title = "Home" }
    required init?(coder: NSCoder) { fatalError("Use the native tab destination factory.") }
    private var requestedHome = false
    private var waitingForTransition = false
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if onShowTabs != nil {
            let tabs = UIBarButtonItem(image: UIImage(systemName: "square.on.square"), style: .plain,
                                       target: self, action: #selector(showDocumentTabs))
            tabs.accessibilityIdentifier = "native.tabs.home.show-tabs"
            tabs.accessibilityLabel = "Show tabs"
            navigationItem.rightBarButtonItem = tabs
        }
        // Home is the current vault's native landing page. This host-free
        // transition displays shapes while root opens that SAME vault; it never
        // asks the user to choose a file or selects a different vault.
        let loading = UIHostingController(rootView: NativeLoadingSkeleton(editor: false).padding(20))
        addChild(loading); view.addSubview(loading.view)
        loading.view.backgroundColor = .systemBackground
        loading.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            loading.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            loading.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            loading.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        loading.didMove(toParent: self)
        for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.scheduleHome()
            })
        }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        scheduleHome()
    }
    private func scheduleHome() {
        DispatchQueue.main.async { [weak self] in self?.openHomeWhenCurrent() }
    }
    private func openHomeWhenCurrent() {
        guard !requestedHome, UIApplication.shared.applicationState == .active,
              viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
              let navigation = navigationController, navigation.topViewController === self,
              !isBeingDismissed, !isMovingFromParent, !navigation.isBeingDismissed,
              navigation.presentedViewController == nil, presentedViewController == nil else { return }
        if let transition = navigation.transitionCoordinator {
            guard !waitingForTransition else { return }
            waitingForTransition = true
            transition.animate(alongsideTransition: nil) { [weak self] _ in
                self?.waitingForTransition = false
                self?.scheduleHome()
            }
            return
        }
        requestedHome = true
        chooseFile() // Existing root coordinator owns admission/save/close/error recovery.
    }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
    @objc private func showDocumentTabs() {
        guard UIApplication.shared.applicationState == .active,
              viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
              let navigation = navigationController, navigation.topViewController === self,
              navigation.transitionCoordinator == nil, !isBeingDismissed, !isMovingFromParent,
              !navigation.isBeingDismissed, navigation.presentedViewController == nil,
              presentedViewController == nil else { return }
        onShowTabs?(self)
    }
}
