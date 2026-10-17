import UIKit
import SwiftUI
import WebKit
import Capacitor
import Darwin

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
    private static let headerLimit = 1_048_576
    private static let bodyLimit = 33_554_432

    private init(vault: LocalVault, handle: OpaquePointer, reconciliation: [String: Any]) {
        self.vault = vault
        self.handle = handle
        self.reconciliation = reconciliation
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
                    result = .success(NativeMobileSession(vault: vault, handle: pointer, reconciliation: startup.reconciliation))
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
            let context: [String: Any] = ["name": self.vault.name, "clientId": self.vault.clientId,
                                          "reconciliation": self.reconciliation]
            DispatchQueue.main.async { completion(context) }
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

    func request(header: String, body: String, completion: @escaping (Result<(String, String), Error>) -> Void) {
        Self.worker.async {
            let result: Result<(String, String), Error>
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
                let replyBody = Data(bytes: pointer.advanced(by: 8 + headerCount), count: bodyCount)
                result = .success((replyHeader, replyBody.base64EncodedString()))
            } catch {
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

    func close(completion: @escaping () -> Void) {
        Self.worker.async {
            if let handle = self.handle {
                zorid_mobile_close(handle)
                self.handle = nil
            }
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
        // Called after real web activation, never just after tapping a native row.
        session.recordNoteOpened(path: path, entryId: entryId, onValidated: { [weak self] id in self?.onNoteOpened?(id) }) { result in
            switch result {
            case .success: call.resolve()
            case .failure: call.reject("The opened note could not be recorded.", "native_history_failed")
            }
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
    var onNavigate: ((Int) -> Void)?
    private var canGoBack = false
    private var canGoForward = false
    private var historyHost: UIHostingController<NativeHistoryControls>?
    private var loadingHost: UIHostingController<NativeEditorLoadingView>?
    private var loadingTimeout: DispatchWorkItem?
    private var loadingTimer: NativePhaseTimer?
    private var loadingFinished = false
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
        editor.vaultPlugin.onNoteOpened = { [weak self] id in
            self?.finishEditorLoading(ready: true)
            self?.onNoteOpened?(id)
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

    private func updateToolbarLayout(notification: Notification? = nil) {
        guard isViewLoaded, let host = toolbarHost, let bottom = editorBottom else { return }
        let visible = toolbarModel.canAct && hasDockedSoftwareKeyboard
            && UIApplication.shared.applicationState == .active && !leaving
        let inset = visible ? (toolbarHeight?.constant ?? preferredToolbarHeight) + 8 : 0
        guard visible != toolbarVisible || bottom.constant != -inset else { return }
        toolbarVisible = visible
        // One native viewport boundary clears BOTH guide-owned keyboard space
        // and the floating toolbar. Web must not apply a second toolbar inset.
        bottom.constant = -inset
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
        let host = UIHostingController(rootView: historyControls)
        historyHost = host
        addChild(host)
        host.view.backgroundColor = .clear
        host.view.clipsToBounds = false
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.widthAnchor.constraint(equalToConstant: 96),
            host.view.heightAnchor.constraint(equalToConstant: 44)
        ])
        let item = UIBarButtonItem(customView: host.view)
        // Our single capsule supplies its own glass, not another nested bar pill.
        if #available(iOS 26, *) { item.hidesSharedBackground = true }
        navigationItem.leftBarButtonItem = item
        host.didMove(toParent: self)
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
        let timeout = DispatchWorkItem { [weak self] in self?.finishEditorLoading(ready: false) }
        loadingTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout)
    }

    private func finishEditorLoading(ready: Bool) {
        if ready {
            loadingTimer?.finish(.editorReady)
            loadingTimer = nil
        } else { loadingTimer?.finish(.editorTimeout) }
        guard !loadingFinished else { return }
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
        if ready && !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.18, animations: { host.view.alpha = 0 }) { _ in remove() }
        } else { remove() }
        if !ready && view.window != nil && UIApplication.shared.applicationState == .active {
            UIAccessibility.post(notification: .announcement, argument: "Editor is taking longer to load. Showing its current content.")
        }
    }

    func setRouteAvailability(back: Bool, forward: Bool) {
        canGoBack = back
        canGoForward = forward
        updateRouteControls()
    }

    private func updateRouteControls() {
        historyHost?.rootView = historyControls
        navigationItem.rightBarButtonItem?.isEnabled = !leaving
    }

    @objc private func returnToVaults() { leaveForNativeRoute { _ in } }

    // Both ordinary return and history traversal use the same save/ACK fence.
    // The coordinator stages a destination; a rejected ACK leaves this host live.
    func leaveForNativeRoute(completion: @escaping (Bool) -> Void) {
        guard !leaving else { completion(false); return }
        leaving = true
        editor.vaultPlugin.resetEditorState()
        updateRouteControls()
        editor.vaultPlugin.requestLifecycle("switchVault") { [weak self] ok in
            guard let self = self else { return }
            guard ok else {
                self.leaving = false
                self.updateToolbarLayout()
                self.updateRouteControls()
                completion(false)
                if UIApplication.shared.applicationState == .active {
                    self.showMessage("Vault stays open", "The editor has not confirmed that it is safe to leave. Your workspace remains open. Try again after saving is ready.")
                }
                return
            }
            self.session.close {
                self.loadingTimeout?.cancel()
                self.onClosed()
                completion(true)
                self.navigationController?.popViewController(animated: !UIAccessibility.isReduceMotionEnabled)
            }
        }
    }

    func enterBackground() {
        guard backgroundTask == .invalid else { return }
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
    private var openingHost: UIHostingController<NativeLoadingSkeleton>?

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

    private func showOpeningSkeleton() {
        let host = UIHostingController(rootView: NativeLoadingSkeleton(editor: false))
        openingHost = host
        addChild(host)
        host.view.backgroundColor = .systemBackground
        host.view.frame = CGRect(x: 0, y: 0, width: tableView.bounds.width, height: 300)
        let inset = UIView(frame: host.view.frame)
        host.view.frame = inset.bounds.insetBy(dx: 20, dy: 20)
        inset.addSubview(host.view)
        tableView.tableHeaderView = inset
        host.didMove(toParent: self)
    }

    private func removeOpeningSkeleton() {
        guard let host = openingHost else { return }
        host.willMove(toParent: nil)
        tableView.tableHeaderView = nil
        host.view.removeFromSuperview()
        host.removeFromParent()
        openingHost = nil
    }

    private func open(_ vault: LocalVault) {
        guard !opening, let catalog = catalog else { return }
        do {
            let root = try catalog.root(for: vault)
            opening = true
            showOpeningSkeleton()
            tableView.isUserInteractionEnabled = false
            navigationItem.rightBarButtonItem?.isEnabled = false
            NativeMobileSession.open(vault: vault, root: root) { [weak self] result in
                guard let self = self else {
                    if case .success(let session) = result { session.close {} }
                    return
                }
                self.opening = false
                self.removeOpeningSkeleton()
                self.tableView.isUserInteractionEnabled = true
                self.navigationItem.rightBarButtonItem?.isEnabled = true
                switch result {
                case .success(let session):
                    let pages = NativePagesController(vault: vault, root: root, session: session)
                    self.navigationController?.pushViewController(pages, animated: !UIAccessibility.isReduceMotionEnabled)
                case .failure: self.showMessage("Could not open vault", "The local vault could not be opened. Your files remain on this device. Try again when device storage is available.")
                }
            }
        } catch {
            showMessage("Vault unavailable", "This local vault folder is unavailable. Refresh the vault list and try again.")
        }
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
