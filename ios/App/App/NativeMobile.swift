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

    // Document tabs retain only local catalog identity. Resolve the current root
    // on every activation; the opened Rust session separately validates its store
    // identity and the stable file ID before a launch path can be used.
    func resolve(vaultID: UUID) throws -> (LocalVault, URL) {
        try reload()
        guard let vault = vaults.first(where: { $0.id == vaultID }) else { throw MobileFailure.metadata }
        return (vault, try root(for: vault))
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
    private var nativeAdmission: NativeSessionAdmission? // Static worker only, never web context.
    private var nativeRequestId: UInt64 = 0
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

    // NativePages lends this same host exclusively. No new host or renderer
    // authority is created; row actions and imports share these fixed wrappers.
    func acquireNativeAdmission(expectedStoreId: String, completion: @escaping (Result<NativeSessionAdmission, Error>) -> Void) {
        Self.worker.async {
            let result: Result<NativeSessionAdmission, Error>
            if self.nativeAdmission != nil {
                result = .failure(NativeSessionOperationFailure(code: "native_busy", commitUncertain: false, sessionFenced: false))
            } else {
                do {
                    guard UUID(uuidString: expectedStoreId)?.uuidString.lowercased() == expectedStoreId else { throw MobileFailure.invalidFrame }
                    let object = try self.nativeCommandOnWorker(["method": "claim_client", "client_id": self.vault.clientId])
                    guard let lease = object["lease"] as? [String: String],
                          Set(lease.keys) == Set(["local_store_id", "client_id", "token"]),
                          lease["local_store_id"] == expectedStoreId, lease["client_id"] == self.vault.clientId,
                          let token = lease["token"], UUID(uuidString: token)?.uuidString.lowercased() == token else { throw MobileFailure.invalidFrame }
                    let admission = NativeSessionAdmission(localStoreId: expectedStoreId, clientId: self.vault.clientId, token: token)
                    self.nativeAdmission = admission; result = .success(admission)
                } catch {
                    // A claim reply can be lost after admission. Fence even a
                    // rejected claim here so no invisible lease survives return.
                    self.closeOnWorker()
                    result = .failure(NativeSessionOperationFailure(code: "native_admission_failed", commitUncertain: true, sessionFenced: true))
                }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func releaseNativeAdmission(_ admission: NativeSessionAdmission, completion: @escaping (Result<Void, Error>) -> Void) {
        Self.worker.async {
            let result: Result<Void, Error>
            if self.nativeAdmission != admission {
                // A late duplicate release owns no authority over a newer loan.
                result = .failure(NativeSessionOperationFailure(code: "native_admission_stale", commitUncertain: false, sessionFenced: self.handle == nil))
            } else { do {
                let object = try self.nativeCommandOnWorker(["method": "release_client", "reference": admission.wireReference])
                guard Self.nativeTrue(object["released"]), let reference = object["reference"] as? [String: String],
                      reference == admission.wireReference else { throw MobileFailure.invalidFrame }
                self.nativeAdmission = nil; result = .success(())
            } catch {
                // Unknown release must never re-enable an editor on this host.
                self.closeOnWorker()
                result = .failure(NativeSessionOperationFailure(code: "native_release_failed", commitUncertain: true, sessionFenced: true))
            } }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func fenceNativeAdmission(_ admission: NativeSessionAdmission, completion: @escaping (Result<Void, Error>) -> Void) {
        Self.worker.async {
            let result: Result<Void, Error>
            if self.nativeAdmission == admission {
                self.closeOnWorker(); result = .success(())
            } else {
                // Never close a new/foreign loan using an old captured tuple.
                result = .failure(NativeSessionOperationFailure(code: "native_admission_stale", commitUncertain: false, sessionFenced: self.handle == nil))
            }
            DispatchQueue.main.async { completion(result) }
        }
    }
    private static func nativeTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID() && number.boolValue
    }
    private func nativeCommandOnWorker(_ command: [String: Any]) throws -> [String: Any] {
        dispatchPrecondition(condition: .onQueue(Self.worker))
        guard let handle = handle else { throw MobileFailure.unavailable }
        guard nativeRequestId < UInt64.max else { throw MobileFailure.unavailable }
        nativeRequestId += 1
        let id = String(nativeRequestId)
        let header = try JSONSerialization.data(withJSONObject: ["version": 1, "request_id": id, "command": command])
        guard header.count <= 8192 else { throw MobileFailure.invalidFrame }
        var frame = Data(), length = UInt32(header.count).bigEndian, zero: UInt32 = 0
        withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
        withUnsafeBytes(of: &zero) { frame.append(contentsOf: $0) }; frame.append(header)
        let reply = frame.withUnsafeBytes { bytes in
            zorid_mobile_request(handle, bytes.bindMemory(to: UInt8.self).baseAddress, frame.count)
        }
        defer { zorid_mobile_buffer_free(reply) }
        guard reply.len >= 8, reply.len <= Self.headerLimit + 8, let pointer = reply.data else { throw MobileFailure.invalidFrame }
        let bytes = UnsafeBufferPointer(start: pointer, count: reply.len)
        let headerCount = (0..<4).reduce(0) { ($0 << 8) | Int(bytes[$1]) }
        guard (4..<8).allSatisfy({ bytes[$0] == 0 }), headerCount == reply.len - 8 else { throw MobileFailure.invalidFrame }
        let object = try Self.validateHeader(Data(bytes: pointer.advanced(by: 8), count: headerCount))
        guard let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              object["request_id"] as? String == id, Self.nativeTrue(object["ok"]),
              let result = object["result"] as? [String: Any] else { throw MobileFailure.invalidFrame }
        return result
    }

    // Owns the native source FD until begin returns on this queue; Rust duplicates
    // it synchronously. Neither the descriptor nor token is exposed to Capacitor.
    func beginNativeImport(owningSourceFD: Int32, selection: NativeImportSelection, admission: NativeSessionAdmission,
                           completion: @escaping (Result<NativeImportProgress, Error>) -> Void) {
        Self.worker.async {
            defer { if owningSourceFD >= 0 { Darwin.close(owningSourceFD) } }
            let result: Result<NativeImportProgress, Error>
            do {
                let data = try JSONEncoder().encode(selection)
                guard var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      selection.clientId == admission.clientId, selection.localStoreId == admission.localStoreId else { throw NativeImportFailure.invalidJournal }
                object["leaseToken"] = admission.token // Ephemeral, never written back to the journal.
                let wire = try JSONSerialization.data(withJSONObject: object)
                guard wire.count <= 8192 else { throw NativeImportFailure.invalidJournal }
                result = .success(try self.importOnWorker(admission, operationId: selection.operationId) { handle in
                    wire.withUnsafeBytes { bytes in
                        zorid_mobile_import_begin(handle, owningSourceFD, bytes.bindMemory(to: UInt8.self).baseAddress, wire.count)
                    }
                })
            } catch { result = .failure(error) }
            DispatchQueue.main.async { completion(result) }
        }
    }
    func stepNativeImport(_ operationId: String, admission: NativeSessionAdmission, completion: @escaping (Result<NativeImportProgress, Error>) -> Void) {
        nativeImportAction(operationId, admission: admission, action: zorid_mobile_import_step, completion: completion)
    }
    func statusNativeImport(_ operationId: String, admission: NativeSessionAdmission, completion: @escaping (Result<NativeImportProgress, Error>) -> Void) {
        nativeImportAction(operationId, admission: admission, action: zorid_mobile_import_status, completion: completion)
    }
    func cancelNativeImport(_ operationId: String, admission: NativeSessionAdmission, completion: @escaping (Result<NativeImportProgress, Error>) -> Void) {
        nativeImportAction(operationId, admission: admission, action: zorid_mobile_import_cancel, completion: completion)
    }
    private func nativeImportAction(_ operationId: String, admission: NativeSessionAdmission,
        action: @escaping (OpaquePointer?, UnsafePointer<UInt8>?, Int) -> ZoridBuffer,
        completion: @escaping (Result<NativeImportProgress, Error>) -> Void) {
        Self.worker.async {
            let result = Result {
                guard UUID(uuidString: operationId)?.uuidString.lowercased() == operationId else { throw NativeImportFailure.invalidJournal }
                let data = Data(operationId.utf8)
                return try self.importOnWorker(admission, operationId: operationId) { handle in
                    data.withUnsafeBytes { bytes in action(handle, bytes.bindMemory(to: UInt8.self).baseAddress, data.count) }
                }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }
    private func importOnWorker(_ admission: NativeSessionAdmission, operationId: String,
                                action: (OpaquePointer) -> ZoridBuffer) throws -> NativeImportProgress {
        dispatchPrecondition(condition: .onQueue(Self.worker))
        guard nativeAdmission == admission, let handle = handle else {
            throw NativeSessionOperationFailure(code: "native_admission_stale", commitUncertain: false, sessionFenced: self.handle == nil)
        }
        do { return try Self.consumeImportReply(action(handle), operationId: operationId) }
        catch let error as NativeSessionOperationFailure { throw error } // Valid bounded business error.
        catch {
            // consumeImportReply has already freed the exact returned slice.
            closeOnWorker()
            throw NativeSessionOperationFailure(code: "native_import_transport", commitUncertain: true, sessionFenced: true)
        }
    }
    private static func consumeImportReply(_ buffer: ZoridBuffer, operationId: String) throws -> NativeImportProgress {
        defer { zorid_mobile_buffer_free(buffer) }
        guard buffer.len > 0, buffer.len <= 65536, let pointer = buffer.data else { throw NativeImportFailure.invalidReply }
        return try decodeNativeImportReply(Data(bytes: pointer, count: buffer.len), operationId: operationId)
    }
    // Pure DTO boundary for focused source tests; no session/lease/FD authority.
    static func decodeNativeImportReply(_ data: Data, operationId: String) throws -> NativeImportProgress {
        guard !data.isEmpty, data.count <= 65536, String(data: data, encoding: .utf8) != nil,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let ok = nativeBoolean(object["ok"]) else { throw NativeImportFailure.invalidReply }
        if !ok {
            guard Set(object.keys) == Set(["version", "ok", "error"]), let error = object["error"] as? [String: Any],
                  Set(error.keys) == Set(["code", "commit_uncertain"]), let code = error["code"] as? String,
                  code.range(of: "^[a-z_]{1,64}$", options: .regularExpression) != nil,
                  let uncertain = nativeBoolean(error["commit_uncertain"]) else { throw NativeImportFailure.invalidReply }
            throw NativeSessionOperationFailure(code: code, commitUncertain: uncertain, sessionFenced: false)
        }
        guard Set(object.keys) == Set(["version", "ok", "result"]), let result = object["result"] as? [String: Any],
              Set(result.keys) == Set(["operationId", "state", "processedBytes", "totalBytes", "selectedPath", "commitState", "projectionState", "canRetryCollision"]),
              nativeBoolean(result["canRetryCollision"]) != nil else { throw NativeImportFailure.invalidReply }
        let progress = try JSONDecoder().decode(NativeImportProgress.self, from: JSONSerialization.data(withJSONObject: result))
        guard progress.operationId == operationId,
              let processed = UInt64(progress.processedBytes), String(processed) == progress.processedBytes,
              let total = UInt64(progress.totalBytes), String(total) == progress.totalBytes,
              processed <= total, total <= NativeImportStaging.fileLimit,
              progress.canRetryCollision == (progress.state == .collision),
              progress.state != .collision || progress.commitState == .rejected,
              progress.state != .committed || (progress.commitState == .committed && progress.projectionState != .not_started),
              progress.state != .aborted || progress.commitState == .aborted else { throw NativeImportFailure.invalidReply }
        if let path = progress.selectedPath {
            guard !path.isEmpty, path.utf8.count <= 4096, !path.hasPrefix("/"), !path.contains("\\"),
                  !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { throw NativeImportFailure.invalidReply }
        }
        return progress
    }
    private static func nativeBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private func closeOnWorker() {
        dispatchPrecondition(condition: .onQueue(Self.worker))
        if let handle = handle {
            self.handle = nil
            self.nativeAdmission = nil
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
    // A terminal fact about this exact source, never permission to navigate.
    struct DocumentTabRetirementReceipt {
        let sourceOwnerID: UUID
        fileprivate let containerID: ObjectIdentifier
        fileprivate let sessionID: ObjectIdentifier
        fileprivate let closeTicket: UUID
    }

    private let session: NativeMobileSession
    private let editor: NativeEditorBridge
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var leaving = false
    private let originTitle: String
    private let onClosed: () -> Void
    var onNoteOpened: ((String) -> Void)?
    var onDocumentValidated: ((NativeTabDocument) -> Void)?
    // Factories must weakly capture root/container and recheck their exact owner.
    var onShowDocumentTabs: (() -> Void)? { didSet { installNativeNavigationControls() } }
    var onReturnToNativePages: (() -> Void)? { didSet { installNativeNavigationControls() } }
    private var returnToPagesItem: UIBarButtonItem?
    private var showDocumentTabsItem: UIBarButtonItem?
    private var documentSourceOwnerID: UUID?
    private var documentOwnerIsCurrent: (() -> Bool)?
    private var closeTicket: UUID?
    private var closeReceiptEpoch = UUID()
    private var retirementReceipt: DocumentTabRetirementReceipt?
    private var closeAcknowledged = false
    private var closed = false
    private var backgroundHandled = false
    private var backgroundObservers: [NSObjectProtocol] = []
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
        installNativeNavigationControls()
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
        installBackgroundObservers()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        view.setNeedsLayout()
        updateToolbarLayout()
        updateRouteControls()
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
            self.updateRouteControls()
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
        for observer in backgroundObservers { NotificationCenter.default.removeObserver(observer) }
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
        showDocumentTabsItem?.isEnabled = rootNavigationIsCurrent && onShowDocumentTabs != nil
        returnToPagesItem?.isEnabled = documentTabsConfigured
            ? rootNavigationIsCurrent && onReturnToNativePages != nil
            : (!leaving && currentDocumentOwner(requiresVisible: true)) || legacyClosedReturnIsCurrent
    }

    private var documentTabsConfigured: Bool {
        documentSourceOwnerID != nil || onShowDocumentTabs != nil || onReturnToNativePages != nil
    }

    private var rootNavigationIsCurrent: Bool {
        !leaving && documentSourceOwnerID != nil && documentOwnerIsCurrent?() == true
            && currentDocumentOwner(requiresVisible: true)
    }

    private var legacyClosedReturnIsCurrent: Bool {
        !documentTabsConfigured && closed && closeAcknowledged
            && UIApplication.shared.applicationState == .active
            && owningScene?.activationState == .foregroundActive
            && viewIfLoaded?.window != nil && navigationController?.topViewController === self
            && presentedViewController == nil
    }

    private func installNativeNavigationControls() {
        guard isViewLoaded else { return }
        let done = UIBarButtonItem(title: originTitle, style: .plain, target: self, action: #selector(returnToVaults))
        done.accessibilityIdentifier = "native.editor.vaults"
        done.accessibilityLabel = "Return to " + originTitle
        returnToPagesItem = done
        if onShowDocumentTabs != nil {
            let tabs = UIBarButtonItem(image: UIImage(systemName: "square.on.square"), style: .plain,
                                       target: self, action: #selector(showDocumentTabs))
            tabs.accessibilityIdentifier = "native.editor.showTabs"
            tabs.accessibilityLabel = "Show tabs"
            showDocumentTabsItem = tabs
            navigationItem.rightBarButtonItems = [tabs, done]
        } else {
            showDocumentTabsItem = nil
            navigationItem.rightBarButtonItems = [done]
        }
        updateRouteControls()
    }

    @objc private func showDocumentTabs() {
        guard rootNavigationIsCurrent, navigationController?.transitionCoordinator == nil else { return }
        onShowDocumentTabs?()
    }

    @objc private func returnToVaults() {
        if documentTabsConfigured {
            guard rootNavigationIsCurrent, navigationController?.transitionCoordinator == nil else { return }
            onReturnToNativePages?()
            return
        }
        leaveForNativeRoute { _ in }
    }

    // Root supplies a weak identity/lifetime-only container/session/owner check.
    // It must remain true while covered, transitioning or backgrounded; this
    // container applies foreground/visibility requirements per operation.
    // This UUID is presentation authority only, never a Rust lease credential.
    func configureDocumentTabOwner(sourceOwnerID: UUID, isCurrent: @escaping () -> Bool) {
        guard !leaving, !closed else { return }
        editor.vaultPlugin.invalidateDocumentValidation()
        retirementReceipt = nil
        documentSourceOwnerID = sourceOwnerID
        documentOwnerIsCurrent = isCurrent
        if isViewLoaded { updateRouteControls() }
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

    // Query the retained source even after background/stale navigation failure.
    // Root must match its source container + owner, retire it, then await an
    // explicit foreground intent. A nil receipt does not establish retirement.
    func documentTabRetirementReceipt(sourceOwnerID: UUID) -> DocumentTabRetirementReceipt? {
        guard closed, documentSourceOwnerID == sourceOwnerID,
              let receipt = retirementReceipt, receipt.sourceOwnerID == sourceOwnerID,
              receipt.containerID == ObjectIdentifier(self),
              receipt.sessionID == ObjectIdentifier(session) else { return nil }
        return receipt
    }

    // Both routes use the same save/ACK/close fence; only this wrapper navigates.
    func leaveForNativeRoute(completion: @escaping (Bool) -> Void) {
        // Configured routing belongs to root, including history. A partial hook
        // installation must never silently fall back to closing/popping locally.
        guard !documentTabsConfigured else { completion(false); return }
        if closed {
            guard legacyClosedReturnIsCurrent, navigationController?.transitionCoordinator == nil else { completion(false); return }
            completion(true)
            // An explicit foreground return may retire an already-closed legacy
            // route. Do not save/close again or notify onClosed a second time.
            if legacyClosedReturnIsCurrent, navigationController?.transitionCoordinator == nil {
                navigationController?.popViewController(animated: !UIAccessibility.isReduceMotionEnabled)
            }
            return
        }
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
        let sourceOwnerID = documentSourceOwnerID
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
            closeAcknowledged = true
            session.close { [self] in
                let stillCurrent = admitted && closeTicket == ticket && closeReceiptEpoch == epoch && isCurrent()
                closeTicket = nil
                loadingTimeout?.cancel()
                if let sourceOwnerID = sourceOwnerID {
                    retirementReceipt = DocumentTabRetirementReceipt(sourceOwnerID: sourceOwnerID,
                        containerID: ObjectIdentifier(self), sessionID: ObjectIdentifier(session), closeTicket: ticket)
                }
                if !closed { closed = true; onClosed() }
                updateRouteControls()
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

    private var owningScene: UIWindowScene? {
        navigationController?.viewIfLoaded?.window?.windowScene ?? viewIfLoaded?.window?.windowScene
    }

    private func installBackgroundObservers() {
        for name in [UIScene.didEnterBackgroundNotification, UIApplication.didEnterBackgroundNotification] {
            backgroundObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self else { return }
                if notification.name == UIScene.didEnterBackgroundNotification {
                    guard let scene = notification.object as? UIWindowScene, self.owningScene === scene else { return }
                } else {
                    guard self.owningScene?.activationState == .background else { return }
                }
                self.enterBackground()
            })
        }
        for name in [UIScene.didActivateNotification, UIApplication.didBecomeActiveNotification] {
            backgroundObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let self = self else { return }
                if notification.name == UIScene.didActivateNotification {
                    guard let scene = notification.object as? UIWindowScene, self.owningScene === scene else { return }
                }
                guard self.owningScene?.activationState == .foregroundActive else { return }
                self.backgroundHandled = false
                self.updateRouteControls()
            })
        }
    }

    func enterBackground() {
        closeReceiptEpoch = UUID()
        editor.vaultPlugin.invalidateDocumentValidation()
        editor.vaultPlugin.resetEditorState()
        // SceneDelegate and app/scene notifications may all reach this source.
        // Every delivery invalidates receipts, but only one starts a checkpoint.
        guard !closed, !closeAcknowledged else { return }
        if documentSourceOwnerID != nil {
            guard documentOwnerIsCurrent?() == true else { return }
        } else {
            guard navigationController?.topViewController === self else { return }
        }
        guard !backgroundHandled else { return }
        backgroundHandled = true
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
    private var openingTicket: UUID?
    private var documentTabs: NativeDocumentTabCoordinator?
    private var destinationFactory: NativeTabDestinationFactory?
    private weak var boundPages: NativePagesController?
    private var boundPagesOwner: UUID?
    private var lastVaultID: UUID?

    private func ensureDocumentTabs() throws -> NativeDocumentTabCoordinator {
        if let existing = documentTabs { return existing }
        let key = "native.document-tabs.v1"
        let model = NativeDocumentTabs(restoring: UserDefaults.standard.data(forKey: key))
        let factory = NativeTabDestinationFactory(resolveVault: { [weak self] id in
            guard let self = self, let catalog = self.catalog else { throw MobileFailure.metadata }
            let resolved = try catalog.resolve(vaultID: id)
            self.lastVaultID = id
            return resolved
        }, admissionReady: { [weak self] in self?.documentTabs?.canPrepareDestination == true },
        chooseFile: { [weak self] tabID in
            guard let self = self, let tabs = self.documentTabs, tabs.model.selectedTabID == tabID,
                  let presenter = self.navigationController?.topViewController else { return }
            self.routeToPages(from: presenter, vaultID: nil)
        }, validatedDocument: { [weak self] document, owner in
            do { try self?.documentTabs?.bindValidatedDocument(document, sourceOwnerID: owner) }
            catch {
                // Let the current native validation/history callback finish
                // before a modal changes its foreground/visibility witness.
                DispatchQueue.main.async { [weak self] in
                    self?.navigationController?.topViewController?.showMessage("Tab information needs attention", "Your document stays open. Open Show tabs to retry its tab information.")
                }
            }
        }, showTabs: { [weak self] presenter in self?.documentTabs?.showDocumentTabs(from: presenter) },
        returnToNativePages: { [weak self] presenter in
            guard let self = self else { return }
            self.routeToPages(from: presenter, vaultID: self.lastVaultID)
        })
        destinationFactory = factory
        let coordinator = NativeDocumentTabCoordinator(model: model, persist: { data in
            UserDefaults.standard.set(data, forKey: key)
        }, activate: { [weak factory] tab, owner, done in
            guard let factory = factory else { done(.failure(MobileFailure.unavailable)); return }
            factory.prepare(tab, ownerID: owner, completion: done)
        }, didInstall: { [weak factory] owner, tab, controller in
            factory?.didInstall(ownerID: owner, tabID: tab, controller: controller) == true
        }, recoverActivation: { [weak factory] owner, done in
            guard let factory = factory else { done(.failure(MobileFailure.unavailable)); return }
            factory.recoverReservation(owner, completion: done)
        })
        documentTabs = coordinator
        return coordinator
    }

    private func bindPages(_ pages: NativePagesController, vault: LocalVault) throws {
        let tabs = try ensureDocumentTabs()
        let owner = UUID()
        boundPages = pages; boundPagesOwner = owner; lastVaultID = vault.id
        let current: () -> Bool = { [weak self, weak pages] in
            guard let self = self, let pages = pages else { return false }
            return self.boundPages === pages && self.boundPagesOwner == owner
        }
        pages.onShowDocumentTabs = { [weak self, weak pages] in
            guard let self = self, let pages = pages, current() else { return }
            self.documentTabs?.showDocumentTabs(from: pages)
        }
        pages.onOpenDocument = { [weak self, weak pages] entry, inNewTab in
            guard let self = self, let pages = pages, current() else { return }
            do {
                let document = try pages.documentTabDocument(for: entry)
                self.documentTabs?.performDocumentTabIntent(inNewTab ? .openInNewTab(document) : .replaceSelected(document))
                if let tabs = self.documentTabs, !tabs.isBusy,
                   pages.navigationController?.topViewController === pages, let message = tabs.message {
                    pages.showMessage("Could not open file", message)
                }
            } catch { pages.showMessage("File changed", "This file is no longer available from the current list. Refresh Files and try again.") }
        }
        pages.onChooseVault = { [weak self, weak pages] in
            guard let self = self, let pages = pages, current(),
                  let presenter = pages.navigationController?.topViewController else { return }
            self.routeToPages(from: presenter, vaultID: nil)
        }
        // New Note requires a durable Rust creation request before an existing
        // entry is launched. A missing callback remains explicitly unavailable;
        // it must never fall back to replaying web createNoteOnOpen.
        let source = NativeDocumentTabCoordinator.Source(role: .pages, ownerID: owner,
            tabID: tabs.model.selectedTabID, resolvedDocument: nil, controller: pages, isCurrent: current,
            close: { [weak self, weak pages] requestedOwner, done in
                guard let pages = pages, requestedOwner == owner, current() else { done(.failure(MobileFailure.unavailable)); return }
                pages.prepareForDocumentTabTransition { result in
                    if pages.documentTabTransitionRetired, self?.boundPagesOwner == owner {
                        self?.boundPages = nil; self?.boundPagesOwner = nil
                    }
                    done(result)
                }
            }, resume: { [weak pages] in pages?.resumeAfterDocumentTabOverview() },
            hasTerminalRetirementReceipt: { [weak pages] in pages?.documentTabTransitionRetired == true })
        do { try tabs.bindSource(source) }
        catch {
            if boundPagesOwner == owner { boundPages = nil; boundPagesOwner = nil }
            throw error
        }
    }

    private func routeToPages(from presenter: UIViewController, vaultID: UUID?) {
        guard let tabs = documentTabs else { return }
        tabs.performNativeRoute(from: presenter, retry: { [weak self] in
            guard let self = self, let current = self.navigationController?.topViewController else { return }
            self.routeToPages(from: current, vaultID: vaultID)
        }) { [weak self] result in
            guard let self = self, let navigation = self.navigationController else { return }
            switch result {
            case .failure:
                // Coordinator restored the live page or exposed its own native
                // recovery route. A retired source is never described as open.
                break
            case .success:
                navigation.popToRootViewController(animated: false)
                guard let vaultID = vaultID else { return }
                do {
                    guard let catalog = self.catalog else { throw MobileFailure.metadata }
                    let (vault, _) = try catalog.resolve(vaultID: vaultID)
                    self.open(vault)
                } catch { self.showMessage("Vault unavailable", "Choose an available vault to continue.") }
            }
        }
    }


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
        guard !opening, documentTabs?.canEnterVault != false,
              let catalog = catalog, let navigation = navigationController,
              navigation.topViewController === self else { return }
        if let alert = presentedViewController as? UIAlertController {
            alert.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in self?.open(vault) }
            return
        }
        guard presentedViewController == nil else { return }
        let ticket = UUID()
        do { try ensureDocumentTabs().beginVaultOpening(ticket) }
        catch { showMessage("Session is finishing", "Wait for the current document session to finish before opening another vault."); return }
        opening = true
        openingTicket = ticket
        navigationItem.rightBarButtonItem?.isEnabled = false
        navigationItem.backButtonTitle = "Vaults"
        let destination = NativeVaultOpeningController(vault: vault, root: { try catalog.root(for: vault) },
            preparePages: { [weak self] pages in
                guard let self = self else { throw MobileFailure.unavailable }
                try self.bindPages(pages, vault: vault)
            }) { [weak self] in
            guard let self = self, self.openingTicket == ticket else { return }
            self.documentTabs?.finishVaultOpening(ticket)
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
    private let preparePages: (NativePagesController) throws -> Void
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

    init(vault: LocalVault, root: @escaping () throws -> URL,
         preparePages: @escaping (NativePagesController) throws -> Void,
         reservationFinished: @escaping () -> Void) {
        self.vault = vault; resolveRoot = root; self.preparePages = preparePages
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
        let pages = NativePagesController(vault: vault, root: received.root, session: received.session)
        do { try preparePages(pages) }
        catch {
            self.received = nil; openPending = true
            received.session.close { [self] in
                openPending = false
                failure = "The previous document session must finish closing before this vault can open."
                render()
                if abandoned { finishReservation() }
            }
            return
        }
        self.received = nil; replacing = true
        var stack = navigation.viewControllers
        stack[stack.count - 1] = pages
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
