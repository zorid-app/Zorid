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
    static weak var destinationRouter: NativeImportDestinationRouting?
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
    private var pendingExternal: [(url: URL, scoped: Bool)] = []
    private var progressAlert: UIAlertController?
    // Installed after the exact Rust/ABI contract and Pages lending hook agree.
    // This is a native-only typed callback, never a Capacitor method.
    var importReady: (([NativeImportItem], NativeImportOrigin, UIViewController) -> Void)?

    func presentFiles(from presenter: UIViewController) {
        guard !busy else { return }
        begin(from: presenter, origin: .files)
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
        picker.allowsMultipleSelection = true; picker.delegate = self
        activePicker = picker
        presenter.present(picker, animated: true)
        picker.presentationController?.delegate = self
    }
    func presentPhotos(from presenter: UIViewController) {
        guard !busy else { return }
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
        guard !urls.isEmpty else { reset(); return }
        guard urls.count <= NativeImportStaging.itemLimit else { failed(NativeImportFailure.tooLarge); return }
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
            guard !recentURLs.contains(where: { $0.0 == key }) else { continue }
            guard pendingExternal.count < NativeImportStaging.itemLimit else { notice("Finish the pending import before adding more files.", from: presenter); continue }
            recentURLs.append((key, now)); pendingExternal.append((url, url.startAccessingSecurityScopedResource()))
        }
        if recentURLs.count > 40 { recentURLs.removeFirst(recentURLs.count - 40) }
        resumeExternal(from: presenter)
        return true
    }
    func resumeExternal(from presenter: UIViewController) {
        guard !busy, !pendingExternal.isEmpty, presenter.viewIfLoaded?.window != nil,
              presenter.presentedViewController == nil else { return }
        let sources = pendingExternal; pendingExternal = []
        begin(from: presenter, origin: .openIn)
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
            let items = self.staged, source = self.origin, presenter = self.presenter
            let canceled = (try? self.cancellation.check()) == nil
            self.reset()
            guard let presenter = presenter, presenter.viewIfLoaded?.window != nil else { return }
            if canceled { self.notice(NativeImportFailure.canceled.message, from: presenter); return }
            guard !items.isEmpty else { return }
            if let importReady = self.importReady { importReady(items, source, presenter) }
            else { self.notice("Files are copied safely. Choose Import to select their destination when the vault is ready.", from: presenter) }
        }
    }
    private func failed(_ error: Error) {
        let ticket = generation
        hideProgress { [weak self] in
            guard let self = self, self.generation == ticket else { return }
            let presenter = self.presenter
            self.reset()
            guard let presenter = presenter, presenter.viewIfLoaded?.window != nil else { return }
            self.notice((error as? NativeImportFailure)?.message ?? NativeImportFailure.unavailable.message, from: presenter)
        }
    }
    private func showProgress(_ message: String) {
        guard let presenter = presenter else { return }
        let alert = UIAlertController(title: "Import", message: message, preferredStyle: .alert)
        let cancel = cancellation
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in cancel.cancel() })
        progressAlert = alert; presenter.present(alert, animated: true)
    }
    private func hideProgress(_ completion: @escaping () -> Void) {
        let alert = progressAlert; progressAlert = nil
        if let alert = alert, alert.presentingViewController != nil { alert.dismiss(animated: true, completion: completion) } else { completion() }
    }
    private func notice(_ message: String, from presenter: UIViewController) {
        let alert = UIAlertController(title: "Import", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default)); presenter.present(alert, animated: true)
    }
    private func reset() {
        generation &+= 1; cancellation.cancel(); busy = false
        providerProgress = nil; providerTicket = nil; activePicker = nil; staged = []
    }
    deinit {
        cancellation.cancel()
        pendingExternal.filter(\.scoped).forEach { $0.url.stopAccessingSecurityScopedResource() }
    }
}
