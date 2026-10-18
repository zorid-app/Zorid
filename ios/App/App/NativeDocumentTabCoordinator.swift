import SwiftUI
import UIKit

// Scene-owned presentation coordinator. Storage and editor ownership are supplied
// by native adapters; tab metadata and snapshots never authorize a Rust lease.
@MainActor
final class NativeDocumentTabCoordinator: ObservableObject {
    enum SourceRole { case pages, editor }
    struct Source {
        let role: SourceRole
        let ownerID: UUID
        let tabID: UUID
        let resolvedDocument: NativeTabDocument?
        let controller: UIViewController
        let isCurrent: () -> Bool
        // Success means actual save/quiesce and host close completed. On failure
        // the adapter retains its host and must support an explicit retry.
        let close: (UUID, @escaping (Result<Void, Error>) -> Void) -> Void
        let resume: () -> Void
        // Adapter checks its bound container/session and exact sourceOwnerID.
        var hasTerminalRetirementReceipt: () -> Bool = { false }
        var capture: ((@escaping (UIImage?) -> Void) -> Void)? = nil
    }
    // The adapter prepares a controller and its one host, but MUST NOT mutate
    // navigation. Only this coordinator installs it after foreground validation.
    struct PreparedDestination {
        let controller: UIViewController
        let source: Source?
    }
    typealias Activation = (NativeDocumentTab, UUID, @escaping (Result<PreparedDestination, Error>) -> Void) -> Void

    let model: NativeDocumentTabs
    let snapshots = NativeTabSnapshotCache()
    @Published private(set) var isBusy = false
    @Published private(set) var message: String?
    @Published private(set) var canResume = false
    @Published private(set) var canRetry = false
    private var admissionQuarantined = false
    private var metadataPending = false
    private var persistenceRetry: (() -> Void)?
    private var persistenceMessage: String?
    private var postCleanupIntent: NativeDocumentTabs.Intent?
    private var source: Source?
    private var ownerID = UUID()
    private var transitionID: UUID?
    private var foregroundEpoch = UUID()
    private var activationPending = false
    private var nativeRouteTicket: UUID?
    private var vaultOpeningTicket: UUID?
    private var nativeRecovery: (id: UUID, owner: UUID?, routes: [ObjectIdentifier])?
    private var pendingNativeRouteRetry: (() -> Void)?
    private struct PendingBinding {
        let document: NativeTabDocument
        let owner: UUID
        let tab: NativeDocumentTab
    }
    private var pendingBinding: PendingBinding?
    private var retryAction: (() -> Void)?
    private weak var navigation: UINavigationController?
    private weak var overview: UIViewController?
    private weak var openingRoute: UIViewController?
    private let activate: Activation
    private let persist: (Data) throws -> Void
    private let didInstall: (UUID, UUID, UIViewController) -> Bool
    private let recoverActivation: (UUID, @escaping (Result<Void, Error>) -> Void) -> Void
    private var observers: [NSObjectProtocol] = []

    // Factory admission is expected while the coordinator is busy preparing one
    // destination. It is not a client lease and never permits a parallel host.
    var canEnterVault: Bool {
        source == nil && !isBusy && !activationPending && nativeRouteTicket == nil && vaultOpeningTicket == nil && pendingBinding == nil && nativeRecovery == nil && !admissionQuarantined && !metadataPending
    }

    var canPrepareDestination: Bool {
        activationPending && source == nil && !admissionQuarantined && !metadataPending
    }

    func beginVaultOpening(_ ticket: UUID) throws {
        guard canEnterVault else { throw NativeDocumentTabsError.busy }
        vaultOpeningTicket = ticket
    }
    func finishVaultOpening(_ ticket: UUID) {
        if vaultOpeningTicket == ticket { vaultOpeningTicket = nil }
    }

    init(model: NativeDocumentTabs, persist: @escaping (Data) throws -> Void,
         activate: @escaping Activation,
         didInstall: @escaping (UUID, UUID, UIViewController) -> Bool,
         recoverActivation: @escaping (UUID, @escaping (Result<Void, Error>) -> Void) -> Void) {
        self.model = model; self.persist = persist; self.activate = activate
        self.recoverActivation = recoverActivation; self.didInstall = didInstall
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, UIApplication.didReceiveMemoryWarningNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                // Notification is delivered on main, like all coordinator entry points.
                MainActor.assumeIsolated {
                    self?.snapshots.removeAll()
                    if name != UIApplication.didReceiveMemoryWarningNotification { self?.foregroundEpoch = UUID() }
                }
            })
        }
        for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated {
                    guard let self = self else { return }
                    if let scene = notification.object as? UIWindowScene,
                       self.navigation?.viewIfLoaded?.window?.windowScene !== scene { return }
                    DispatchQueue.main.async { [weak self] in self?.presentNativeRecovery() }
                }
            })
        }
    }

    // An already-open pages/editor adapter must register BEFORE it exposes any
    // action that could open another host. Replacing a live source is forbidden.
    func bindSource(_ newSource: Source) throws {
        guard source == nil, !isBusy, !activationPending, !admissionQuarantined,
              newSource.tabID == model.selectedTabID, newSource.isCurrent() else {
            throw NativeDocumentTabsError.busy
        }
        source = newSource; ownerID = newSource.ownerID
        navigation = newSource.controller.navigationController ?? navigation
        captureCurrentPreview()
    }

    func showDocumentTabs(from presenter: UIViewController) {
        guard overview == nil, !isBusy, nativeRouteTicket == nil, vaultOpeningTicket == nil, let nav = presenter.navigationController,
              nav.topViewController === presenter,
              source == nil || source?.controller === presenter || openingRoute === presenter else { return }
        navigation = nav
        let host = NativeDocumentTabOverviewController(rootView: NativeCoordinatedTabOverview(coordinator: self))
        overview = host
        // Push before starting any asynchronous save/close work.
        nav.pushViewController(host, animated: !UIAccessibility.isReduceMotionEnabled)
        // A quarantined installed host needs its reservation-bound recovery;
        // ordinary drain must not discard that path or leave quarantine stuck.
        if pendingBinding != nil { publishBindingRecovery() }
        else if !admissionQuarantined { drainSource() }
    }

    func performDocumentTabIntent(_ intent: NativeDocumentTabs.Intent) {
        guard !isBusy, !activationPending, nativeRouteTicket == nil, vaultOpeningTicket == nil, nativeRecovery == nil, pendingBinding == nil, !admissionQuarantined, !metadataPending,
              UIApplication.shared.applicationState == .active else { return }
        navigation = source?.controller.navigationController ?? navigation
        message = nil; retryAction = nil; canRetry = false
        let epoch = foregroundEpoch
        postCleanupIntent = nil; pendingNativeRouteRetry = nil
        do {
            let ticket = try model.prepare(intent, sourceOwnerID: ownerID)
            if overview == nil, !showOpeningRoute(title: ticket.destinationTab.displayTitle) {
                try model.cancel(ticket)
                message = "Navigation is still settling. Try opening the file again."
                return
            }
            drainSource { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .failure(let error):
                    try? self.model.cancel(ticket)
                    self.postCleanupIntent = intent
                    // A stale-source close may have installed a required exact
                    // cleanup action. Never replace it with another open attempt.
                    if self.source == nil { self.publishRetiredRecovery() }
                    else if self.retryAction == nil {
                        self.message = error.localizedDescription
                        self.retryAction = { [weak self] in self?.drainSource(allowOwnershipRecovery: true) }
                        self.canRetry = true
                    }
                case .success:
                    guard self.foregroundEpoch == epoch, UIApplication.shared.applicationState == .active else {
                        try? self.model.cancel(ticket)
                        self.message = "Tab change paused. Try again when you return to the app."
                        self.retryAction = { [weak self] in self?.performDocumentTabIntent(intent) }; self.canRetry = true
                        return
                    }
                    do {
                        // drainSource retired the host. The ticket still binds
                        // its original owner; no new host has been admitted.
                        try self.model.commit(ticket, acknowledgement: .noActiveEditor(sourceOwnerID: ticket.sourceOwnerID))
                        self.snapshots.retainSnapshots(for: self.model.tabs)
                        let afterSaving: () -> Void = { [weak self] in
                            if case .close = intent { return }
                            self?.activateSelected()
                        }
                        do { try self.persist(self.model.encodedMetadata()); afterSaving() }
                        catch { self.metadataSaveFailed(error, afterSaving: afterSaving) }
                    } catch { self.message = error.localizedDescription }
                }
            }
        } catch { message = error.localizedDescription }
    }

    // Settings, native Return, and Home's Choose file all share the same host
    // retirement gate. Their caller may route only after this foreground receipt.
    func performNativeRoute(from presenter: UIViewController,
                            retry: (() -> Void)? = nil,
                            completion: @escaping (Result<Void, Error>) -> Void) {
        if nativeRecovery != nil {
            presentNativeRecovery()
            completion(.failure(NativeDocumentTabsError.busy)); return
        }
        if pendingBinding != nil || metadataPending {
            showDocumentTabs(from: presenter)
            completion(.failure(NativeDocumentTabsError.busy)); return
        }
        guard !isBusy, !activationPending, nativeRouteTicket == nil, vaultOpeningTicket == nil,
              pendingBinding == nil, !admissionQuarantined, !metadataPending,
              UIApplication.shared.applicationState == .active,
              let nav = presenter.navigationController, nav.topViewController === presenter else {
            completion(.failure(NativeDocumentTabsError.busy)); return
        }
        navigation = nav
        let epoch = foregroundEpoch, ticket = UUID()
        pendingNativeRouteRetry = retry
        let recoveryRoutes = nav.viewControllers
        nativeRouteTicket = ticket
        drainSource { [weak self, weak presenter, weak nav] result in
            guard let self = self, self.nativeRouteTicket == ticket else { return }
            guard case .success = result else {
                self.nativeRouteTicket = nil
                if let source = self.source, source.isCurrent() {
                    source.resume() // Restore a failed Pages source before alerting.
                    if UIApplication.shared.applicationState == .active {
                        self.showNativeRouteFailure(from: presenter)
                    }
                } else {
                    self.queueNativeRecovery(routes: recoveryRoutes)
                }
                completion(result); return
            }
            self.isBusy = true // Keep admission reserved through UIKit completion.
            guard let presenter = presenter, let nav = nav else {
                self.nativeRouteTicket = nil; self.isBusy = false
                self.queueNativeRecovery(routes: recoveryRoutes)
                completion(.failure(NativeDocumentTabsError.staleTicket)); return
            }
            self.afterNavigationTransition(nav) { [weak self, weak nav, weak presenter] in
                guard let self = self, self.nativeRouteTicket == ticket else { return }
                guard let nav = nav, let presenter = presenter,
                      self.foregroundEpoch == epoch, UIApplication.shared.applicationState == .active,
                      nav.topViewController === presenter, self.source == nil,
                      !self.activationPending, !self.admissionQuarantined else {
                    self.nativeRouteTicket = nil; self.isBusy = false
                    self.queueNativeRecovery(routes: recoveryRoutes)
                    completion(.failure(NativeDocumentTabsError.staleTicket)); return
                }
                self.openingRoute = nil; self.overview = nil
                // This synchronous callback consumes the receipt; a caller cannot
                // yield and later use it to compete with another activation.
                self.nativeRouteTicket = nil; self.isBusy = false
                self.pendingNativeRouteRetry = nil
                completion(.success(()))
            }
        }
    }

    private func showNativeRouteFailure(from presenter: UIViewController?) {
        guard let presenter = presenter, navigation?.topViewController === presenter,
              presenter.presentedViewController == nil, UIApplication.shared.applicationState == .active else { return }
        let alert = UIAlertController(title: "Could not change page",
            message: "Your current page remains available. Try again when saving is ready.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func queueNativeRecovery(routes: [UIViewController]) {
        nativeRecovery = (UUID(), source?.ownerID, routes.map(ObjectIdentifier.init))
        if message == nil { message = "The page change paused. Choose how to continue." }
        presentNativeRecovery()
    }

    private func presentNativeRecovery() {
        guard let pending = nativeRecovery, let nav = navigation,
              UIApplication.shared.applicationState == .active,
              nav.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
              !isBusy, !activationPending, nativeRouteTicket == nil, vaultOpeningTicket == nil,
              source?.ownerID == pending.owner,
              nav.topViewController.map { pending.routes.contains(ObjectIdentifier($0)) } == true else { return }
        afterNavigationTransition(nav) { [weak self, weak nav] in
            guard let self = self, let nav = nav, self.nativeRecovery?.id == pending.id,
                  self.source?.ownerID == pending.owner,
                  UIApplication.shared.applicationState == .active,
                  nav.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
                  !self.isBusy, !self.activationPending, self.nativeRouteTicket == nil,
                  self.vaultOpeningTicket == nil,
                  nav.topViewController.map { pending.routes.contains(ObjectIdentifier($0)) } == true else { return }
            if self.showOpeningRoute(title: "Session recovery") {
                self.nativeRecovery = nil
                if self.source == nil { self.publishRetiredRecovery() }
            }
        }
    }

    @discardableResult
    private func showOpeningRoute(title: String) -> Bool {
        guard let nav = navigation else { return false }
        if let opening = openingRoute, nav.topViewController === opening {
            opening.title = title; return true
        }
        guard nav.transitionCoordinator == nil else { return false }
        let controller = NativeDocumentTabOpeningController(coordinator: self)
        controller.title = title
        openingRoute = controller
        nav.pushViewController(controller, animated: !UIAccessibility.isReduceMotionEnabled)
        return true
    }

    func finishDocumentTabOverview() {
        guard !isBusy, source == nil, !activationPending, nativeRouteTicket == nil, vaultOpeningTicket == nil, nativeRecovery == nil, pendingBinding == nil, !admissionQuarantined, !metadataPending,
              UIApplication.shared.applicationState == .active else { return }
        activateSelected()
    }

    func retryTransition() {
        guard !isBusy else { return }
        guard canRetry else { return }
        retryAction?()
    }

    func resumeSource() {
        guard !isBusy, UIApplication.shared.applicationState == .active, canResume, let source = source, source.isCurrent(),
              let nav = navigation, nav.viewControllers.contains(where: { $0 === source.controller }) else { return }
        afterNavigationTransition(nav) { [weak self, weak nav] in
            guard let self = self, let nav = nav, !self.isBusy,
                  self.source?.ownerID == source.ownerID, source.isCurrent(),
                  UIApplication.shared.applicationState == .active else { return }
            self.retryAction = nil; self.message = nil; self.canResume = false; self.canRetry = false
            nav.popToViewController(source.controller, animated: !UIAccessibility.isReduceMotionEnabled)
            self.overview = nil
            source.resume()
        }
    }

    // Called synchronously after the active container's CURRENT validation
    // callback. Metadata failure retains the live editor; retry never creates
    // another note or navigates the shared editor.
    func bindValidatedDocument(_ document: NativeTabDocument, sourceOwnerID: UUID) throws {
        guard !isBusy, UIApplication.shared.applicationState == .active, let source = source,
              source.role == .editor, source.ownerID == sourceOwnerID, ownerID == sourceOwnerID,
              source.tabID == model.selectedTabID, source.isCurrent() else { return } // Stale event.
        let retained = PendingBinding(document: document, owner: sourceOwnerID, tab: model.selectedTab)
        pendingBinding = retained
        try applyPendingBinding(retained)
    }

    private func applyPendingBinding(_ binding: PendingBinding) throws {
        guard let source = source, source.role == .editor, source.ownerID == binding.owner,
              ownerID == binding.owner, source.tabID == binding.tab.id,
              source.isCurrent(), model.selectedTab == binding.tab,
              UIApplication.shared.applicationState == .active else {
            throw NativeDocumentTabsError.staleTicket
        }
        do {
            let ticket = try model.prepareActiveDocumentBinding(tabID: binding.tab.id, sourceOwnerID: binding.owner)
            try model.bindActiveDocument(binding.document, using: ticket, currentOwnerID: binding.owner)
            pendingBinding = nil
            snapshots.retainSnapshots(for: model.tabs)
            captureCurrentPreview()
        } catch {
            publishBindingRecovery()
            throw error
        }
        do { try persist(model.encodedMetadata()) }
        catch { metadataSaveFailed(error); throw error }
    }

    private func publishBindingRecovery() {
        guard pendingBinding != nil else { return }
        message = "The open document’s tab information needs to be updated. Retry before changing tabs."
        canRetry = true; canResume = source?.isCurrent() == true
        retryAction = { [weak self] in
            guard let self = self, let pending = self.pendingBinding else { return }
            do {
                try self.applyPendingBinding(pending)
                if !self.metadataPending { self.message = nil; self.retryAction = nil; self.canRetry = false }
            } catch { /* Preserve the exact document and executable metadata retry. */ }
        }
    }

    func captureCurrentPreview() {
        guard !isBusy, let source = source, source.isCurrent(),
              source.tabID == model.selectedTabID, !model.selectedTab.isHome,
              UIApplication.shared.applicationState == .active, let capture = source.capture else { return }
        let tab = model.selectedTab
        let epoch = foregroundEpoch
        capture { [weak self] image in
            guard let self = self, let image = image, self.source?.ownerID == source.ownerID,
                  self.model.selectedTab == tab, self.foregroundEpoch == epoch, source.isCurrent(),
                  UIApplication.shared.applicationState == .active else { return }
            self.snapshots.insert(image, for: tab)
        }
    }

    private func drainSource(allowOwnershipRecovery: Bool = false, completion: ((Result<Void, Error>) -> Void)? = nil) {
        guard !isBusy, !activationPending else { return }
        guard let source = source else { publishRetiredRecovery(); canResume = false; completion?(.success(())); return }
        guard source.isCurrent() || allowOwnershipRecovery else {
            message = "The active document changed. Check its session before changing tabs."
            canResume = false
            if source.hasTerminalRetirementReceipt() {
                self.source = nil; ownerID = UUID(); publishRetiredRecovery()
            } else {
                // The bound adapter must verify its exact owner before cleanup;
                // this request never authorizes closing a foreign session.
                retryAction = { [weak self] in self?.drainSource(allowOwnershipRecovery: true) }; canRetry = true
            }
            completion?(.failure(NativeDocumentTabsError.staleTicket))
            return
        }
        let attempt = UUID()
        transitionID = attempt; isBusy = true; message = "Saving your document…"; canResume = false
        source.close(source.ownerID) { [self] result in
            guard self.transitionID == attempt,
                  self.source?.ownerID == source.ownerID else { return }
            self.transitionID = nil; self.isBusy = false
            switch result {
            case .success:
                // Do not ask isCurrent after close: a successful adapter has
                // deliberately retired that source. Exact attempt/owner matches.
                self.source = nil; self.ownerID = UUID()
                if !self.metadataPending { self.message = nil }
                self.publishRetiredRecovery()
                self.canResume = false
                if let nav = self.navigation, let overview = self.overview {
                    // Release closed editor/host containers, retaining the root
                    // picker and the already-visible overview without a pop flash.
                    let retained = nav.viewControllers.filter { $0 !== source.controller }
                    self.afterNavigationTransition(nav) { [weak self, weak nav, weak overview] in
                        guard let self = self, let nav = nav, let overview = overview,
                              self.overview === overview, nav.topViewController === overview,
                              UIApplication.shared.applicationState == .active,
                              retained.contains(where: { $0 === overview }) else { return }
                        nav.setViewControllers(retained, animated: false)
                    }
                }
                completion?(.success(()))
            case .failure(let error):
                self.message = error.localizedDescription
                if source.hasTerminalRetirementReceipt() {
                    // Cleanup fact is separate from foreground navigation. The
                    // exact host is retired, but no target is opened here.
                    self.source = nil; self.ownerID = UUID()
                    self.canResume = false
                    self.publishRetiredRecovery()
                } else {
                    self.canResume = source.isCurrent()
                    self.retryAction = { [weak self] in self?.drainSource() }; self.canRetry = true
                }
                completion?(.failure(error))
            }
        }
    }

    private func metadataSaveFailed(_ error: Error, afterSaving: (() -> Void)? = nil) {
        metadataPending = true
        persistenceMessage = "Tab information could not be saved. \(error.localizedDescription)"
        persistenceRetry = { [weak self] in
            guard let self = self else { return }
            do {
                try self.persist(self.model.encodedMetadata())
                self.metadataPending = false; self.persistenceMessage = nil; self.persistenceRetry = nil
                self.message = nil; self.retryAction = nil; self.canRetry = false
                if let afterSaving = afterSaving { afterSaving() }
                else if self.source == nil && !self.isBusy { self.publishRetiredRecovery() }
            } catch { self.metadataSaveFailed(error, afterSaving: afterSaving) }
        }
        message = persistenceMessage; retryAction = persistenceRetry; canRetry = true
    }

    // Persistence recovery survives transient save/close failures in separate
    // storage. Only a real persistence success clears its error/continuation.
    private func publishRetiredRecovery() {
        guard source == nil else { return }
        if metadataPending {
            message = persistenceMessage; retryAction = persistenceRetry; canRetry = persistenceRetry != nil
        } else if let retryNativeRoute = pendingNativeRouteRetry {
            message = "The previous session is closed. Retry the page change when you are ready."
            retryAction = retryNativeRoute; canRetry = true
        } else if let intent = postCleanupIntent {
            message = "The previous session is closed. Retry opening the selected file."
            retryAction = { [weak self] in self?.performDocumentTabIntent(intent) }; canRetry = true
        } else {
            // A terminal cleanup failure may have deliberately preserved its
            // explanation. Retirement is not permission to erase that error.
            retryAction = nil; canRetry = false
        }
    }

    private func activateSelected() {
        guard !isBusy, source == nil, !activationPending, nativeRouteTicket == nil, vaultOpeningTicket == nil, nativeRecovery == nil, pendingBinding == nil, !admissionQuarantined, !metadataPending,
              UIApplication.shared.applicationState == .active else { return }
        let tab = model.selectedTab
        pendingNativeRouteRetry = nil
        let attempt = UUID(), nextOwner = UUID()
        let epoch = foregroundEpoch
        transitionID = attempt; activationPending = true; isBusy = true
        message = "Opening \(tab.displayTitle)…"; retryAction = nil; canResume = false
        activate(tab, nextOwner) { [self] result in
            // The coordinator is retained by the scene/picker until all native
            // callbacks drain. Never cancel this reservation on a UI dismissal.
            guard self.transitionID == attempt else { return }
            switch result {
            case .success(let destination):
                let newSource = destination.source
                guard self.foregroundEpoch == epoch, UIApplication.shared.applicationState == .active,
                      self.model.selectedTab == tab,
                      self.isValidPreparedDestination(destination, for: tab, owner: nextOwner) else {
                    // Retain any returned host behind an explicit recovery gate;
                    // a malformed adapter result must not permit a second open.
                    self.activationPending = false; self.transitionID = nil; self.isBusy = false
                    self.admissionQuarantined = true
                    self.source = newSource; self.ownerID = nextOwner
                    self.message = "The document changed while opening. Close the pending session before trying again."
                    self.canRetry = true
                    self.retryAction = { [weak self] in self?.recoverQuarantinedActivation(nextOwner) }
                    return
                }
                self.source = newSource; self.ownerID = nextOwner
                guard let nav = self.navigation else {
                    self.activationPending = false; self.transitionID = nil; self.isBusy = false
                    self.admissionQuarantined = true
                    self.message = "The destination cannot be shown. Close its pending session before trying again."
                    self.canRetry = true
                    self.retryAction = { [weak self] in self?.recoverQuarantinedActivation(nextOwner) }
                    return
                }
                let expectedTop = nav.topViewController, expectedRoot = nav.viewControllers.first
                self.afterNavigationTransition(nav) { [self, weak nav] in
                    guard self.transitionID == attempt else { return }
                    self.activationPending = false; self.transitionID = nil; self.isBusy = false
                    guard let nav = nav, self.foregroundEpoch == epoch,
                          UIApplication.shared.applicationState == .active,
                          self.model.selectedTab == tab,
                          self.isValidPreparedDestination(destination, for: tab, owner: nextOwner),
                          nav.topViewController === expectedTop, nav.viewControllers.first === expectedRoot else {
                        self.admissionQuarantined = true
                        self.message = "Opening paused. Close the pending session before trying again."
                        self.canRetry = true
                        self.retryAction = { [weak self] in self?.recoverQuarantinedActivation(nextOwner) }
                        return
                    }
                    let root = nav.viewControllers.first
                    nav.setViewControllers([root, destination.controller].compactMap { $0 }, animated: false)
                    guard newSource == nil || self.didInstall(nextOwner, tab.id, destination.controller) else {
                        self.admissionQuarantined = true
                        self.message = "The document could not finish activating. Its session remains reserved."
                        self.canRetry = true
                        self.retryAction = { [weak self] in self?.recoverQuarantinedActivation(nextOwner) }
                        return
                    }
                    self.message = nil; self.overview = nil; self.openingRoute = nil
                    self.captureCurrentPreview()
                }
            case .failure(let error):
                self.activationPending = false; self.transitionID = nil; self.isBusy = false
                // Adapter failure promises its destination host is fully closed.
                // Uncertain cleanup MUST retain its reservation and not call back.
                self.message = error.localizedDescription
                self.retryAction = { [weak self] in self?.activateSelected() }; self.canRetry = true
            }
        }
    }

    private func isValidPreparedDestination(_ destination: PreparedDestination,
                                             for tab: NativeDocumentTab, owner: UUID) -> Bool {
        guard destination.controller.parent == nil,
              destination.controller !== navigation?.viewControllers.first else { return false }
        if tab.isHome { return destination.source == nil }
        guard let expected = tab.document, let source = destination.source,
              let actual = source.resolvedDocument else { return false }
        return source.role == .editor && source.ownerID == owner && source.tabID == tab.id
            && source.controller === destination.controller && source.isCurrent()
            && actual.vaultID == expected.vaultID && actual.localStoreID == expected.localStoreID
            && actual.stableFileID == expected.stableFileID
    }

    private func recoverQuarantinedActivation(_ reservation: UUID) {
        guard admissionQuarantined, !isBusy, UIApplication.shared.applicationState == .active else { return }
        isBusy = true
        // The activation adapter retains this exact reservation even for malformed
        // or uncertain results. Only its real terminal cleanup ACK opens admission.
        let cleanup: (@escaping (Result<Void, Error>) -> Void) -> Void
        if let source = source, source.ownerID == reservation, source.controller.parent != nil {
            // An installed prepared destination needs the editor's real save/
            // quiesce path. The factory may only directly close unlaunched hosts.
            cleanup = { completion in
                source.close(reservation) { result in
                    if source.hasTerminalRetirementReceipt() { completion(.success(())) }
                    else { completion(result) }
                }
            }
        } else {
            cleanup = { [self] completion in recoverActivation(reservation, completion) }
        }
        cleanup { [self] result in
            guard admissionQuarantined, ownerID == reservation else { return }
            isBusy = false
            switch result {
            case .success:
                source = nil; admissionQuarantined = false; ownerID = UUID()
                message = "The pending session is closed. Try opening the tab again."
                retryAction = { [weak self] in self?.activateSelected() }; canRetry = true
            case .failure(let error):
                message = error.localizedDescription
                retryAction = { [weak self] in self?.recoverQuarantinedActivation(reservation) }; canRetry = true
            }
        }
    }

    private func afterNavigationTransition(_ nav: UINavigationController, action: @escaping () -> Void) {
        if let transition = nav.transitionCoordinator {
            let scheduled = transition.animate(alongsideTransition: nil) { _ in action() }
            if !scheduled {
                DispatchQueue.main.async { [weak self, weak nav] in
                    guard let self = self, let nav = nav else { return }
                    self.afterNavigationTransition(nav, action: action)
                }
            }
        } else { action() }
    }

    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
}

@MainActor
private struct NativeCoordinatedTabOverview: View {
    @ObservedObject var coordinator: NativeDocumentTabCoordinator
    var body: some View {
        NativeTabOverview(model: coordinator.model, snapshots: coordinator.snapshots,
            onIntent: { coordinator.performDocumentTabIntent($0) },
            onDone: { coordinator.finishDocumentTabOverview() },
            isInteractionBlocked: coordinator.isBusy,
            transitionMessage: coordinator.message,
            onRetryTransition: coordinator.canRetry ? { coordinator.retryTransition() } : nil,
            onResumeSource: coordinator.canResume ? { coordinator.resumeSource() } : nil)
    }
}

@MainActor
private final class NativeDocumentTabOverviewController: UIHostingController<NativeCoordinatedTabOverview> {
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationItem.hidesBackButton = true
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }
}


@MainActor
private struct NativeDocumentTabOpeningView: View {
    @ObservedObject var coordinator: NativeDocumentTabCoordinator
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground).ignoresSafeArea()
            if coordinator.isBusy {
                NativeEditorLoadingView()
            } else {
                VStack(spacing: 20) {
                    Text(coordinator.message ?? "Choose how to continue.")
                        .font(.body).multilineTextAlignment(.center)
                    if coordinator.canRetry { Button("Retry") { coordinator.retryTransition() }.frame(minHeight: 44) }
                    if coordinator.canResume { Button("Return to document") { coordinator.resumeSource() }.frame(minHeight: 44) }
                }.padding(24)
            }
        }.accessibilityIdentifier("native.tabs.opening")
    }
}

@MainActor
private final class NativeDocumentTabOpeningController: UIHostingController<NativeDocumentTabOpeningView> {
    private weak var coordinator: NativeDocumentTabCoordinator?
    init(coordinator: NativeDocumentTabCoordinator) {
        self.coordinator = coordinator
        super.init(rootView: NativeDocumentTabOpeningView(coordinator: coordinator))
    }
    required init?(coder: NSCoder) { fatalError("Use the native document coordinator.") }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: false)
        navigationItem.hidesBackButton = true
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        let tabs = UIBarButtonItem(image: UIImage(systemName: "square.on.square"), style: .plain,
                                   target: self, action: #selector(showTabs))
        tabs.accessibilityLabel = "Show tabs"; tabs.accessibilityIdentifier = "native.tabs.opening.showTabs"
        navigationItem.rightBarButtonItem = tabs
    }
    @objc private func showTabs() { coordinator?.showDocumentTabs(from: self) }
}
