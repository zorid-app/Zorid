import UIKit
import PhotosUI
import UniformTypeIdentifiers
import CryptoKit
import Darwin

// All UIKit and ownership transitions occur on main. Staging and C ABI have
// separate serial queues; neither queue waits synchronously for main.
enum NativeImportOrigin { case files, photos, openIn, recovery }

struct NativeExclusiveSessionBinding {
    let session: NativeMobileSession
    let localStoreId: String
    let folderId: String?
    let folderPath: String
    // Success means released/reusable; failure means explicitly fenced/unusable.
    // Pages owns an idempotent generation ticket and ignores stale returns.
    let finish: (Result<Void, Error>) -> Void
}
typealias NativeImportDestination = NativeExclusiveSessionBinding

struct NativeSessionAdmission: Equatable {
    let localStoreId: String
    let clientId: String
    let token: String
    var wireReference: [String: String] {
        ["local_store_id": localStoreId, "client_id": clientId, "token": token]
    }
}
struct NativeSessionOperationFailure: Error {
    let code: String
    let commitUncertain: Bool
    let sessionFenced: Bool
}

struct NativeImportProgress: Decodable {
    enum State: String, Decodable { case hashing, receiving, sealed, commit_requested, committed, collision, aborted }
    enum Commit: String, Decodable { case not_requested, requested, committed, rejected, aborted }
    enum Projection: String, Decodable { case not_started, pending, projected }
    let operationId: String
    let state: State
    let processedBytes: String
    let totalBytes: String
    let selectedPath: String?
    let commitState: Commit
    let projectionState: Projection
    let canRetryCollision: Bool
}

@MainActor
protocol NativeImportDestinationRouting: AnyObject {
    // External intents MUST explicitly select a vault/folder, even if one is open.
    // The returned binding exclusively lends an existing owned host, never opens
    // a competing session. Editor/save handoff is the Pages owner's responsibility.
    func chooseImportDestination(from: UIViewController, source: NativeImportOrigin,
        completion: @escaping (Result<NativeImportDestination, Error>) -> Void)
}

@MainActor
final class NativeImportCoordinator: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    static weak var destinationRouter: NativeImportDestinationRouting? {
        didSet { NotificationCenter.default.post(name: Notification.Name("ZoridImportDestinationReady"), object: nil) }
    }
    private weak var presenter: UIViewController?
    private let staging = NativeImportStaging.shared
    private var cancellation = NativeImportCancellation()
    private var busy = false
    private var generation: UInt64 = 0
    private var providerTicket: UUID?
    private weak var activePicker: UIViewController?
    private var staged: [NativeImportItem] = []
    private var origin: NativeImportOrigin = .files
    private var batchId = UUID()
    private var providerProgress: Progress?
    private var recentURLs: [(String, Date)] = []
    private var acceptedURLKeys = Set<String>()
    private var pendingExternal: [(url: URL, scoped: Bool, key: String)] = []
    private var batchURLKeys: [UUID: Set<String>] = [:]
    private var progressAlert: UIAlertController?
    private var pendingOffers: [(items: [NativeImportItem], source: NativeImportOrigin)] = []
    private var offerVisible = false
    private var routerObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private var runBinding: NativeExclusiveSessionBinding?
    private var runAdmission: NativeSessionAdmission?
    private var runSelection: NativeImportSelection?
    private var runItems: [NativeImportItem] = []
    private var completedItems = Set<UUID>()
    private var runIndex = 0, stepCount = 0, collisionCount = 0
    private var cancelSent = false, finishing = false
    override init() {
        super.init()
        routerObserver = NotificationCenter.default.addObserver(forName: Notification.Name("ZoridImportDestinationReady"), object: nil, queue: .main) { [weak self] _ in
            guard let self = self, let presenter = self.presenter else { return }
            self.resumeExternal(from: presenter)
        }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.cancelCurrentOperation()
        }
    }

    func presentFiles(from presenter: UIViewController) {
        guard UIApplication.shared.applicationState == .active, !busy else { return }
        begin(from: presenter, origin: .files)
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
        picker.allowsMultipleSelection = true; picker.delegate = self
        activePicker = picker
        presenter.present(picker, animated: true)
        picker.presentationController?.delegate = self
    }
    func presentPhotos(from presenter: UIViewController) {
        guard UIApplication.shared.applicationState == .active, !busy else { return }
        begin(from: presenter, origin: .photos)
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.selectionLimit = NativeImportStaging.itemLimit
        configuration.filter = .any(of: [.images, .videos])
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self; activePicker = picker
        presenter.present(picker, animated: true)
        picker.presentationController?.delegate = self
    }
    private func begin(from presenter: UIViewController, origin: NativeImportOrigin) {
        cancellation.cancel(); generation &+= 1
        busy = true; self.presenter = presenter; self.origin = origin
        cancellation = NativeImportCancellation(); batchId = UUID(); staged = []
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { if activePicker === controller { reset() } }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { if activePicker === presentationController.presentedViewController { reset() } }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard activePicker === controller else { return }
        let ticket = generation; activePicker = nil
        controller.dismiss(animated: true) { [weak self] in
            guard let self = self, self.generation == ticket else { return }; self.copyURLs(urls)
        }
    }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard activePicker === picker else { return }
        let ticket = generation; activePicker = nil
        picker.dismiss(animated: true) { [weak self] in
            guard let self = self, self.generation == ticket else { return }
            if results.isEmpty { self.reset(); return }
            guard results.count <= NativeImportStaging.itemLimit else { self.failed(NativeImportFailure.tooLarge); return }
            self.showProgress("Copying selected files…")
            self.copyProviders(results.map(\.itemProvider), index: 0, remaining: NativeImportStaging.batchLimit)
        }
    }
    private func copyURLs(_ urls: [URL], acquiredScopes: [URL] = []) {
        guard !urls.isEmpty else { acquiredScopes.forEach { $0.stopAccessingSecurityScopedResource() }; reset(); return }
        guard urls.count <= NativeImportStaging.itemLimit else { acquiredScopes.forEach { $0.stopAccessingSecurityScopedResource() }; failed(NativeImportFailure.tooLarge); return }
        showProgress("Copying selected files…")
        let cancel = cancellation, batch = batchId, staging = staging, ticket = generation
        staging.worker.async { [weak self] in
            defer { acquiredScopes.forEach { $0.stopAccessingSecurityScopedResource() } }
            let result = Result { () -> [NativeImportItem] in
                var items: [NativeImportItem] = [], remaining = NativeImportStaging.batchLimit
                for url in urls {
                    let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType ?? UTType(filenameExtension: url.pathExtension) ?? .data
                    let item = try staging.copy(url, batchId: batch, fileName: url.lastPathComponent,
                        typeIdentifier: type.identifier, remaining: remaining, cancellation: cancel)
                    items.append(item); remaining -= item.byteLength
                }
                return items
            }
            DispatchQueue.main.async {
                guard let self = self, self.generation == ticket else { return }
                switch result { case .success(let items): self.staged = items; self.ready()
                case .failure(let error): self.failed(error) }
            }
        }
    }
    private func copyProviders(_ providers: [NSItemProvider], index: Int, remaining: UInt64) {
        guard index < providers.count else { ready(); return }
        let provider = providers[index]
        guard let identifier = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true })
        else { failed(NativeImportFailure.invalidSource); return }
        let cancel = cancellation, batch = batchId, staging = staging, generation = generation
        let ticket = UUID(); providerTicket = ticket
        let suggested = provider.suggestedName
        // Initiate off-main too: a provider is allowed to invoke its completion
        // synchronously. Its temporary file MUST be copied before callback return.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let progress = provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
                let result = Result { () -> NativeImportItem in
                    guard let url = url else { throw NativeImportFailure.invalidSource }
                    let suffix = UTType(identifier)?.preferredFilenameExtension
                    var name = suggested ?? url.lastPathComponent
                    if (name as NSString).pathExtension.isEmpty, let suffix = suffix { name += "." + suffix }
                    return try staging.worker.sync {
                        try staging.copy(url, batchId: batch, fileName: name, typeIdentifier: identifier,
                            remaining: remaining, cancellation: cancel)
                    }
                }
                DispatchQueue.main.async {
                    guard let self = self, self.generation == generation, self.providerTicket == ticket else { return }
                    self.providerTicket = nil; self.providerProgress = nil
                    switch result {
                    case .success(let item): self.staged.append(item); self.copyProviders(providers, index: index + 1, remaining: remaining - item.byteLength)
                    case .failure(let error): self.failed(error)
                    }
                }
            }
            DispatchQueue.main.async {
                guard let self = self, self.generation == generation, self.providerTicket == ticket else { return }
                cancel.attach(progress); self.providerProgress = progress
            }
        }
    }

    // Stage first; explicit destination comes later. URL hashes are RAM-only and
    // short lived; cold+warm duplicate delivery must not create duplicate batches.
    @discardableResult
    func receiveOpenIn(_ urls: [URL], from presenter: UIViewController) -> Bool {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return false }
        let now = Date(); recentURLs.removeAll { now.timeIntervalSince($0.1) > 2 }
        for url in files {
            let key = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
            guard !acceptedURLKeys.contains(key), !recentURLs.contains(where: { $0.0 == key }) else { continue }
            guard pendingExternal.count < NativeImportStaging.itemLimit, acceptedURLKeys.count < 40 else { notice("Finish the pending import before adding more files.", from: presenter); continue }
            acceptedURLKeys.insert(key); recentURLs.append((key, now)); pendingExternal.append((url, url.startAccessingSecurityScopedResource(), key))
        }
        if recentURLs.count > 40 { recentURLs.removeFirst(recentURLs.count - 40) }
        resumeExternal(from: presenter)
        return true
    }
    func resumeExternal(from presenter: UIViewController) {
        guard UIApplication.shared.applicationState == .active, !busy, presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else { return }
        self.presenter = presenter
        guard !pendingExternal.isEmpty else { offerPending(from: presenter); return }
        let sources = pendingExternal; pendingExternal = []
        begin(from: presenter, origin: .openIn)
        batchURLKeys[batchId] = Set(sources.map(\.key))
        copyURLs(sources.map(\.url), acquiredScopes: sources.filter(\.scoped).map(\.url))
    }
    func recover(from presenter: UIViewController) {
        guard !busy else { return }
        begin(from: presenter, origin: .recovery)
        let ticket = generation
        staging.worker.async { [weak self] in
            let result = Result { try NativeImportStaging.shared.pending() }
            DispatchQueue.main.async {
                guard let self = self, self.generation == ticket else { return }
                switch result { case .success(let items): self.staged = items; self.ready()
                case .failure(let error): self.failed(error) }
            }
        }
    }
    private func ready() {
        let ticket = generation
        hideProgress { [weak self] in
            guard let self = self, self.generation == ticket else { return }
            let items = self.staged, source = self.origin, presenter = self.presenter, batch = self.batchId
            let canceled = (try? self.cancellation.check()) == nil
            self.reset()
            if canceled || presenter?.viewIfLoaded?.window == nil { self.retireSourceKeys([batch]) }
            guard let presenter = presenter, presenter.viewIfLoaded?.window != nil else { return }
            if canceled { self.notice(NativeImportFailure.canceled.message, from: presenter); return }
            guard !items.isEmpty else { self.resumeExternal(from: presenter); return }
            let known = Set(self.pendingOffers.flatMap { $0.items.map(\.itemId) })
            let fresh = items.filter { !known.contains($0.itemId) }
            for start in stride(from: 0, to: fresh.count, by: NativeImportStaging.itemLimit) {
                self.pendingOffers.append((Array(fresh[start..<min(start + NativeImportStaging.itemLimit, fresh.count)]), source))
            }
            if Self.destinationRouter == nil { self.notice("Files are copied safely. Open the destination vault, then confirm a folder to import them.", from: presenter) }
            else { self.offerPending(from: presenter) }
        }
    }
    private func failed(_ error: Error) {
        let ticket = generation
        hideProgress { [weak self] in
            guard let self = self, self.generation == ticket else { return }
            let presenter = self.presenter
            self.retireSourceKeys([self.batchId]); self.reset()
            guard let presenter = presenter, presenter.viewIfLoaded?.window != nil else { return }
            self.notice((error as? NativeImportFailure)?.message ?? NativeImportFailure.unavailable.message, from: presenter)
        }
    }
    // Router registration only OFFERS pending work; it never selects a vault or
    // starts mutation. Every actual run goes through an explicit destination UI.
    private func offerPending(from presenter: UIViewController) {
        guard UIApplication.shared.applicationState == .active, !busy, !offerVisible, let offer = pendingOffers.first,
              presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else { return }
        guard Self.destinationRouter != nil else { return }
        let alert = UIAlertController(title: "Import staged files", message: "Choose the destination vault and folder for \(offer.items.count) file(s). Existing files will be kept.", preferredStyle: .alert)
        offerVisible = true
        alert.addAction(UIAlertAction(title: "Later", style: .cancel) { [weak self] _ in self?.offerVisible = false })
        alert.addAction(UIAlertAction(title: "Choose destination", style: .default) { [weak self, weak presenter] _ in
            guard let self = self else { return }
            self.offerVisible = false
            guard UIApplication.shared.applicationState == .active, let presenter = presenter, let router = Self.destinationRouter else { return }
            self.generation &+= 1; let ticket = self.generation
            self.busy = true; self.cancellation = NativeImportCancellation(); self.presenter = presenter
            router.chooseImportDestination(from: presenter, source: offer.source) { [weak self] result in
                guard let self = self, self.generation == ticket else {
                    if case .success(let binding) = result { binding.finish(.success(())) } // No claim was attempted.
                    return
                }
                switch result {
                case .failure:
                    self.busy = false
                    // Cancel/dismiss keeps the exact staged intent, with no mutation.
                case .success(let binding):
                    self.pendingOffers.removeFirst()
                    self.runItems = offer.items; self.runIndex = 0; self.runBinding = binding
                    self.showProgress("Importing copied files…")
                    binding.session.acquireNativeAdmission(expectedStoreId: binding.localStoreId) { result in
                        switch result {
                        case .success(let admission): self.runAdmission = admission; self.prepareNextItem()
                        case .failure(let error): self.finishRun(error: error, fence: true)
                        }
                    }
                }
            }
        })
        presenter.present(alert, animated: true)
    }
    private func prepareNextItem() {
        guard let binding = runBinding, let admission = runAdmission else { return }
        guard runIndex < runItems.count else { finishRun(); return }
        let item = runItems[runIndex], cancel = cancellation, staging = staging
        stepCount = 0; collisionCount = 0; cancelSent = false
        staging.worker.async {
            let result = Result { () -> (NativeImportSelection, Int32) in
                try cancel.check()
                let saved = try staging.selection(for: item)
                let selection = saved ?? NativeImportSelection(version: 1, clientId: admission.clientId,
                    localStoreId: admission.localStoreId, operationId: UUID().uuidString.lowercased(), entryId: UUID().uuidString.lowercased(),
                    destinationFolder: binding.folderPath, fileName: item.fileName, kind: "auto", expectedLength: String(item.byteLength), sha256: item.sha256)
                // Retry the original vault/client/folder only; never replan an
                // unresolved operation after the user selects a different vault.
                guard selection.clientId == admission.clientId, selection.localStoreId == admission.localStoreId,
                      selection.destinationFolder == binding.folderPath else { throw NativeImportFailure.invalidJournal }
                try staging.save(selection, for: item)
                let fd: Int32
                do { fd = try staging.openPayload(item) } catch {
                    guard saved != nil else { throw error }; fd = -1 // Rust alone decides whether source-free recovery is safe.
                }
                return (selection, fd)
            }
            DispatchQueue.main.async {
                switch result {
                case .success(let (selection, fd)):
                    self.runSelection = selection
                    binding.session.beginNativeImport(owningSourceFD: fd, selection: selection, admission: admission) { self.receiveProgress($0) }
                case .failure(let error): self.finishRun(error: error)
                }
            }
        }
    }
    private func receiveProgress(_ result: Result<NativeImportProgress, Error>) {
        guard !finishing, let binding = runBinding, let admission = runAdmission, let selection = runSelection,
              runIndex < runItems.count else { return }
        let item = runItems[runIndex]
        switch result {
        case .failure(let error):
            finishRun(error: error, fence: true) // A retained/nonterminal job must resume on a fresh host/token.
        case .success(let progress):
            guard progress.operationId == selection.operationId, progress.totalBytes == selection.expectedLength else {
                finishRun(error: NativeImportFailure.invalidReply, fence: true); return
            }
            progressAlert?.message = "\(runIndex + 1) of \(runItems.count) · \(progress.processedBytes) of \(progress.totalBytes) bytes"
            if progress.state == .committed && progress.commitState == .committed {
                // Pending projection is still committed. Durable Rust receipts,
                // never a UI timeout, authorize deleting this app-owned copy.
                completedItems.insert(item.itemId)
                staging.worker.async {
                    let cleanup = Result { try self.staging.removeConfirmed(item) }
                    DispatchQueue.main.async {
                        if case .failure(let error) = cleanup { self.finishRun(error: error); return }
                        self.completedItems.insert(item.itemId); self.runIndex += 1; self.runSelection = nil
                        self.prepareNextItem()
                    }
                }
                return
            }
            if progress.state == .aborted && progress.commitState == .aborted {
                completedItems.insert(item.itemId)
                staging.worker.async {
                    let cleanup = Result { try self.staging.removeConfirmed(item) }
                    DispatchQueue.main.async {
                        if case .success = cleanup { self.completedItems.insert(item.itemId) }
                        self.finishRun(error: NativeImportFailure.canceled)
                    }
                }
                return
            }
            if progress.state == .collision && progress.canRetryCollision {
                guard (try? cancellation.check()) != nil, collisionCount < 100 else { finishRun(error: NativeImportFailure.unavailable); return }
                collisionCount += 1
                let next = NativeImportSelection(version: selection.version, clientId: selection.clientId, localStoreId: selection.localStoreId,
                    operationId: UUID().uuidString.lowercased(), entryId: UUID().uuidString.lowercased(), destinationFolder: selection.destinationFolder,
                    fileName: selection.fileName, kind: selection.kind, expectedLength: selection.expectedLength, sha256: selection.sha256)
                staging.worker.async {
                    let restarted = Result { () -> Int32 in
                        try self.staging.replaceAfterCollision(selection, next: next, item: item)
                        return try self.staging.openPayload(item)
                    }
                    DispatchQueue.main.async {
                        switch restarted {
                        case .success(let fd): self.runSelection = next; binding.session.beginNativeImport(owningSourceFD: fd, selection: next, admission: admission) { self.receiveProgress($0) }
                        case .failure(let error): self.finishRun(error: error)
                        }
                    }
                }
                return
            }
            let canceled = (try? cancellation.check()) == nil
            if canceled && !cancelSent {
                cancelSent = true
                binding.session.cancelNativeImport(selection.operationId, admission: admission) { self.receiveProgress($0) }
                return
            }
            if canceled && cancelSent {
                // Cancel after commit intent is not rollback. Retain the exact
                // journal/source and reopen a fresh host to resume that identity.
                finishRun(error: NativeImportFailure.canceled, fence: true); return
            }
            guard stepCount < 4096 else { finishRun(error: NativeImportFailure.unavailable, fence: true); return }
            stepCount += 1
            binding.session.stepNativeImport(selection.operationId, admission: admission) { self.receiveProgress($0) }
        }
    }
    private func finishRun(error: Error? = nil, fence: Bool = false) {
        guard !finishing, let binding = runBinding else { return }
        finishing = true
        let ended: (Result<Void, Error>) -> Void = { release in
            self.hideProgress {
                let unfinished = self.runItems.filter { !self.completedItems.contains($0.itemId) }
                if !unfinished.isEmpty { self.pendingOffers.insert((unfinished, .recovery), at: 0) }
                let finishedBatches = Set(self.runItems.map(\.batchId)).subtracting(unfinished.map(\.batchId))
                self.retireSourceKeys(finishedBatches)
                self.runBinding = nil; self.runAdmission = nil; self.runSelection = nil
                self.runItems = []; self.completedItems = []; self.finishing = false; self.busy = false
                self.cancellation.cancel()
                binding.finish(release) // Exactly once, after drain+ACK or explicit fence.
                let message: String
                if case .failure = release { message = "Import state is retained. Reopen the vault to retry safely." }
                else if let error = error { message = (error as? NativeImportFailure)?.message ?? "Import could not finish. Retry the retained files in their original vault and folder." }
                else { message = "Files imported." }
                if let presenter = self.presenter, presenter.viewIfLoaded?.window != nil { self.notice(message, from: presenter) }
            }
        }
        if fence, let admission = runAdmission {
            binding.session.fenceNativeAdmission(admission) { result in
                switch result {
                case .success: ended(.failure(NativeSessionOperationFailure(code: "native_import_retained", commitUncertain: true, sessionFenced: true)))
                case .failure(let stale): ended(.failure(stale))
                }
            }
        } else if let admission = runAdmission {
            binding.session.releaseNativeAdmission(admission, completion: ended)
        } else {
            // acquireNativeAdmission already fenced uncertain dispatched claims.
            // A known busy/stale result has no authority to close another loan.
            ended(.failure(error ?? NativeSessionOperationFailure(code: "native_admission_stale", commitUncertain: false, sessionFenced: false)))
        }
    }
    private func showProgress(_ message: String) {
        guard let presenter = presenter else { return }
        let alert = UIAlertController(title: "Import", message: message, preferredStyle: .alert)
        let cancel = cancellation
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            guard let self = self, self.cancellation === cancel else { return }
            self.cancelCurrentOperation()
        })
        progressAlert = alert; presenter.present(alert, animated: true)
    }
    private func cancelCurrentOperation() {
        cancellation.cancel()
        // An admitted run must drain/cancel through its exact host admission.
        // Before admission, provider cancellation need not invoke completion:
        // invalidate the UI generation immediately and retain durable copies.
        guard busy, runBinding == nil else { return }
        let picker = activePicker, alert = progressAlert
        retireSourceKeys([batchId]); progressAlert = nil; reset()
        picker?.dismiss(animated: false)
        alert?.dismiss(animated: false)
    }
    private func hideProgress(_ completion: @escaping () -> Void) {
        let alert = progressAlert; progressAlert = nil
        if let alert = alert, alert.presentingViewController != nil { alert.dismiss(animated: true, completion: completion) } else { completion() }
    }
    private func notice(_ message: String, from presenter: UIViewController) {
        guard UIApplication.shared.applicationState == .active else { return }
        let alert = UIAlertController(title: "Import", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self, weak presenter] _ in
            guard let self = self, let presenter = presenter else { return }
            self.resumeExternal(from: presenter)
        }); presenter.present(alert, animated: true)
    }
    private func retireSourceKeys(_ batches: Set<UUID>) {
        for batch in batches {
            if let keys = batchURLKeys.removeValue(forKey: batch) { acceptedURLKeys.subtract(keys) }
        }
    }
    private func reset() {
        generation &+= 1; cancellation.cancel(); busy = false
        providerProgress = nil; providerTicket = nil; activePicker = nil; staged = []
    }
    deinit {
        cancellation.cancel()
        if let observer = routerObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        pendingExternal.filter(\.scoped).forEach { $0.url.stopAccessingSecurityScopedResource() }
    }
}
