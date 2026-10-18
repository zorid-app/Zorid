import UIKit
import SwiftUI
import WebKit
import Capacitor
import Darwin
import CoreFoundation

// Native owns roots and session lifetime; all storage/sync commands remain in Rust.
private enum MobileFailure: Error {
    case unavailable, invalidFrame, metadata
}

struct LocalVault: Codable {
    let id: UUID
    let name: String
    let clientId: String
}

private final class LocalVaultCatalog {
    private let manager = FileManager.default
    private let directory: URL
    private let metadata: URL
    private(set) var vaults: [LocalVault] = []

    init() throws {
        directory = try manager.url(for: .documentDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true).appendingPathComponent("Vaults", isDirectory: true)
        let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                      appropriateFor: nil, create: true)
        metadata = support.appendingPathComponent("native-local-vaults-v1.json")
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw MobileFailure.metadata }
        try reload()
    }

    func root(for vault: LocalVault) throws -> URL {
        guard let client = UUID(uuidString: vault.clientId),
              client.uuidString.lowercased() == vault.clientId else { throw MobileFailure.metadata }
        let root = directory.appendingPathComponent(vault.id.uuidString, isDirectory: true)
        let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true,
              root.resolvingSymlinksInPath().deletingLastPathComponent() == directory.resolvingSymlinksInPath()
        else { throw MobileFailure.metadata }
        return root
    }

    func reload() throws {
        // Corrupt metadata must never silently replace a durable client slot.
        vaults = []
        let (saved, normalized) = try readCanonicalRecords()
        var discovered = saved
        for url in try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
            guard let id = UUID(uuidString: url.lastPathComponent),
                  url.lastPathComponent == id.uuidString,
                  !discovered.contains(where: { $0.id == id }) else { continue }
            let vault = LocalVault(id: id, name: "Local vault \(id.uuidString.prefix(8))", clientId: UUID().uuidString.lowercased())
            _ = try root(for: vault)
            discovered.append(vault)
        }
        if normalized || discovered.count != saved.count { try persist(discovered) }
        vaults = discovered.filter { (try? root(for: $0)) != nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    func create(name: String) throws -> LocalVault {
        let cleaned = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, cleaned.count <= 80,
              cleaned.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { throw MobileFailure.metadata }
        // Validate every stored identity before creating any new client slot.
        var (saved, _) = try readCanonicalRecords()
        let vault = LocalVault(id: UUID(), name: cleaned, clientId: UUID().uuidString.lowercased())
        try manager.createDirectory(at: directory.appendingPathComponent(vault.id.uuidString), withIntermediateDirectories: false)
        // Write the identity atomically before permitting the first core open.
        saved.append(vault)
        try persist(saved)
        try reload()
        return vault
    }

    private func readCanonicalRecords() throws -> ([LocalVault], Bool) {
        let saved = manager.fileExists(atPath: metadata.path)
            ? try JSONDecoder().decode([LocalVault].self, from: Data(contentsOf: metadata)) : []
        guard Set(saved.map(\.id)).count == saved.count else { throw MobileFailure.metadata }
        var normalized = false
        let records = try saved.map { record -> LocalVault in
            guard !record.name.isEmpty, let uuid = UUID(uuidString: record.clientId) else {
                throw MobileFailure.metadata
            }
            let canonical = uuid.uuidString.lowercased()
            // Only case normalization is allowed; never replace an invalid identity.
            guard record.clientId.lowercased() == canonical else { throw MobileFailure.metadata }
            normalized = normalized || record.clientId != canonical
            return LocalVault(id: record.id, name: record.name, clientId: canonical)
        }
        return (records, normalized)
    }

    private func persist(_ records: [LocalVault]) throws {
        try JSONEncoder().encode(records).write(to: metadata, options: .atomic)
        let file = try FileHandle(forWritingTo: metadata)
        defer { try? file.close() }
        try file.synchronize()
        // Persist the atomic rename before a core can write drafts under this ID.
        let parent = Darwin.open(metadata.deletingLastPathComponent().path, O_RDONLY)
        guard parent >= 0 else { throw MobileFailure.metadata }
        defer { Darwin.close(parent) }
        guard fsync(parent) == 0 else { throw MobileFailure.metadata }
    }
}

final class NativeMobileSession {
    // Includes open/request/close and buffer frees, across every session instance.
    private static let worker = DispatchQueue(label: "app.zorid.mobile.core", qos: .userInitiated)
    private var handle: OpaquePointer?
    let vault: LocalVault
    private var reconciliation: [String: Any] // Access only on worker.
    private let documentSemantics: Bool // Immutable startup capability, never inferred.
    private static let headerLimit = 1_048_576
    private static let bodyLimit = 33_554_432

    private init(vault: LocalVault, handle: OpaquePointer, reconciliation: [String: Any], documentSemantics: Bool) {
        self.vault = vault
        self.handle = handle
        self.reconciliation = reconciliation
        self.documentSemantics = documentSemantics
    }

    static func open(vault: LocalVault, root: URL, completion: @escaping (Result<NativeMobileSession, Error>) -> Void) {
        let timer = NativePhaseTimer()
        worker.async {
            var error = ZoridBuffer(data: nil, len: 0)
            let pointer = root.path.withCString { zorid_mobile_open($0, &error) }
            zorid_mobile_buffer_free(error)
            let result: Result<NativeMobileSession, Error>
            if let pointer = pointer {
                do {
                    let startup = try consumeReconciliation(zorid_mobile_startup(pointer))
                    // Incomplete startup is usable recovery state, never an empty-ready fallback.
                    result = .success(NativeMobileSession(vault: vault, handle: pointer, reconciliation: startup.reconciliation,
                                                          documentSemantics: try startupDocumentSemantics(startup.wrapper)))
                } catch {
                    zorid_mobile_close(pointer)
                    result = .failure(MobileFailure.unavailable)
                }
            } else {
                result = .failure(MobileFailure.unavailable)
            }
            timer.finish(.open)
            DispatchQueue.main.async { completion(result) }
        }
    }

    // Reads and updates of cached reconciliation share the C-ABI worker queue.
    func context(completion: @escaping ([String: Any]) -> Void) {
        Self.worker.async {
            var context: [String: Any] = ["name": self.vault.name, "clientId": self.vault.clientId,
                                          "reconciliation": self.reconciliation]
            if self.documentSemantics { context["documentSemantics"] = true }
            let captured = context
            DispatchQueue.main.async { completion(captured) }
        }
    }

    func refresh(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let timer = NativePhaseTimer()
        Self.worker.async {
            let result: Result<[String: Any], Error>
            do {
                guard let handle = self.handle else { throw MobileFailure.unavailable }
                // Native selects the already-open root; web supplies no paths.
                let refreshed = try Self.consumeReconciliation(zorid_mobile_refresh(handle))
                self.reconciliation = refreshed.reconciliation
                result = .success(refreshed.wrapper)
            } catch {
                // Retain the last validated state on failure; never fabricate ready.
                result = .failure(MobileFailure.unavailable)
            }
            timer.finish(.refresh)
            DispatchQueue.main.async { completion(result) }
        }
    }

    // Both startup and refresh return owned raw JSON, unlike framed requests.
    private static func consumeReconciliation(_ buffer: ZoridBuffer) throws
        -> (wrapper: [String: Any], reconciliation: [String: Any]) {
        defer { zorid_mobile_buffer_free(buffer) }
        guard buffer.len > 0, buffer.len <= headerLimit, let data = buffer.data else {
            throw MobileFailure.unavailable
        }
        let bytes = Data(bytes: data, count: buffer.len)
        guard String(data: bytes, encoding: .utf8) != nil,
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let reconciliation = object["reconciliation"] as? [String: Any],
              reconciliation["complete"] is Bool else { throw MobileFailure.unavailable }
        return (object, reconciliation)
    }

    private static func startupDocumentSemantics(_ object: [String: Any]) throws -> Bool {
        guard let value = object["documentSemantics"] else { return false } // Older FFI.
        // NSNumber bridges JSON 1 as Bool too; only an actual JSON true advertises
        // this host capability. Explicit false/null/other types fail admission.
        guard let boolean = value as? NSNumber,
              CFGetTypeID(boolean) == CFBooleanGetTypeID(), boolean.boolValue else {
            throw MobileFailure.unavailable
        }
        return true
    }

    func request(header: String, body: String, completion: @escaping (Result<(String, String), Error>) -> Void) {
        Self.worker.async {
            let result: Result<(String, String), Error>
            var dispatched = false
            do {
                guard let handle = self.handle else { throw MobileFailure.unavailable }
                // Check encoded lengths before allocating decoded payloads.
                guard header.utf8.count <= Self.headerLimit,
                      body.utf8.count <= ((Self.bodyLimit + 2) / 3) * 4,
                      let payload = Data(base64Encoded: body), payload.count <= Self.bodyLimit
                else { throw MobileFailure.invalidFrame }
                let json = Data(header.utf8)
                let object = try Self.validateHeader(json)
                guard let command = object["command"] as? [String: Any],
                      let method = command["method"] as? String, !method.isEmpty else {
                    throw MobileFailure.invalidFrame
                }
                if method == "claim_client" {
                    // Only the persisted native consumer may obtain a lease.
                    // Rust owns the rest of the typed command schema/validation.
                    guard let clientId = command["client_id"] as? String,
                          clientId == self.vault.clientId else { throw MobileFailure.invalidFrame }
                }
                var frame = Data()
                for length in [json.count, payload.count] {
                    var value = UInt32(length).bigEndian
                    withUnsafeBytes(of: &value) { frame.append(contentsOf: $0) }
                }
                frame.append(json)
                frame.append(payload)
                dispatched = true
                let reply = frame.withUnsafeBytes { bytes in
                    zorid_mobile_request(handle, bytes.bindMemory(to: UInt8.self).baseAddress, frame.count)
                }
                defer { zorid_mobile_buffer_free(reply) }
                guard reply.len >= 8, reply.len <= 8 + Self.headerLimit + Self.bodyLimit,
                      let pointer = reply.data else { throw MobileFailure.invalidFrame }
                let bytes = UnsafeBufferPointer(start: pointer, count: reply.len)
                func length(_ offset: Int) -> Int {
                    (0..<4).reduce(0) { ($0 << 8) | Int(bytes[offset + $1]) }
                }
                let headerCount = length(0), bodyCount = length(4)
                guard headerCount <= Self.headerLimit, bodyCount <= Self.bodyLimit,
                      reply.len == 8 + headerCount + bodyCount else { throw MobileFailure.invalidFrame }
                let headerData = Data(bytes: pointer.advanced(by: 8), count: headerCount)
                try Self.validateHeader(headerData)
                guard let replyHeader = String(data: headerData, encoding: .utf8) else { throw MobileFailure.invalidFrame }
                // Body bytes are opaque here, including typed Rust document
                // JSON. Never parse/re-encode them through NSDictionary.
                let replyBody = Data(bytes: pointer.advanced(by: 8 + headerCount), count: bodyCount)
                result = .success((replyHeader, replyBody.base64EncodedString()))
            } catch {
                // Empty/malformed native replies are terminal for this host
                // generation. Drop leases before later queued calls can run.
                // Invalid input rejected before dispatch keeps a healthy host.
                if dispatched { self.closeOnWorker() }
                result = .failure(MobileFailure.unavailable)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    @discardableResult
    private static func validateHeader(_ data: Data) throws -> [String: Any] {
        guard String(data: data, encoding: .utf8) != nil,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw MobileFailure.invalidFrame }
        return object
    }

    private func closeOnWorker() {
        dispatchPrecondition(condition: .onQueue(Self.worker))
        if let handle = handle {
            self.handle = nil
            zorid_mobile_close(handle)
        }
    }

    func close(completion: @escaping () -> Void) {
        Self.worker.async {
            self.closeOnWorker()
            DispatchQueue.main.async(execute: completion)
        }
    }

    deinit {
        // Deallocation cannot release a core while queued requests still retain self.
        if let handle = handle { Self.worker.async { zorid_mobile_close(handle) } }
    }
}

// The launch intent makes New note mutually exclusive with an existing entry.
enum NativeEditorLaunch {
    case entry(NativeFileEntry)
    case newNote
}

@objc(NativeVaultPlugin)
final class NativeVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeVaultPlugin"
    let jsName = "NativeVault"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "context", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "noteOpened", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentationSettled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "editorState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lifecycleAck", returnType: CAPPluginReturnPromise)
    ]
    private let session: NativeMobileSession
    private let launch: NativeEditorLaunch
    private var pending: (id: String, reason: String, completion: (Bool) -> Void)?
    private var timeout: DispatchWorkItem?
    private var closeAuthorized = false
    private var currentEditorState = NativeEditorState.inactive
    fileprivate var onEditorState: ((NativeEditorState, Bool) -> Void)?
    fileprivate var onNoteOpened: ((String) -> Void)?
    fileprivate var onDocumentValidated: ((NativeTabDocument) -> Void)?
    fileprivate var isCurrentDocumentOwner: (() -> Bool)?
    fileprivate private(set) var documentValidationNonce = UUID()
    fileprivate private(set) var documentSnapshotReady = false
    fileprivate var onPresentationSettled: (() -> Bool)?

    fileprivate init(session: NativeMobileSession, launch: NativeEditorLaunch) {
        self.session = session
        self.launch = launch
        super.init()
    }

    // Capacitor invokes plugin methods on its own queue. Keep listener mutation
    // on main too, so UIKit requests cannot race inherited listener operations.
    override func addListener(_ call: CAPPluginCall) {
        if Thread.isMainThread {
            super.addListener(call)
            if call.getString("eventName") == "editorAction" { currentEditorState = .inactive }
            publishEditorState()
            if call.getString("eventName") == "editorStateRequest" { requestForegroundEditorState() }
        }
        else { DispatchQueue.main.sync { self.addListener(call) } }
    }

    override func removeListener(_ call: CAPPluginCall) {
        if Thread.isMainThread {
            super.removeListener(call)
            if call.getString("eventName") == "editorAction" { currentEditorState = .inactive }
            publishEditorState()
        }
        else { DispatchQueue.main.sync { self.removeListener(call) } }
    }

    override func removeAllListeners(_ call: CAPPluginCall) {
        if Thread.isMainThread { super.removeAllListeners(call); resetEditorState() }
        else { DispatchQueue.main.sync { self.removeAllListeners(call) } }
    }

    @objc func context(_ call: CAPPluginCall) {
        session.context { context in
            var context = context
            switch self.launch {
            case .entry(let entry):
                context["initialPath"] = entry.path
                context["initialEntryId"] = entry.id
            case .newNote:
                context["createNoteOnOpen"] = true
            }
            call.resolve(context)
        }
    }

    @objc func editorState(_ call: CAPPluginCall) {
        guard let state = NativeEditorState.decode(call.jsObjectRepresentation) else {
            call.reject("Invalid editor state.", "invalid_request")
            return
        }
        DispatchQueue.main.async {
            self.currentEditorState = self.hasListeners("editorAction") && !self.closeAuthorized
                && self.pending == nil && UIApplication.shared.applicationState == .active ? state : .inactive
            self.publishEditorState()
            call.resolve()
        }
    }

    private func publishEditorState() {
        onEditorState?(currentEditorState, hasListeners("editorAction"))
    }

    fileprivate func resetEditorState() {
        currentEditorState = .inactive
        publishEditorState()
    }

    fileprivate func invalidateDocumentValidation() {
        documentValidationNonce = UUID()
        documentSnapshotReady = false
    }

    fileprivate func requestForegroundEditorState() {
        guard UIApplication.shared.applicationState == .active, !closeAuthorized else { return }
        // Background checkpoints retain the workspace. Cancel only that pending
        // request; successful switch ACK ownership must never be revoked here.
        if pending?.reason == "background" { cancelLifecycle() }
        guard pending == nil, hasListeners("editorStateRequest") else { return }
        notifyListeners("editorStateRequest", data: ["reason": "foreground"])
    }

    fileprivate func sendEditorAction(_ action: NativeEditorAction) -> Bool {
        guard UIApplication.shared.applicationState == .active, !closeAuthorized,
              pending == nil, currentEditorState.focused, currentEditorState.editable,
              hasListeners("editorAction") else { return false }
        if action == .undo && !currentEditorState.canUndo { return false }
        if action == .redo && !currentEditorState.canRedo { return false }
        notifyListeners("editorAction", data: ["action": action.rawValue])
        return true
    }

    @objc func noteOpened(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), NativeFileEntry.isVisiblePath(path),
              let entryId = call.getString("entryId"), NativeFileEntry.isValidEntryId(entryId) else {
            call.reject("Invalid note identity.", "invalid_request")
            return
        }
        DispatchQueue.main.async {
            // A newer activation supersedes every older native listing callback.
            let nonce = UUID()
            self.documentValidationNonce = nonce
            self.documentSnapshotReady = false
            let current: () -> Bool = { [weak self] in
                guard let self = self else { return false }
                return self.documentValidationNonce == nonce && !self.closeAuthorized
                    && self.pending == nil && UIApplication.shared.applicationState == .active
                    && self.isCurrentDocumentOwner?() == true
            }
            guard current() else {
                call.reject("This editor is no longer active.", "stale_activation"); return
            }
            // The native listing is shared with history validation, never repeated.
            self.session.recordNoteOpened(path: path, entryId: entryId, isCurrent: current,
                onValidated: { [weak self] document in
                    guard let self = self, current() else { return }
                    self.documentSnapshotReady = true
                    self.onNoteOpened?(document.stableFileID)
                    guard current() else { return }
                    self.onDocumentValidated?(document)
                }) { result in
                    switch result {
                    case .success: call.resolve()
                    case .failure: call.reject("The opened note could not be recorded.", "native_history_failed")
                    }
                }
        }
    }

    @objc func presentationSettled(_ call: CAPPluginCall) {
        // UI context only: no file lookup or successful activation is required to
        // uncover an error/password prompt for a missing or unreadable selection.
        // Workspace owns the current-document/generation fence; internal links
        // can legitimately present an identity different from the launch intent.
        guard Set(call.jsObjectRepresentation.keys) == Set(["path", "entryId", "state"]),
              let path = call.getString("path"), NativeFileEntry.isVisiblePath(path),
              let entryId = call.getString("entryId"), NativeFileEntry.isValidEntryId(entryId),
              let state = call.getString("state"), state.utf8.count <= 8,
              ["ready", "password", "error"].contains(state) else {
            call.reject("Invalid editor presentation.", "invalid_request")
            return
        }
        DispatchQueue.main.async {
            if state != "ready" {
                self.documentValidationNonce = UUID()
                self.documentSnapshotReady = false
            }
            guard UIApplication.shared.applicationState == .active,
                  !self.closeAuthorized, self.pending == nil,
                  self.onPresentationSettled?() == true else {
                call.reject("This editor presentation is no longer active.", "stale_presentation")
                return
            }
            call.resolve()
        }
    }

    @objc func refresh(_ call: CAPPluginCall) {
        session.refresh { result in
            switch result {
            case .success(let wrapper): call.resolve(wrapper)
            case .failure: call.reject("The vault refresh could not be completed.", "native_refresh_failed")
            }
        }
    }

    @objc func request(_ call: CAPPluginCall) {
        guard let header = call.getString("header"), let body = call.getString("body") else {
            call.reject("Invalid vault request.", "invalid_request")
            return
        }
        session.request(header: header, body: body) { result in
            switch result {
            case .success(let (header, body)): call.resolve(["header": header, "body": body])
            case .failure: call.reject("The vault request could not be completed.", "native_request_failed")
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.closeAuthorized else {
                call.reject("Return to Vaults after the editor has finished saving.", "lifecycle_required")
                return
            }
            self.session.close { call.resolve() }
        }
    }

    // Web quiesces + flushes/checkpoints, then awaits this ACK. It must not
    // destroy/release before ACK; stale ACK resumes editing. Successful switch
    // ACK transfers close/lease teardown/pop to native. Background never closes.
    @objc func lifecycleAck(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), let ok = call.getBool("ok"),
                  let pending = self.pending, pending.id == id else {
                call.reject("This lifecycle request is no longer active.", "stale_lifecycle")
                return
            }
            // Reject a suspended switch before acknowledging it: a successful ACK
            // transfers teardown ownership to native and must always close/pop.
            if ok && pending.reason == "switchVault" && UIApplication.shared.applicationState != .active {
                self.cancelLifecycle()
                call.reject("This lifecycle request is no longer active.", "stale_lifecycle")
                return
            }
            self.timeout?.cancel()
            self.timeout = nil
            self.pending = nil
            self.closeAuthorized = ok && pending.reason == "switchVault"
            if self.closeAuthorized { self.resetEditorState() }
            call.resolve()
            pending.completion(ok)
        }
    }

    fileprivate func requestLifecycle(_ reason: String, completion: @escaping (Bool) -> Void) {
        guard pending == nil, hasListeners("lifecycleRequest") else { completion(false); return }
        invalidateDocumentValidation()
        let id = UUID().uuidString.lowercased()
        pending = (id, reason, completion)
        let timer = DispatchWorkItem { [weak self] in self?.cancelLifecycle() }
        timeout = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timer)
        notifyListeners("lifecycleRequest", data: ["id": id, "reason": reason])
    }

    fileprivate func cancelLifecycle() {
        timeout?.cancel()
        timeout = nil
        closeAuthorized = false
        let completion = pending?.completion
        pending = nil
        completion?(false)
    }
}

// WKContentView delegates its accessory getter to its WKWebView. Override the
// public responder property on our own view to remove the entire form bar;
// NativeEditorContainer supplies the editor toolbar and keyboard dismissal.
private final class NativeEditorWebView: WKWebView {
    override var inputAccessoryView: UIView? { nil }
}

private final class NativeEditorBridge: CAPBridgeViewController {
    let vaultPlugin: NativeVaultPlugin

    init(session: NativeMobileSession, launch: NativeEditorLaunch) {
        vaultPlugin = NativeVaultPlugin(session: session, launch: launch)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        // Bridge debug logging includes response prefixes (which may be note text).
        descriptor.loggingBehavior = .none
        descriptor.contentInsetAdjustmentBehavior = .never
        // UIKit's keyboardLayoutGuide is the only native viewport resizer.
        var plugins = descriptor.pluginConfigurations as? [String: Any] ?? [:]
        var keyboard = plugins["Keyboard"] as? [String: Any] ?? [:]
        keyboard["resize"] = "none"
        plugins["Keyboard"] = keyboard
        descriptor.pluginConfigurations = plugins
        return descriptor
    }

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        NativeEditorWebView(frame: frame, configuration: configuration)
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(vaultPlugin)
        webView?.accessibilityIdentifier = "native.editor.webview"
        // Use the same adaptive native surface behind web content and overscroll.
        // The shared editor owns its CSS/theme; native adds no frame or clipping.
        webView?.isOpaque = true
        webView?.backgroundColor = .systemBackground
        webView?.scrollView.backgroundColor = .systemBackground
        if #available(iOS 15, *) { webView?.underPageBackgroundColor = .systemBackground }
    }
}

final class NativeEditorContainer: UIViewController {
    private let session: NativeMobileSession
    private let editor: NativeEditorBridge
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var leaving = false
    private let originTitle: String
    private let onClosed: () -> Void
    var onNoteOpened: ((String) -> Void)?
    var onDocumentValidated: ((NativeTabDocument) -> Void)?
    private var documentSourceOwnerID: UUID?
    private var documentOwnerIsCurrent: (() -> Bool)?
    private var closeTicket: UUID?
    private var closeReceiptEpoch = UUID()
    private var closed = false
    var onNavigate: ((Int) -> Void)?
    private var canGoBack = false
    private var canGoForward = false
    private var historyContentView: (UIView & UIContentView)?
    private var legacyHistoryBack: UIButton?
    private var legacyHistoryForward: UIButton?
    private var loadingHost: UIHostingController<NativeEditorLoadingView>?
    private var loadingTimeout: DispatchWorkItem?
    private var loadingTimer: NativePhaseTimer?
    private var loadingFinished = false
    private enum EditorLoadingFinish: Equatable { case noteOpened, presentationSettled, timeout }
    private let toolbarModel = NativeKeyboardToolbarModel()
    private var toolbarHost: UIHostingController<NativeKeyboardToolbarView>?
    private var toolbarHeight: NSLayoutConstraint?
    private var editorBottom: NSLayoutConstraint?
    private var keyboardObservers: [NSObjectProtocol] = []
    private var toolbarVisible = false

    init(session: NativeMobileSession, launch: NativeEditorLaunch, originTitle: String = "Pages", onClosed: @escaping () -> Void = {}) {
        self.session = session
        self.originTitle = originTitle
        self.onClosed = onClosed
        editor = NativeEditorBridge(session: session, launch: launch)
        super.init(nibName: nil, bundle: nil)
        title = session.vault.name
    }

    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "native.editor.container"
        navigationItem.hidesBackButton = true
        installRouteControls()
        let done = UIBarButtonItem(title: originTitle, style: .plain, target: self, action: #selector(returnToVaults))
        done.accessibilityIdentifier = "native.editor.vaults"
        done.accessibilityLabel = "Return to " + originTitle
        navigationItem.rightBarButtonItem = done
        editor.vaultPlugin.isCurrentDocumentOwner = { [weak self] in
            guard let self = self, !self.leaving else { return false }
            return self.currentDocumentOwner(requiresVisible: true)
        }
        editor.vaultPlugin.onDocumentValidated = { [weak self] document in
            guard let self = self, !self.leaving, self.currentDocumentOwner(requiresVisible: true) else { return }
            self.onDocumentValidated?(document)
        }
        editor.vaultPlugin.onNoteOpened = { [weak self] id in
            self?.finishEditorLoading(reason: .noteOpened)
            self?.onNoteOpened?(id)
        }
        editor.vaultPlugin.onPresentationSettled = { [weak self] in
            guard let self = self, !self.leaving,
                  self.navigationController?.topViewController === self,
                  let scene = self.viewIfLoaded?.window?.windowScene,
                  scene.activationState == .foregroundActive else { return false }
            // This callback belongs to this container's immutable bridge/session.
            // It changes presentation only, never Recents or the route cursor.
            self.finishEditorLoading(reason: .presentationSettled)
            return true
        }
        updateRouteControls()
        editor.vaultPlugin.onEditorState = { [weak self] state, available in
            guard let self = self else { return }
            self.toolbarModel.state = state
            self.toolbarModel.actionsAvailable = available
            self.updateToolbarLayout()
        }
        addChild(editor)
        view.addSubview(editor.view)
        editor.view.translatesAutoresizingMaskIntoConstraints = false
        let safe = view.safeAreaLayoutGuide
        // iOS17+ can extend the hidden guide to the absolute view bottom while
        // retaining its docked-keyboard tracking. Top/side content stays safe.
        if #available(iOS 17, *) { view.keyboardLayoutGuide.usesBottomSafeArea = false }
        let bottom = editor.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        editorBottom = bottom
        NSLayoutConstraint.activate([
            editor.view.topAnchor.constraint(equalTo: safe.topAnchor),
            editor.view.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            editor.view.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            bottom
        ])
        editor.didMove(toParent: self)
        installEditorLoading()
        installKeyboardToolbar()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        view.setNeedsLayout()
        updateToolbarLayout()
        if !leaving { editor.vaultPlugin.requestForegroundEditorState() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        editor.vaultPlugin.resetEditorState()
        editor.vaultPlugin.invalidateDocumentValidation()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateToolbarLayout()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
            toolbarHeight?.constant = preferredToolbarHeight
            updateToolbarLayout()
        }
    }

    private var preferredToolbarHeight: CGFloat {
        max(44, UIFont.preferredFont(forTextStyle: .body).lineHeight + 16) + 16
    }

    private func installKeyboardToolbar() {
        let host = UIHostingController(rootView: NativeKeyboardToolbarView(model: toolbarModel) { [weak self] action in
            guard let self = self, self.toolbarVisible, self.editor.vaultPlugin.sendEditorAction(action) else { return }
            if action == .dismissKeyboard {
                self.view.endEditing(true)
                self.editor.vaultPlugin.resetEditorState()
            }
        })
        toolbarHost = host
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = .clear
        host.view.accessibilityIdentifier = "native.editor.keyboard-toolbar"
        host.view.isHidden = true
        let height = host.view.heightAnchor.constraint(equalToConstant: preferredToolbarHeight)
        toolbarHeight = height
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 8),
            host.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            host.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -4),
            height
        ])
        host.didMove(toParent: self)
        // Keep the guide's docked-only behavior. No keyboard frame height is
        // added to the viewport: that remains the guide's sole responsibility.
        view.keyboardLayoutGuide.followsUndockedKeyboard = false
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            keyboardObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self else { return }
                // Geometry belongs to the layout guide, including keyboards
                // retained across focus/app transitions without a new frame event.
                self.updateToolbarLayout(notification: notification)
            })
        }
        keyboardObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.editor.vaultPlugin.resetEditorState()
        })
        keyboardObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
            self.updateToolbarLayout()
            if !self.leaving, self.view.window != nil,
               self.navigationController?.topViewController === self {
                self.editor.vaultPlugin.requestForegroundEditorState()
            }
        })
    }

    private var hasDockedSoftwareKeyboard: Bool {
        guard view.window != nil else { return false }
        let frame = view.keyboardLayoutGuide.layoutFrame
        let intersection = view.bounds.intersection(frame)
        // Docked-only guide collapses to the bottom safe area for hidden/floating
        // keyboards. Hardware accessory strips cannot pass the height threshold.
        return !intersection.isNull && intersection.height > 100
            && intersection.width >= view.bounds.width - 2
            && frame.maxY >= view.bounds.maxY - 2
            && frame.minX <= view.bounds.minX + 2 && frame.maxX >= view.bounds.maxX - 2
    }

    private var hiddenKeyboardBottomExtension: CGFloat {
        if #available(iOS 17, *) { return 0 } // usesBottomSafeArea owns this.
        let safeBottom = view.safeAreaLayoutGuide.layoutFrame.maxY
        let guideTop = view.keyboardLayoutGuide.layoutFrame.minY
        // iOS15/16 lack usesBottomSafeArea. Correct only the guide's collapsed
        // safe-area position, never add a keyboard height or cross a docked strip.
        guard abs(guideTop - safeBottom) <= 0.5 else { return 0 }
        return max(0, view.bounds.maxY - guideTop)
    }

    private func updateToolbarLayout(notification: Notification? = nil) {
        guard isViewLoaded, let host = toolbarHost, let bottom = editorBottom else { return }
        let visible = toolbarModel.canAct && hasDockedSoftwareKeyboard
            && UIApplication.shared.applicationState == .active && !leaving
        let inset = visible ? (toolbarHeight?.constant ?? preferredToolbarHeight) + 8 : 0
        let bottomConstant = hiddenKeyboardBottomExtension - inset
        guard visible != toolbarVisible || bottom.constant != bottomConstant else { return }
        toolbarVisible = visible
        // One native viewport boundary clears BOTH guide-owned keyboard space
        // and the floating toolbar. Web must not apply a second toolbar inset.
        bottom.constant = bottomConstant
        host.view.isHidden = !visible
        // Layout/state callbacks must not start a second viewport animation after
        // WebKit has already revealed the focused selection for the keyboard.
        guard let notification = notification,
              let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double else {
            view.setNeedsLayout()
            return
        }
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 0
        if UIAccessibility.isReduceMotionEnabled {
            UIView.performWithoutAnimation { self.view.layoutIfNeeded() }
        } else {
            UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]) {
                self.view.layoutIfNeeded()
            }
        }
    }

    deinit {
        loadingTimeout?.cancel()
        for observer in keyboardObservers { NotificationCenter.default.removeObserver(observer) }
    }

    private var historyControls: NativeHistoryControls {
        NativeHistoryControls(backEnabled: canGoBack && !leaving, forwardEnabled: canGoForward && !leaving,
                              identifierPrefix: "native.editor") { [weak self] direction in
            guard let self = self, !self.leaving else { return }
            self.onNavigate?(direction)
        }
    }

    private func installRouteControls() {
        let content: UIView
        if #available(iOS 16, *) {
            // This content configuration hosts SwiftUI without an app-managed
            // child controller. A bar customView belongs to navigation-bar UI,
            // so parenting a UIHostingController to this container is invalid.
            let hosted = UIHostingConfiguration { historyControls }.margins(.all, 0).makeContentView()
            historyContentView = hosted
            content = hosted
        } else {
            let back = legacyRouteButton(symbol: "chevron.left", direction: -1, label: "Back", identifier: "native.editor.back")
            let forward = legacyRouteButton(symbol: "chevron.right", direction: 1, label: "Forward", identifier: "native.editor.forward")
            legacyHistoryBack = back
            legacyHistoryForward = forward
            let stack = UIStackView(arrangedSubviews: [back, forward])
            stack.axis = .horizontal
            stack.spacing = 0
            stack.layoutMargins = UIEdgeInsets(top: 0, left: 4, bottom: 0, right: 4)
            stack.isLayoutMarginsRelativeArrangement = true
            stack.backgroundColor = .secondarySystemBackground
            stack.layer.cornerRadius = 22
            content = stack
        }
        content.backgroundColor = historyContentView == nil ? .secondarySystemBackground : .clear
        content.clipsToBounds = false
        content.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.widthAnchor.constraint(equalToConstant: 96),
            content.heightAnchor.constraint(equalToConstant: 44)
        ])
        let item = UIBarButtonItem(customView: content)
        // Our single capsule supplies its own glass, not another nested bar pill.
        if #available(iOS 26, *) { item.hidesSharedBackground = true }
        navigationItem.leftBarButtonItem = item
    }

    private func legacyRouteButton(symbol: String, direction: Int, label: String, identifier: String) -> UIButton {
        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = label
        button.accessibilityIdentifier = identifier
        button.addAction(UIAction { [weak self] _ in
            guard let self = self, !self.leaving else { return }
            self.onNavigate?(direction)
        }, for: .touchUpInside)
        button.widthAnchor.constraint(equalToConstant: 44).isActive = true
        button.heightAnchor.constraint(equalToConstant: 44).isActive = true
        return button
    }

    private func installEditorLoading() {
        loadingTimer = NativePhaseTimer()
        let host = UIHostingController(rootView: NativeEditorLoadingView())
        loadingHost = host
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: editor.view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: editor.view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: editor.view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: editor.view.bottomAnchor)
        ])
        host.didMove(toParent: self)
        editor.view.accessibilityElementsHidden = true
        let timeout = DispatchWorkItem { [weak self] in self?.finishEditorLoading(reason: .timeout) }
        loadingTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
    }

    private func finishEditorLoading(reason: EditorLoadingFinish) {
        if reason == .noteOpened {
            loadingTimer?.finish(.editorReady)
            loadingTimer = nil
        }
        guard !loadingFinished else { return }
        if reason == .timeout { loadingTimer?.finish(.editorTimeout) }
        loadingFinished = true
        loadingTimeout?.cancel()
        loadingTimeout = nil
        editor.view.accessibilityElementsHidden = false
        guard let host = loadingHost else { return }
        // Timeout exposes the real web error/content. Never reload the bridge or
        // repeat a New note launch as a cosmetic loading retry.
        let remove = { [weak self] in
            host.willMove(toParent: nil)
            host.view.removeFromSuperview()
            host.removeFromParent()
            self?.loadingHost = nil
        }
        if reason == .noteOpened && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.18, animations: { host.view.alpha = 0 }) { _ in remove() }
        } else { remove() }
        if reason == .timeout && view.window != nil && UIApplication.shared.applicationState == .active {
            UIAccessibility.post(notification: .announcement, argument: "Editor is taking longer to load. Showing its current content.")
        }
    }

    func setRouteAvailability(back: Bool, forward: Bool) {
        canGoBack = back
        canGoForward = forward
        updateRouteControls()
    }

    private func updateRouteControls() {
        if #available(iOS 16, *) {
            historyContentView?.configuration = UIHostingConfiguration { historyControls }.margins(.all, 0)
        }
        legacyHistoryBack?.isEnabled = canGoBack && !leaving
        legacyHistoryForward?.isEnabled = canGoForward && !leaving
        navigationItem.rightBarButtonItem?.isEnabled = !leaving
    }

    @objc private func returnToVaults() { leaveForNativeRoute { _ in } }

    // Root supplies a weak closure comparing its current container/session/owner.
    // This UUID is presentation authority only, never a Rust lease credential.
    func configureDocumentTabOwner(sourceOwnerID: UUID, isCurrent: @escaping () -> Bool) {
        guard !leaving, !closed else { return }
        editor.vaultPlugin.invalidateDocumentValidation()
        documentSourceOwnerID = sourceOwnerID
        documentOwnerIsCurrent = isCurrent
    }

    private func currentDocumentOwner(requiresVisible: Bool) -> Bool {
        // An overview can cover/remove the source view from its window before
        // draining begins. Its navigation scene, not source visibility, owns close.
        let scene = requiresVisible ? viewIfLoaded?.window?.windowScene
            : navigationController?.viewIfLoaded?.window?.windowScene
        guard !closed, UIApplication.shared.applicationState == .active,
              scene?.activationState == .foregroundActive else { return false }
        if documentSourceOwnerID != nil, documentOwnerIsCurrent?() != true { return false }
        if requiresVisible {
            return navigationController?.topViewController === self && presentedViewController == nil
        }
        return true
    }

    func closeForDocumentTabTransition(sourceOwnerID: UUID, completion: @escaping (Result<Void, Error>) -> Void) {
        guard documentSourceOwnerID == sourceOwnerID, documentOwnerIsCurrent?() == true else {
            completion(.failure(MobileFailure.unavailable)); return
        }
        closeEditor(isCurrent: { [weak self] in
            guard let self = self, self.documentSourceOwnerID == sourceOwnerID else { return false }
            return self.currentDocumentOwner(requiresVisible: false)
        }, completion: completion)
    }

    // Both routes use the same save/ACK/close fence; only this wrapper navigates.
    func leaveForNativeRoute(completion: @escaping (Bool) -> Void) {
        closeEditor(isCurrent: { [weak self] in self?.currentDocumentOwner(requiresVisible: true) == true }) { [weak self] result in
            guard let self = self else { completion(false); return }
            switch result {
            case .success:
                completion(true)
                // Completion may synchronously advance navigation itself.
                if self.navigationController?.topViewController === self {
                    self.navigationController?.popViewController(animated: !UIAccessibility.isReduceMotionEnabled)
                }
            case .failure:
                completion(false)
                if !self.closed && self.currentDocumentOwner(requiresVisible: true) {
                    self.showMessage("Vault stays open", "The editor has not confirmed that it is safe to leave. Your workspace remains open. Try again after saving is ready.")
                }
            }
        }
    }

    private func closeEditor(isCurrent: @escaping () -> Bool, completion: @escaping (Result<Void, Error>) -> Void) {
        guard !leaving, !closed, isCurrent() else { completion(.failure(MobileFailure.unavailable)); return }
        let ticket = UUID()
        let epoch = closeReceiptEpoch
        closeTicket = ticket; leaving = true
        editor.vaultPlugin.resetEditorState()
        updateRouteControls()
        editor.vaultPlugin.requestLifecycle("switchVault") { [self] ok in
            guard closeTicket == ticket else { completion(.failure(MobileFailure.unavailable)); return }
            guard ok else {
                closeTicket = nil; leaving = false
                updateToolbarLayout(); updateRouteControls()
                completion(.failure(MobileFailure.unavailable)); return
            }
            // A true ACK has quiesced the web editor. Even if ownership changed,
            // finish closing this exact session; a stale receipt is never success.
            let admitted = closeReceiptEpoch == epoch && isCurrent()
            session.close { [self] in
                let stillCurrent = admitted && closeTicket == ticket && closeReceiptEpoch == epoch && isCurrent()
                closeTicket = nil
                loadingTimeout?.cancel()
                if !closed { closed = true; onClosed() }
                completion(stillCurrent ? .success(()) : .failure(MobileFailure.unavailable))
            }
        }
    }

    func captureDocumentTabSnapshot(sourceOwnerID: UUID, maximumPixelDimension: Int,
                                    completion: @escaping (UIImage?) -> Void) {
        guard maximumPixelDimension > 0, documentSourceOwnerID == sourceOwnerID,
              !leaving, currentDocumentOwner(requiresVisible: true),
              editor.vaultPlugin.documentSnapshotReady, let web = editor.webView else { completion(nil); return }
        let nonce = editor.vaultPlugin.documentValidationNonce
        let rect = web.bounds.intersection(web.convert(view.safeAreaLayoutGuide.layoutFrame, from: view))
        guard !rect.isNull, rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0 else { completion(nil); return }
        let limit = CGFloat(min(1024, maximumPixelDimension))
        let scale = max(1, view.window?.screen.scale ?? 1)
        let factor = min(1, limit / max(rect.width * scale, rect.height * scale))
        let configuration = WKSnapshotConfiguration()
        configuration.rect = rect
        configuration.snapshotWidth = NSNumber(value: Double(rect.width * factor))
        configuration.afterScreenUpdates = false
        var completed = false
        let finish: (UIImage?) -> Void = { image in
            guard !completed else { return }; completed = true; completion(image)
        }
        // Best effort only: callers must never await this to save or close.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { finish(nil) }
        web.takeSnapshot(with: configuration) { [weak self, weak web] image, _ in
            guard !completed, let self = self, let web = web, self.editor.webView === web,
                  !self.leaving, self.documentSourceOwnerID == sourceOwnerID,
                  self.currentDocumentOwner(requiresVisible: true),
                  self.editor.vaultPlugin.documentValidationNonce == nonce,
                  self.editor.vaultPlugin.documentSnapshotReady,
                  let image = image, let bitmap = image.cgImage,
                  bitmap.width > 0, bitmap.height > 0,
                  bitmap.width <= Int(limit), bitmap.height <= Int(limit),
                  bitmap.bytesPerRow <= 4_194_304 / max(1, bitmap.height) else { finish(nil); return }
            finish(image)
        }
    }

    func enterBackground() {
        closeReceiptEpoch = UUID()
        guard backgroundTask == .invalid else { return }
        editor.vaultPlugin.invalidateDocumentValidation()
        editor.vaultPlugin.resetEditorState()
        // Cancel a foreground navigation request; it must never pop on suspension.
        editor.vaultPlugin.cancelLifecycle()
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Vault draft checkpoint") { [weak self] in
            DispatchQueue.main.async {
                self?.editor.vaultPlugin.cancelLifecycle()
                self?.endBackgroundTask()
            }
        }
        guard backgroundTask != .invalid else { return }
        editor.vaultPlugin.requestLifecycle("background") { [weak self] _ in
            // A timeout/expiry is not evidence that a flush completed. Keep the
            // session and workspace alive; shared-editor retained drafts recover.
            self?.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        let task = backgroundTask
        backgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
    }
}

final class NativeVaultPicker: UITableViewController {
    private var catalog: LocalVaultCatalog?
    private var opening = false
    private var openingTicket: UUID?

    init() { super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { super.init(coder: coder) }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Zorid Vaults"
        tableView.accessibilityIdentifier = "native.vaults.list"
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Create vault", style: .plain, target: self, action: #selector(createVault))
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = "native.vaults.create"
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reloadVaults))
        navigationItem.leftBarButtonItem?.accessibilityLabel = "Refresh local vaults"
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "native.vaults.refresh"
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationItem.rightBarButtonItem?.isEnabled = !opening
        reloadVaults()
    }

    @objc private func reloadVaults() {
        do {
            if catalog == nil { catalog = try LocalVaultCatalog() } else { try catalog?.reload() }
            tableView.reloadData()
        } catch {
            // A failed identity validation clears the model; clear stale rows too.
            tableView.reloadData()
            showMessage("Local vaults unavailable", "Vault information could not be read safely. Your files have not been removed. Try refreshing local vaults.")
        }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { catalog?.vaults.count ?? 0 }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        "Vaults are stored on this device in Documents/Vaults. Create a vault to get started. Cloud folders and external providers are not available yet."
    }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        if let vault = catalog?.vaults[indexPath.row] {
            cell.textLabel?.text = vault.name
            cell.detailTextLabel?.text = "On this device"
            cell.accessibilityIdentifier = "native.vaults.item.\(vault.id.uuidString)"
        }
        cell.textLabel?.adjustsFontForContentSizeCategory = true
        cell.detailTextLabel?.adjustsFontForContentSizeCategory = true
        cell.accessoryType = .disclosureIndicator
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let vault = catalog?.vaults[indexPath.row] else { return }
        open(vault)
    }

    @objc private func createVault() {
        guard !opening, catalog != nil else { return }
        let alert = UIAlertController(title: "Create local vault", message: "Choose a name for a vault stored on this device.", preferredStyle: .alert)
        alert.addTextField {
            $0.placeholder = "Vault name"
            $0.accessibilityLabel = "Vault name"
            $0.accessibilityIdentifier = "native.vaults.name"
            $0.autocapitalizationType = .words
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Create", style: .default) { [weak self, weak alert] _ in
            guard let self = self else { return }
            do {
                guard let catalog = self.catalog else { return }
                let vault = try catalog.create(name: alert?.textFields?.first?.text ?? "")
                self.tableView.reloadData()
                self.open(vault)
            } catch {
                self.showMessage("Could not create vault", "Use a name between 1 and 80 characters. Check that device storage is available, then try again.")
            }
        })
        present(alert, animated: true)
    }

    private func open(_ vault: LocalVault) {
        guard !opening, let catalog = catalog, let navigation = navigationController,
              navigation.topViewController === self else { return }
        if let alert = presentedViewController as? UIAlertController {
            alert.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in self?.open(vault) }
            return
        }
        guard presentedViewController == nil else { return }
        opening = true
        let ticket = UUID()
        openingTicket = ticket
        navigationItem.rightBarButtonItem?.isEnabled = false
        navigationItem.backButtonTitle = "Vaults"
        let destination = NativeVaultOpeningController(vault: vault, root: { try catalog.root(for: vault) }) { [weak self] in
            guard let self = self, self.openingTicket == ticket else { return }
            self.openingTicket = nil; self.opening = false
            self.navigationItem.rightBarButtonItem?.isEnabled = true
        }
        navigation.pushViewController(destination, animated: !UIAccessibility.isReduceMotionEnabled)
    }
}

// This route exists before storage work starts. Only this controller owns its
// pending host; a pop/changed route never lends that host to another destination.
private final class NativeVaultOpeningController: UIViewController {
    private let vault: LocalVault
    private let resolveRoot: () throws -> URL
    private var hosting: UIHostingController<AnyView>?
    private var observers: [NSObjectProtocol] = []
    private var attempt = 0
    private var started = false
    private var abandoned = false
    private var replacing = false
    private var visible = false
    private var waitingForTransition = false
    private var received: (session: NativeMobileSession, root: URL)?
    private var failure: String?
    private var openPending = false
    private var reservationFinished: (() -> Void)?

    init(vault: LocalVault, root: @escaping () throws -> URL, reservationFinished: @escaping () -> Void) {
        self.vault = vault; resolveRoot = root
        self.reservationFinished = reservationFinished
        super.init(nibName: nil, bundle: nil)
        title = vault.name
    }
    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        view.accessibilityIdentifier = "native.vault.opening"
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        hosting = host; addChild(host); view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([host.view.topAnchor.constraint(equalTo: safe.topAnchor),
            host.view.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            host.view.bottomAnchor.constraint(equalTo: safe.bottomAnchor)])
        host.didMove(toParent: self); render()
        for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.scheduleSettlement() })
        }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: false)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); visible = true
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
        scheduleSettlement()
    }
    override func viewWillDisappear(_ animated: Bool) {
        visible = false; super.viewWillDisappear(animated)
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !replacing, navigationController?.topViewController !== self { abandon() }
    }
    private var current: Bool {
        !abandoned && visible && navigationController?.topViewController === self
            && viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive
            && UIApplication.shared.applicationState == .active && presentedViewController == nil
    }
    private func scheduleSettlement() {
        DispatchQueue.main.async { [weak self] in self?.settle() }
    }
    private func settle() {
        guard current, let navigation = navigationController else { return }
        if !started { begin(); return }
        guard let received = received else { return }
        if let transition = navigation.transitionCoordinator {
            guard !waitingForTransition else { return }
            waitingForTransition = true
            transition.animate(alongsideTransition: nil) { [weak self] _ in
                self?.waitingForTransition = false; self?.scheduleSettlement()
            }
            return
        }
        guard navigation.viewControllers.last === self else { return }
        self.received = nil; replacing = true
        var stack = navigation.viewControllers
        stack[stack.count - 1] = NativePagesController(vault: vault, root: received.root, session: received.session)
        navigation.setViewControllers(stack, animated: false)
        finishReservation()
    }
    private func begin() {
        guard current, !started else { return }
        started = true; attempt += 1
        let ticket = attempt
        do {
            let root = try resolveRoot()
            openPending = true
            // Keep cleanup ownership through the reply and, after Back, close ACK.
            // Open/close completions retain this loader only while work is outstanding;
            // its stored reservation callback captures the picker weakly.
            NativeMobileSession.open(vault: vault, root: root) { [self] result in
                openPending = false
                guard !abandoned, attempt == ticket else {
                    if case .success(let session) = result {
                        session.close { [self] in finishReservation() }
                    } else { finishReservation() }
                    return
                }
                switch result {
                case .success(let session): self.received = (session, root)
                case .failure:
                    self.failure = "The local vault could not be opened. Your files remain on this device. Try again when device storage is available."
                    self.render()
                }
                self.scheduleSettlement()
            }
        } catch {
            failure = "This local vault folder is unavailable. Return to Vaults or try again."
            render()
        }
    }
    private func retry() {
        guard current, failure != nil else { return }
        failure = nil; started = false; render(); scheduleSettlement()
    }
    private func render() {
        hosting?.rootView = AnyView(ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let message = failure {
                    Text("Could not open vault").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                    Text(message).fixedSize(horizontal: false, vertical: true)
                    Button("Retry") { [weak self] in self?.retry() }
                        .buttonStyle(.borderedProminent).accessibilityIdentifier("native.vault.open.retry")
                } else { NativeLoadingSkeleton(editor: false) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }.background(Color(uiColor: .systemGroupedBackground)))
    }
    private func abandon() {
        guard !abandoned, !replacing else { return }
        abandoned = true; attempt += 1
        guard !openPending else { return }
        let session = received?.session; received = nil
        if let session = session { session.close { [self] in finishReservation() } }
        else { finishReservation() }
    }
    private func finishReservation() {
        let callback = reservationFinished; reservationFinished = nil
        callback?()
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        let callback = reservationFinished
        if let session = received?.session { session.close { callback?() } }
        else { callback?() }
    }

}

private extension UIViewController {
    func showMessage(_ title: String, _ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}
