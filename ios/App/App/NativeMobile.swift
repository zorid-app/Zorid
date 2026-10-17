import UIKit
import Capacitor
import Darwin

// Native owns roots and session lifetime; all storage/sync commands remain in Rust.
private enum MobileFailure: Error {
    case unavailable, invalidFrame, metadata
}

private struct LocalVault: Codable {
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

private final class NativeMobileSession {
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

@objc(NativeVaultPlugin)
final class NativeVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeVaultPlugin"
    let jsName = "NativeVault"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "context", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lifecycleAck", returnType: CAPPluginReturnPromise)
    ]
    private let session: NativeMobileSession
    private var pending: (id: String, reason: String, completion: (Bool) -> Void)?
    private var timeout: DispatchWorkItem?
    private var closeAuthorized = false

    fileprivate init(session: NativeMobileSession) {
        self.session = session
        super.init()
    }

    // Capacitor invokes plugin methods on its own queue. Keep listener mutation
    // on main too, so UIKit requests cannot race inherited listener operations.
    override func addListener(_ call: CAPPluginCall) {
        if Thread.isMainThread { super.addListener(call) }
        else { DispatchQueue.main.sync { self.addListener(call) } }
    }

    override func removeListener(_ call: CAPPluginCall) {
        if Thread.isMainThread { super.removeListener(call) }
        else { DispatchQueue.main.sync { self.removeListener(call) } }
    }

    override func removeAllListeners(_ call: CAPPluginCall) {
        if Thread.isMainThread { super.removeAllListeners(call) }
        else { DispatchQueue.main.sync { self.removeAllListeners(call) } }
    }

    @objc func context(_ call: CAPPluginCall) {
        session.context { call.resolve($0) }
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

private final class NativeEditorBridge: CAPBridgeViewController {
    let vaultPlugin: NativeVaultPlugin

    init(session: NativeMobileSession) {
        vaultPlugin = NativeVaultPlugin(session: session)
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

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(vaultPlugin)
        webView?.accessibilityIdentifier = "native.editor.webview"
    }
}

final class NativeEditorContainer: UIViewController {
    private let session: NativeMobileSession
    private let editor: NativeEditorBridge
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var leaving = false

    fileprivate init(session: NativeMobileSession) {
        self.session = session
        editor = NativeEditorBridge(session: session)
        super.init(nibName: nil, bundle: nil)
        title = session.vault.name
    }

    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "native.editor.container"
        navigationItem.hidesBackButton = true
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vaults", style: .plain, target: self, action: #selector(returnToVaults))
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "native.editor.vaults"
        addChild(editor)
        view.addSubview(editor.view)
        editor.view.translatesAutoresizingMaskIntoConstraints = false
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            editor.view.topAnchor.constraint(equalTo: safe.topAnchor),
            editor.view.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            editor.view.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            editor.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        editor.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }

    @objc private func returnToVaults() {
        guard !leaving else { return }
        leaving = true
        navigationItem.leftBarButtonItem?.isEnabled = false
        editor.vaultPlugin.requestLifecycle("switchVault") { [weak self] ok in
            guard let self = self else { return }
            guard ok else {
                self.leaving = false
                self.navigationItem.leftBarButtonItem?.isEnabled = true
                if UIApplication.shared.applicationState == .active {
                    self.showMessage("Vault stays open", "The editor has not confirmed that it is safe to leave. Your workspace remains open. Try again after saving is ready.")
                }
                return
            }
            self.session.close {
                self.navigationController?.popViewController(animated: true)
            }
        }
    }

    func enterBackground() {
        guard backgroundTask == .invalid else { return }
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

    private func open(_ vault: LocalVault) {
        guard !opening, let catalog = catalog else { return }
        do {
            let root = try catalog.root(for: vault)
            opening = true
            tableView.isUserInteractionEnabled = false
            navigationItem.rightBarButtonItem?.isEnabled = false
            NativeMobileSession.open(vault: vault, root: root) { [weak self] result in
                guard let self = self else {
                    if case .success(let session) = result { session.close {} }
                    return
                }
                self.opening = false
                self.tableView.isUserInteractionEnabled = true
                self.navigationItem.rightBarButtonItem?.isEnabled = true
                switch result {
                case .success(let session): self.navigationController?.pushViewController(NativeEditorContainer(session: session), animated: true)
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
