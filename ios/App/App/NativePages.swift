import UIKit
import SwiftUI

// UI metadata only. Rust remains the sole authority for vault entries/content.
struct NativeFilePresentation: Decodable {
    let id: String
    let modifiedMilliseconds: UInt64
    let sizeBytes: UInt64
    enum CodingKeys: String, CodingKey {
        case id
        case modifiedMilliseconds = "mtime_ms"
        case sizeBytes = "size_bytes"
    }
}

struct NativeFileEntry: Decodable {
    enum Kind: String, Decodable { case file, folder }
    let id: String
    let path: String
    let kind: Kind
    let deleted: Bool
    var presentation: NativeFilePresentation?

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
    let reconciliationComplete: Bool
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
        let timer = NativePhaseTimer()
        let finished: (Result<NativeVaultListing, Error>) -> Void = { result in
            timer.finish(.listing)
            completion(result)
        }
        pageRead(.identity) { identityResult in
            switch identityResult {
            case .failure(let error): finished(.failure(error))
            case .success(let object):
                guard let identity = object["identity"] as? [String: Any],
                      let storeId = identity["local_store_id"] as? String, !storeId.isEmpty else {
                    finished(.failure(NativePageError.invalidResponse)); return
                }
                self.pageRead(.snapshot) { snapshotResult in
                    switch snapshotResult {
                    case .failure(let error): finished(.failure(error))
                    case .success(let snapshot):
                        do {
                            struct Row: Decodable { let state: NativeFileEntry; let presentation: NativeFilePresentation? }
                            struct Snapshot: Decodable { let entries: [Row]; let cursor: String }
                            let bytes = try JSONSerialization.data(withJSONObject: snapshot)
                            let decoded = try JSONDecoder().decode(Snapshot.self, from: bytes)
                            let entries = try decoded.entries.map { row -> NativeFileEntry in
                                if let metadata = row.presentation {
                                    guard metadata.id == row.state.id,
                                          metadata.modifiedMilliseconds <= 9_007_199_254_740_991,
                                          metadata.sizeBytes <= 9_007_199_254_740_991,
                                          row.state.kind != .folder || metadata.sizeBytes == 0 else { throw NativePageError.invalidResponse }
                                }
                                var entry = row.state
                                entry.presentation = row.presentation
                                return entry
                            }
                            guard !decoded.cursor.isEmpty, entries.allSatisfy({ !$0.deleted && NativeFileEntry.isValidEntryId($0.id) && NativeFileEntry.isValidPath($0.path) }),
                                  Set(entries.map(\.id)).count == entries.count,
                                  Set(entries.map { Data($0.path.utf8) }).count == entries.count else { throw NativePageError.invalidResponse }
                            self.context { context in
                                let reconciliation = context["reconciliation"] as? [String: Any]
                                finished(.success(NativeVaultListing(localStoreId: storeId, entries: entries.filter { NativeFileEntry.isVisiblePath($0.path) },
                                                                      reconciliationComplete: reconciliation?["complete"] as? Bool == true)))
                            }
                        } catch { finished(.failure(NativePageError.invalidResponse)) }
                    }
                }
            }
        }
    }

    func recordNoteOpened(path: String, entryId: String, onValidated: @escaping (String) -> Void = { _ in }, completion: @escaping (Result<Void, Error>) -> Void) {
        guard NativeFileEntry.isVisiblePath(path), NativeFileEntry.isValidEntryId(entryId) else {
            completion(.failure(NativePageError.invalidResponse)); return
        }
        pageListing { result in
            completion(result.flatMap { listing in
                Result {
                    guard let entry = listing.entries.first(where: { $0.id == entryId && NativeFileEntry.samePath($0.path, path) && $0.kind == .file }) else {
                        throw NativePageError.unavailable
                    }
                    // Valid activation is independent of device-local history IO.
                    onValidated(entry.id)
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

// Native presentation binding for the existing admitted Rust document API.
// Each operation owns its lease/stage/pin until cleanup ACK; nothing is lent to web.
private enum NativeSearchFailure: Error, Equatable {
    case invalid, invalidQuery, unsupported, cancelled, preparationLimit, rebuildRequired, queryFailed, cleanup
}

private struct NativeSearchHit: Decodable {
    private let witness: Witness
    var entry: NativeFileEntry {
        NativeFileEntry(id: witness.id, path: witness.path, kind: witness.kind, deleted: witness.deleted, presentation: nil)
    }
    var revision: String { witness.revision }
    private struct Witness: Decodable {
        let id: String
        let revision: String
        let path: String
        let kind: NativeFileEntry.Kind
        let deleted: Bool
    }
    private enum CodingKeys: String, CodingKey { case witness = "entry", line, range, snippet, snippetTruncated }
    let line: UInt32
    let range: Range
    let snippet: String
    let snippetTruncated: Bool
    var rowId: String { "\(entry.id):\(line)" }
    struct Range: Decodable { let bytes: [UInt32]; let utf16: [UInt32] }
}
private struct NativeSearchResult {
    let hits: [NativeSearchHit]
    let partial: Bool
}

@MainActor
private final class NativePageSearch {
    private struct Lease: Codable, Equatable {
        let local_store_id: String
        let client_id: String
        let token: String
    }
    private struct Versions: Codable, Equatable {
        let schema: UInt32
        let extraction: String
        let resolver: String
        let query: String
    }
    private struct Snapshot: Codable, Equatable {
        let localStoreId: String
        let generationEpoch: String
        let generation: String
        let versions: Versions
        func validate(store: String) throws {
            guard localStoreId == store, NativeFileEntry.isValidEntryId(generationEpoch),
                  Self.decimal(generation, positive: true), versions.schema > 0,
                  [versions.extraction, versions.resolver, versions.query].allSatisfy({ value in
                      !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
                          (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 58, 95].contains($0)
                      }
                  }) else {
                throw NativeSearchFailure.invalid
            }
        }
        static func decimal(_ value: String, positive: Bool = false) -> Bool {
            guard let number = UInt64(value), String(number) == value else { return false }
            return !positive || number > 0
        }
    }
    private struct Source: Decodable, Equatable {
        let localStoreId: String
        let watermark: String
        func validate(store: String) throws {
            guard localStoreId == store, Snapshot.decimal(watermark) else { throw NativeSearchFailure.invalid }
        }
    }
    private struct Status: Decodable {
        let source: Source
        let state: String
        let snapshot: Snapshot?
        let coveredWatermark: String?
        let observedSourceHead: String?
        let coverageComplete: Bool?
    }
    private struct Stage: Decodable { let snapshot: Snapshot }
    private struct Progress: Decodable {
        let snapshot: Snapshot
        let preparedDocuments: UInt64
        let reusedDocuments: UInt64
        let totalDocuments: UInt64
        let ready: Bool
    }
    private struct Opened: Decodable {
        let pinId: String
        let snapshot: Snapshot
        let source: Source
        let coverageComplete: Bool
    }
    private struct Page: Decodable {
        struct Query: Decodable {
            struct Value: Decodable {
                let snapshot: Snapshot
                let hits: [NativeSearchHit]
                let next: String? // Rust removes the internal continuation; only null is accepted.
                let scanComplete: Bool
                let coverageComplete: Bool
                let complete: Bool
                let sourceBytes: UInt64
                let documents: UInt64
            }
            let snapshot: Snapshot
            let source: Source
            let coverageComplete: Bool
            let value: Value
        }
        let result: Query
        let cursor: String?
    }
    private struct WireError: Decodable {
        let code: String
        let message: String
        let commit_uncertain: Bool
    }
    private struct Envelope<T: Decodable>: Decodable {
        let version: UInt32
        let request_id: String
        let ok: Bool
        let result: T?
        let error: WireError?
    }
    private struct Marker: Decodable { let documents: Bool; let schemaVersion: UInt32; let bytes: Int }
    private struct DocumentReply<T: Decodable>: Decodable { let schemaVersion: UInt32; let op: String; let value: T }
    private struct Claimed: Decodable { let lease: Lease }
    private struct Released: Decodable { let released: Bool; let reference: Lease }
    private let session: NativeMobileSession
    private let store: String
    private let active: () -> Bool
    private var lease: Lease?
    private var stage: Snapshot?
    private var pin: String?
    private var sequence: UInt64 = 0
    // Bound work even when a large vault or zero-visible-hit pages need continuation.
    private let deadline = Date().addingTimeInterval(8)

    init(session: NativeMobileSession, store: String, active: @escaping () -> Bool) {
        self.session = session; self.store = store; self.active = active
    }
    private func check() throws {
        guard active() else { throw NativeSearchFailure.cancelled }
        guard Date() < deadline else { throw NativeSearchFailure.preparationLimit }
    }
    private func object<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }
    private func wire<T: Decodable>(_ command: [String: Any], admitted: Bool, as: T.Type) async throws -> (T, Data) {
        sequence += 1
        let requestId = String(sequence)
        var outer: [String: Any] = ["version": 1, "request_id": requestId, "command": command]
        if admitted {
            guard let lease = lease else { throw NativeSearchFailure.invalid }
            outer["lease"] = try object(lease)
        }
        let bytes = try JSONSerialization.data(withJSONObject: outer)
        guard bytes.count <= 65_536, let header = String(data: bytes, encoding: .utf8) else { throw NativeSearchFailure.invalid }
        let response: (String, String) = try await withCheckedThrowingContinuation { continuation in
            session.request(header: header, body: "") { continuation.resume(with: $0) }
        }
        guard let headerBytes = response.0.data(using: .utf8),
              let body = Data(base64Encoded: response.1), body.count <= 16_777_216 else { throw NativeSearchFailure.invalid }
        let envelope = try JSONDecoder().decode(Envelope<T>.self, from: headerBytes)
        guard envelope.version == 1, envelope.request_id == requestId else { throw NativeSearchFailure.invalid }
        guard envelope.ok else {
            guard body.isEmpty, envelope.result == nil, let error = envelope.error,
                  !error.code.isEmpty, error.code.utf8.count <= 64,
                  error.code.utf8.allSatisfy({ (97...122).contains($0) || $0 == 95 }),
                  error.message.utf8.count <= 4096 else { throw NativeSearchFailure.invalid }
            if error.commit_uncertain { throw NativeSearchFailure.cleanup }
            throw NativeSearchFailure.queryFailed
        }
        guard envelope.error == nil, let value = envelope.result else { throw NativeSearchFailure.invalid }
        return (value, body)
    }
    private func document<T: Decodable>(_ op: String, _ fields: [String: Any] = [:], as: T.Type) async throws -> T {
        var command = fields; command["op"] = op
        let request: [String: Any] = ["schemaVersion": 1, "command": command]
        let (marker, body) = try await wire(["method": "documents", "client_id": session.vault.clientId, "request": request], admitted: true, as: Marker.self)
        guard marker.documents, marker.schemaVersion == 1, marker.bytes == body.count,
              String(data: body, encoding: .utf8) != nil else { throw NativeSearchFailure.invalid }
        let reply = try JSONDecoder().decode(DocumentReply<T>.self, from: body)
        guard reply.schemaVersion == 1, reply.op == op else { throw NativeSearchFailure.invalid }
        return reply.value
    }
    private func prepare() async throws -> (Snapshot, Source) {
        var status = try await document("status", as: Status.self)
        try status.source.validate(store: store)
        guard status.state != "rebuild_required" else { throw NativeSearchFailure.rebuildRequired }
        if status.state == "uninitialized" {
            guard try await document("initialize", as: Bool.self) else { throw NativeSearchFailure.invalid }
        } else if status.state == "ready" {
            guard let snapshot = status.snapshot, let covered = status.coveredWatermark,
                  let observed = status.observedSourceHead, status.coverageComplete != nil,
                  Snapshot.decimal(covered), observed == status.source.watermark else { throw NativeSearchFailure.invalid }
            try snapshot.validate(store: store)
            if covered == status.source.watermark { return (snapshot, status.source) }
        } else if status.state != "building" { throw NativeSearchFailure.invalid }
        try check()
        // Begin allocates OUR stage; never enumerate/resume/discard another owner’s stage.
        stage = try await document("begin", as: Stage.self).snapshot
        guard let stage = stage else { throw NativeSearchFailure.invalid }
        try stage.validate(store: store)
        var ready = false
        for _ in 0..<64 {
            try check()
            let progress = try await document("pump", ["snapshot": try object(stage)], as: Progress.self)
            guard progress.snapshot == stage, progress.preparedDocuments <= progress.totalDocuments,
                  progress.reusedDocuments <= progress.totalDocuments else { throw NativeSearchFailure.invalid }
            if progress.ready { ready = true; break }
            await Task.yield()
        }
        guard ready else { throw NativeSearchFailure.preparationLimit }
        try check()
        let published = try await document("publish", ["snapshot": try object(stage)], as: Snapshot.self)
        guard published == stage else { throw NativeSearchFailure.invalid }
        self.stage = nil
        status = try await document("status", as: Status.self)
        try status.source.validate(store: store)
        guard status.state == "ready", status.snapshot == published,
              status.coveredWatermark == status.source.watermark,
              status.observedSourceHead == status.source.watermark, status.coverageComplete != nil else { throw NativeSearchFailure.invalid }
        return (published, status.source)
    }
    func run(query: String) async throws -> NativeSearchResult {
        guard !query.isEmpty, query.utf8.count <= 4096, !query.contains("\n"), !query.contains("\r") else { throw NativeSearchFailure.invalidQuery }
        let context: [String: Any] = await withCheckedContinuation { continuation in session.context { continuation.resume(returning: $0) } }
        guard context["documentSemantics"] as? Bool == true else { throw NativeSearchFailure.unsupported }
        try check()
        // A malformed/lost claim may have admitted a lease. Treat it as terminal;
        // the coordinator must close the host, never hand it to the editor.
        do {
            let (claimed, body) = try await wire(["method": "claim_client", "client_id": session.vault.clientId], admitted: false, as: Claimed.self)
            lease = claimed.lease
            guard body.isEmpty, claimed.lease.local_store_id == store,
                  claimed.lease.client_id == session.vault.clientId,
                  UUID(uuidString: claimed.lease.token)?.uuidString.lowercased() == claimed.lease.token else { throw NativeSearchFailure.invalid }
        } catch { throw NativeSearchFailure.cleanup }
        let outcome: Result<NativeSearchResult, Error>
        do {
            try check()
            let expected = try await prepare()
            try check()
            // Each query releases its client lease. Rust release removes the
            // entire per-client pin replay floor; a new lease starts at pin 1.
            pin = "1"
            let opened = try await document("open", ["pinId": "1"], as: Opened.self)
            try opened.snapshot.validate(store: store); try opened.source.validate(store: store)
            guard opened.pinId == pin, opened.snapshot == expected.0, opened.source == expected.1 else { throw NativeSearchFailure.invalid }
            var hits: [NativeSearchHit] = []
            var hitIds = Set<String>()
            var cursor: String?
            var complete = false
            for _ in 0..<4 {
                try check()
                let page = try await document("search", ["pinId": "1", "query": query, "cursor": cursor.map { $0 as Any } ?? NSNull(), "limit": 50], as: Page.self)
                let result = page.result, value = result.value
                guard result.snapshot == opened.snapshot, value.snapshot == opened.snapshot, result.source == opened.source,
                      result.coverageComplete == opened.coverageComplete, value.coverageComplete == opened.coverageComplete,
                      value.next == nil, value.hits.count <= 50, value.documents <= 32, value.sourceBytes <= 16_777_216,
                      value.scanComplete == (page.cursor == nil), value.complete == (value.scanComplete && value.coverageComplete),
                      page.cursor == nil || (NativeFileEntry.isValidEntryId(page.cursor!) && page.cursor != cursor) else { throw NativeSearchFailure.invalid }
                for hit in value.hits {
                    guard NativeFileEntry.isValidEntryId(hit.entry.id), NativeFileEntry.isValidEntryId(hit.revision), NativeFileEntry.isValidPath(hit.entry.path),
                          hit.entry.kind == .file, !hit.entry.deleted,
                          hit.range.bytes.count == 2, hit.range.utf16.count == 2,
                          hit.range.bytes[0] <= hit.range.bytes[1], hit.range.utf16[0] <= hit.range.utf16[1],
                          hit.snippet.utf8.count <= 1_048_576 else { throw NativeSearchFailure.invalid }
                    guard hitIds.insert(hit.rowId).inserted else { throw NativeSearchFailure.invalid }
                    if NativeFileEntry.isVisiblePath(hit.entry.path) { hits.append(hit) }
                }
                cursor = page.cursor; complete = value.complete
                if cursor == nil || hits.count >= 50 { break }
                await Task.yield()
            }
            outcome = .success(NativeSearchResult(hits: Array(hits.prefix(50)), partial: !complete || hits.count > 50))
        } catch { outcome = .failure(error) }
        // Cleanup is deliberately not cancelled with UI intent, and finishes
        // before results become actionable or coordinator busy is cleared.
        var cleaned = false
        for _ in 0..<2 {
            do {
                if let pin = pin {
                    guard try await document("close", ["pinId": pin], as: Bool.self) else { throw NativeSearchFailure.invalid }
                    self.pin = nil
                }
                if let stage = stage {
                    guard try await document("discard", ["snapshot": try object(stage)], as: Bool.self) else { throw NativeSearchFailure.invalid }
                    self.stage = nil
                }
                guard let lease = lease else { throw NativeSearchFailure.invalid }
                let (released, body) = try await wire(["method": "release_client", "reference": try object(lease)], admitted: false, as: Released.self)
                guard body.isEmpty, released.released, released.reference == lease else { throw NativeSearchFailure.invalid }
                self.lease = nil
                cleaned = true
                break
            } catch {
                // Retry the SAME remaining pin/stage/lease references. In
                // particular release_client is idempotent after a lost ACK.
                await Task.yield()
            }
        }
        guard cleaned else { throw NativeSearchFailure.cleanup }
        return try outcome.get()
    }
}

private enum NativePage: String, CaseIterable {
    case recents, files
    var title: String { self == .recents ? "Recents" : "Files" }
    var symbol: String { self == .recents ? "clock" : "folder" }
}

// Folder/note identities survive rename; root has no entry ID. Paths are only
// fresh snapshot locators. History is bounded RAM owned by one vault coordinator.
private enum NativeRoute: Equatable {
    case page(NativePage, folderId: String?)
    case note(String)
}

private struct NativePagePreferences {
    private static let key = "native.notes.mode.v1"
    private static let legacyKey = "native.pages.v1"
    var selected: NativePage

    init(defaults: UserDefaults = .standard) {
        if let saved = defaults.string(forKey: Self.key) {
            selected = NativePage(rawValue: saved) ?? .recents
        } else if defaults.stringArray(forKey: Self.legacyKey)?.isEmpty == true {
            selected = .recents
        } else {
            // Settings is a sheet now. Invalid/legacy Settings selections fall
            // back to Recents; both note modes are always available.
            selected = defaults.string(forKey: Self.legacyKey + ".selected").flatMap(NativePage.init(rawValue:)) ?? .recents
        }
        persist(to: defaults)
    }

    func persist(to defaults: UserDefaults = .standard) {
        defaults.set(selected.rawValue, forKey: Self.key)
        defaults.removeObject(forKey: Self.legacyKey)
        defaults.removeObject(forKey: Self.legacyKey + ".selected")
    }
}

// One coordinator owns the session. A hidden native page never opens another
// host while its editor is active. Temporary search admission is fully released
// before the web editor can claim the same persisted consumer.
@MainActor
private final class NativePagesCoordinator {
    private let vault: LocalVault
    private let root: URL
    private var session: NativeMobileSession?
    private var generation = 0
    private var searchGeneration = 0
    private var searchWork: DispatchWorkItem?
    private var pendingSearch: String?
    private var editorOpenGeneration = 0
    private var busy = false
    private var editorActive = false
    private var chooseVaultRequested = false
    private var visible = false
    private var refreshRequested = false
    private var refreshWork: DispatchWorkItem?
    private var refreshGeneration = 0
    private var initialListingPending = true
    private var history: [NativeRoute] = []
    private var historyStoreId: String?
    private var historyIndex = -1
    private var pendingHistoryIndex: Int?
    private var awaitingNoteActivation = false
    private var routeFailureOnReturn = false
    private weak var activeEditor: NativeEditorContainer?
    weak var owner: NativePagesController?

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        self.vault = vault
        self.root = root
        self.session = session
    }

    func record(_ route: NativeRoute) {
        guard pendingHistoryIndex == nil else { return }
        if history.indices.contains(historyIndex), history[historyIndex] == route { updateRouteControls(); return }
        history = Array(history.prefix(historyIndex + 1))
        history.append(route)
        if history.count > 100 { history.removeFirst(history.count - 100) }
        historyIndex = history.count - 1
        updateRouteControls()
    }

    func recordPageNavigation(_ route: NativeRoute) {
        guard !editorActive else { return }
        cancelSearch()
        // Cancel admission, not the in-flight Rust read/host ownership. Its reply
        // must still clear loading (or close a failed host), without pushing.
        editorOpenGeneration += 1
        // A new mode or Settings presentation wins over a staged history
        // destination while its read is still in flight.
        pendingHistoryIndex = nil
        awaitingNoteActivation = false
        record(route)
    }

    private func updateRouteControls() {
        let available = pendingHistoryIndex == nil && !busy
        let back = available && historyIndex > 0
        let forward = available && historyIndex + 1 < history.count
        owner?.setRouteAvailability(back: back, forward: forward)
        activeEditor?.setRouteAvailability(back: back, forward: forward)
    }

    func traverse(_ direction: Int) {
        guard direction == -1 || direction == 1, !busy, pendingHistoryIndex == nil,
              UIApplication.shared.applicationState == .active else { return }
        let target = historyIndex + direction
        guard history.indices.contains(target) else { return }
        if editorActive {
            guard let editor = activeEditor, editor.navigationController?.topViewController === editor else { return }
            pendingHistoryIndex = target
            updateRouteControls()
            editor.leaveForNativeRoute { [weak self] ok in
                guard let self = self else { return }
                if !ok { self.pendingHistoryIndex = nil; self.updateRouteControls() }
            }
        } else {
            guard pageActive else { return }
            pendingHistoryIndex = target
            updateRouteControls()
            cancelQueuedRefresh()
            load(refresh: true)
        }
    }

    private func completeTraversal(_ listing: NativeVaultListing, session: NativeMobileSession) {
        guard let target = pendingHistoryIndex, history.indices.contains(target) else { return }
        let route = history[target]
        switch route {
        case .page(let page, let folderId):
            let folder = folderId.flatMap { id in listing.entries.first { $0.id == id && $0.kind == .folder } }
            guard (folderId == nil || folder != nil), owner?.supports(page) == true else {
                traversalUnavailable(); return
            }
            historyIndex = target
            pendingHistoryIndex = nil
            owner?.applyRoute(page: page, folder: folder)
            updateRouteControls()
        case .note(let id):
            guard let entry = listing.entries.first(where: { $0.id == id && $0.kind == .file }) else {
                traversalUnavailable(); return
            }
            // Resolving identity authorizes handoff, not successful activation.
            // Keep the cursor staged until the web confirms this exact entry.
            awaitingNoteActivation = true
            transfer(session, initialEntry: entry, origin: owner?.originTitle ?? "Pages")
            updateRouteControls()
        }
    }

    private func traversalUnavailable() {
        pendingHistoryIndex = nil
        owner?.showRouteUnavailable()
        updateRouteControls()
    }

    private var pageActive: Bool {
        guard visible, !editorActive, UIApplication.shared.applicationState == .active,
              let owner = owner, owner.navigationController?.topViewController === owner,
              let scene = owner.viewIfLoaded?.window?.windowScene else { return false }
        return scene.activationState == .foregroundActive
    }

    func setVisible(_ visible: Bool) {
        self.visible = visible
        if !visible { cancelSearch() }
        if visible { scheduleAutomaticRefresh() } else { cancelQueuedRefresh() }
    }

    func cancelQueuedRefresh() {
        if UIApplication.shared.applicationState != .active { cancelSearch() }
        refreshGeneration += 1
        refreshWork?.cancel()
        refreshWork = nil
        refreshRequested = false
    }

    // Lifecycle events are debounced into one pending refresh, never a polling
    // loop. Continuously visible external writes await a future Rust-backed
    // change-notification seam; root-only vnode watches miss nested file writes.
    func scheduleAutomaticRefresh() {
        guard pageActive else { return }
        if chooseVaultRequested { finishChooseVault(); return }
        refreshRequested = true
        guard !busy, refreshWork == nil else { return }
        let ticket = refreshGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.refreshGeneration == ticket else { return }
            self.refreshWork = nil
            guard self.pageActive, !self.busy, self.refreshRequested else { return }
            self.refreshRequested = false
            self.load(refresh: !self.initialListingPending)
        }
        refreshWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    func foregroundRefresh() {
        guard pageActive else { return }
        cancelSearch()
        initialListingPending = false
        scheduleAutomaticRefresh()
    }

    private func drainAutomaticRefresh() {
        if chooseVaultRequested { finishChooseVault(); return }
        if refreshRequested { scheduleAutomaticRefresh(); return }
        startPendingSearch()
    }

    private func cancelSearch() {
        searchGeneration += 1
        searchWork?.cancel()
        searchWork = nil
        pendingSearch = nil
        owner?.cancelSearchDisplay()
    }

    func search(_ query: String) {
        cancelSearch()
        guard !query.isEmpty else { return }
        pendingSearch = query
        owner?.beginSearchDisplay()
        let work = DispatchWorkItem { [weak self] in
            self?.searchWork = nil
            self?.startPendingSearch()
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    private func startPendingSearch() {
        guard searchWork == nil, let query = pendingSearch, pageActive, !busy,
              !editorActive, !refreshRequested, let session = session,
              let store = historyStoreId else { return }
        pendingSearch = nil
        let ticket = searchGeneration
        busy = true
        owner?.setSearchAdmissionBusy(true)
        updateRouteControls()
        let operation = NativePageSearch(session: session, store: store) { [weak self] in
            guard let self = self else { return false }
            return self.searchGeneration == ticket && self.pageActive && !self.refreshRequested && !self.chooseVaultRequested
        }
        Task { @MainActor [weak self] in
            let result: Result<NativeSearchResult, Error>
            do { result = .success(try await operation.run(query: query)) }
            catch { result = .failure(error) }
            guard let self = self else { return }
            // Invalid admission/DTO/cleanup cannot be handed to web. Closing
            // the host drops any uncertain lease before retry is made available.
            if case .failure(let error) = result,
               (error as? NativeSearchFailure == .cleanup || error as? NativeSearchFailure == .invalid || !(error is NativeSearchFailure)) {
                self.fail(session, ticket: self.generation) { [weak self] in
                    self?.owner?.setSearchAdmissionBusy(false)
                    self?.cancelSearch()
                }
                return
            }
            self.busy = false
            self.owner?.setSearchAdmissionBusy(false)
            if self.searchGeneration == ticket && self.pageActive {
                self.owner?.finishSearchDisplay(result)
            }
            self.updateRouteControls()
            self.drainAutomaticRefresh()
        }
    }

    func load(refresh: Bool = false, completion: @escaping () -> Void = {}) {
        guard pageActive, !busy, !editorActive else { completion(); return }
        let finished: () -> Void = { [weak self] in
            completion()
            self?.drainAutomaticRefresh()
        }
        busy = true
        initialListingPending = false
        updateRouteControls()
        generation += 1
        let ticket = generation
        owner?.setLoading()
        if let session = session {
            if refresh { refreshThenRead(session, ticket: ticket, completion: finished) }
            else { read(session, ticket: ticket, completion: finished) }
            return
        }
        NativeMobileSession.open(vault: vault, root: root) { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else {
                if case .success(let session) = result { session.close {} }
                finished()
                return
            }
            switch result {
            case .success(let session):
                self.session = session
                if self.pageActive { self.read(session, ticket: ticket, completion: finished) }
                else { self.busy = false; finished() }
            case .failure:
                self.busy = false
                if self.pageActive { self.owner?.showLoadFailure() }
                self.pendingHistoryIndex = nil
                self.updateRouteControls()
                finished()
            }
        }
    }

    private func refreshThenRead(_ session: NativeMobileSession, ticket: Int, completion: @escaping () -> Void) {
        session.refresh { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { completion(); return }
            switch result {
            case .success:
                guard self.pageActive else { self.busy = false; completion(); return }
                self.read(session, ticket: ticket, completion: completion)
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
                if self.pageActive {
                    if let priorStore = self.historyStoreId, priorStore != listing.localStoreId {
                        self.history = []
                        self.historyIndex = -1
                        self.pendingHistoryIndex = nil
                        self.awaitingNoteActivation = false
                        self.routeFailureOnReturn = true
                        self.owner?.resetFolderRoute()
                    }
                    self.historyStoreId = listing.localStoreId
                    self.owner?.showListing(listing)
                    if let query = self.owner?.searchQuery, !query.isEmpty { self.search(query) }
                    if self.pendingHistoryIndex != nil { self.completeTraversal(listing, session: session) }
                    else if let route = self.owner?.currentRoute { self.record(route) }
                    if self.routeFailureOnReturn {
                        self.routeFailureOnReturn = false
                        self.owner?.showRouteUnavailable()
                    }
                }
                self.updateRouteControls()
                completion()
            case .failure: self.fail(session, ticket: ticket, completion: completion)
            }
        }
    }

    private func fail(_ session: NativeMobileSession, ticket: Int, missingSelection: Bool = false, completion: @escaping () -> Void = {}) {
        // A failed/fenced host must not be reused by every retry. Complete close
        // before allowing retry so a new host cannot overlap this one.
        self.session = nil
        busy = true
        session.close { [weak self] in
            guard let self = self, self.generation == ticket else { completion(); return }
            self.busy = false
            self.pendingHistoryIndex = nil
            self.updateRouteControls()
            if self.pageActive { self.owner?.showLoadFailure(missingSelection: missingSelection) }
            completion()
            self.drainAutomaticRefresh()
        }
    }

    func reload() async {
        guard pageActive else { return }
        cancelSearch()
        if busy { scheduleAutomaticRefresh(); return }
        cancelQueuedRefresh()
        await withCheckedContinuation { continuation in load(refresh: true) { continuation.resume() } }
    }

    func openEditor(entry: NativeFileEntry?, origin: String) {
        guard pageActive, !busy, !editorActive, let session = session, owner?.navigationController != nil else { return }
        generation += 1
        let ticket = generation
        editorOpenGeneration += 1
        let navigationTicket = editorOpenGeneration
        guard let entry = entry else { transfer(session, initialEntry: nil, origin: origin); return }
        busy = true
        owner?.setLoading()
        // The row's path is only a display locator. Resolve its stable identity
        // again; never open a replacement entry that has reused the old path.
        session.pageListing { [weak self] result in
            guard let self = self, self.generation == ticket, !self.editorActive else { return }
            switch result {
            case .success(let listing):
                guard self.pageActive else { self.busy = false; return }
                guard self.editorOpenGeneration == navigationTicket else {
                    // A newer native tab/folder choice wins over this lookup.
                    self.busy = false
                    self.owner?.showListing(listing)
                    self.updateRouteControls()
                    self.drainAutomaticRefresh()
                    return
                }
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
        owner?.view.endEditing(true)
        cancelQueuedRefresh()
        self.session = nil
        editorActive = true
        let launch = initialEntry.map(NativeEditorLaunch.entry) ?? .newNote
        let editor = NativeEditorContainer(session: session, launch: launch, originTitle: origin) { [weak self] in
            guard let self = self else { return }
            self.editorActive = false
            self.activeEditor = nil
            if self.awaitingNoteActivation {
                self.awaitingNoteActivation = false
                self.pendingHistoryIndex = nil
                self.routeFailureOnReturn = true
            }
            if self.pendingHistoryIndex == nil, let route = self.owner?.currentRoute { self.record(route) }
        }
        activeEditor = editor
        editor.onNoteOpened = { [weak self, weak editor] id in
            guard let self = self, let editor = editor, self.activeEditor === editor, self.editorActive else { return }
            if self.awaitingNoteActivation {
                self.awaitingNoteActivation = false
                if let target = self.pendingHistoryIndex, self.history.indices.contains(target), self.history[target] == .note(id) {
                    self.historyIndex = target
                    self.pendingHistoryIndex = nil
                    self.updateRouteControls()
                    return
                }
                // A different successfully activated note is a new user route.
                self.pendingHistoryIndex = nil
            }
            self.record(.note(id))
        }
        editor.onNavigate = { [weak self] direction in self?.traverse(direction) }
        updateRouteControls()
        navigation.pushViewController(editor, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    func chooseVault() {
        guard !editorActive else { return }
        // A full-screen Settings sheet may finish dismissal before UIKit sends
        // viewDidAppear. Retain intent until the page is active and reads drain.
        chooseVaultRequested = true
        cancelSearch()
        finishChooseVault()
    }

    private func finishChooseVault() {
        guard chooseVaultRequested, pageActive, !busy, !editorActive else { return }
        chooseVaultRequested = false
        cancelQueuedRefresh()
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
    @Published private(set) var searchQuery = ""
    @Published private(set) var searchAdmissionBusy = false
    @Published private(set) var searchLoading = false
    @Published private(set) var searchHits: [NativeSearchHit] = []
    @Published private(set) var searchStatus = ""
    var onSearch: ((String) -> Void)?
    func setSearch(_ query: String) {
        searchQuery = query
        searchHits = []
        searchStatus = ""
        onSearch?(query)
    }
    func setSearchAdmissionBusy(_ busy: Bool) { searchAdmissionBusy = busy }
    func beginSearchDisplay() { searchLoading = true; searchHits = []; searchStatus = "" }
    func cancelSearchDisplay() { searchLoading = false }
    func finishSearchDisplay(_ result: Result<NativeSearchResult, Error>) {
        searchLoading = false
        switch result {
        case .success(let value):
            searchHits = value.hits
            searchStatus = value.partial
                ? "Results are partial. Refine your search to find more matches."
                : (value.hits.isEmpty ? "No matching note content." : "")
        case .failure(let error):
            searchHits = []
            switch error as? NativeSearchFailure {
            case .invalidQuery: searchStatus = "Use a single-line search of at most 4 KB."
            case .unsupported: searchStatus = "Search is unavailable in this version."
            case .preparationLimit: searchStatus = "Search preparation reached its limit. Submit the search again to retry."
            case .rebuildRequired: searchStatus = "The search index needs repair. Your notes have not been changed."
            case .cancelled: searchStatus = "Search paused. Submit again to retry."
            default: searchStatus = "Search could not finish safely. Submit again to retry."
            }
        }
    }
    @Published private(set) var preferences = NativePagePreferences()
    @Published private(set) var rows: [NativeFileEntry] = []
    @Published private(set) var folder = ""
    @Published private(set) var status = "Loading vault…"
    @Published private(set) var loading = true
    @Published private(set) var canCreateNote = false
    @Published private(set) var emptyMessage = ""
    @Published private(set) var focusGeneration = 0
    private var listing: NativeVaultListing?
    private var folderId: String?
    var onRouteChanged: ((NativeRoute) -> Void)?
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    var currentRoute: NativeRoute { .page(preferences.selected, folderId: preferences.selected == .files ? folderId : nil) }

    func setRouteAvailability(back: Bool, forward: Bool) { canGoBack = back; canGoForward = forward }
    func supports(_ page: NativePage) -> Bool { NativePage.allCases.contains(page) }
    func applyRoute(page: NativePage, folder: NativeFileEntry?) {
        if !searchQuery.isEmpty { setSearch("") }
        preferences.selected = page
        preferences.persist()
        self.folder = folder?.path ?? ""
        folderId = folder?.id
        focusedEntryId = nil
        render()
        focusGeneration += 1
    }
    func showRouteUnavailable() {
        status = "That route is no longer available. Choose a current file or folder."
        UIAccessibility.post(notification: .announcement, argument: status)
    }
    @Published private(set) var expandedFolderIds: Set<String> = []
    private var rowDepths: [String: Int] = [:]
    private var childCounts: [String: Int] = [:]
    private(set) var focusedEntryId: String?
    private var restoringFocus = false

    init(vault: LocalVault) { self.vault = vault }
    var heading: String { preferences.selected == .files && !folder.isEmpty ? folder : preferences.selected.title }
    var isInFolder: Bool { preferences.selected == .files && !folder.isEmpty }

    func setLoading() {
        loading = true
        status = listing == nil ? "Loading vault…" : "Updating vault…"
        render()
    }
    func showLoadFailure(missingSelection: Bool = false) {
        loading = false
        listing = nil
        status = missingSelection
            ? "The selected note is no longer available. Pull down to see the current files."
            : "Could not load this vault safely. Pull down to retry or reopen the vault. Your files have not been changed."
        render()
        focusedEntryId = nil
        restoringFocus = false
        focusGeneration += 1
        UIAccessibility.post(notification: .announcement, argument: "Could not load vault")
    }
    func showListing(_ listing: NativeVaultListing) {
        loading = false
        self.listing = listing
        status = listing.reconciliationComplete ? "" : "Vault reconciliation is incomplete. Some files or changes may not yet be available. Pull down to retry."
        if let id = folderId, let current = listing.entries.first(where: { $0.id == id && $0.kind == .folder }) { folder = current.path }
        else { folder = ""; folderId = nil }
        render()
        if restoringFocus {
            if !rows.contains(where: { $0.id == focusedEntryId }) { focusedEntryId = nil }
            focusGeneration += 1
            restoringFocus = false
        }
    }
    func select(_ page: NativePage) {
        guard supports(page), preferences.selected != page else { return }
        if !searchQuery.isEmpty { setSearch("") }
        preferences.selected = page
        preferences.persist()
        focusedEntryId = nil
        render()
        onRouteChanged?(currentRoute)
    }
    func beginSettingsPresentation() {
        if !searchQuery.isEmpty { setSearch("") }
        // Opening a sheet is newer UI intent too. Cancel any staged route/file
        // admission without changing the current Notes mode or route history.
        onRouteChanged?(currentRoute)
    }
    func enter(_ folder: NativeFileEntry) {
        guard !loading, folder.kind == .folder else { return }
        if !searchQuery.isEmpty { setSearch("") }
        self.folder = folder.path
        folderId = folder.id
        render()
        onRouteChanged?(currentRoute)
    }
    func parentFolder() {
        guard !loading else { return }
        if !searchQuery.isEmpty { setSearch("") }
        folder = NativeFileEntry.pathComponents(folder).dropLast().joined(separator: "/")
        folderId = listing?.entries.first(where: { $0.kind == .folder && NativeFileEntry.samePath($0.path, folder) })?.id
        if folderId == nil { folder = "" }
        render()
        onRouteChanged?(currentRoute)
    }
    func willOpen(_ entry: NativeFileEntry?) {
        focusedEntryId = entry?.id
        restoringFocus = true
    }
    func toggleFolder(_ entry: NativeFileEntry) {
        guard entry.kind == .folder else { return }
        if expandedFolderIds.contains(entry.id) { expandedFolderIds.remove(entry.id) }
        else { expandedFolderIds.insert(entry.id) }
        render()
    }

    func depth(for entry: NativeFileEntry) -> Int { rowDepths[entry.id] ?? 0 }

    func metadata(for entry: NativeFileEntry) -> String {
        if preferences.selected == .recents { return entry.parent.isEmpty ? vault.name : entry.parent }
        var parts: [String] = []
        if let milliseconds = entry.presentation?.modifiedMilliseconds {
            parts.append(DateFormatter.localizedString(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000), dateStyle: .short, timeStyle: .none))
        }
        if entry.kind == .folder {
            let count = childCounts[entry.id] ?? 0
            parts.append("\(count) \(count == 1 ? "item" : "items")")
        } else if let bytes = entry.presentation?.sizeBytes, let count = Int64(exactly: bytes) {
            parts.append(ByteCountFormatter.string(fromByteCount: count, countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }

    private func render() {
        rows = []
        rowDepths = [:]
        childCounts = [:]
        var historyFailed = false
        if let listing = listing {
            if preferences.selected == .recents {
                do { rows = try NativeRecentStore.entries(vaultId: vault.id, listing: listing) }
                catch { historyFailed = true }
            } else {
                let groups = Dictionary(grouping: listing.entries, by: { Data($0.parent.utf8) }).mapValues { entries in
                    entries.sorted {
                        if $0.kind != $1.kind { return $0.kind == .folder }
                        let order = $0.name.localizedStandardCompare($1.name)
                        return order == .orderedSame ? $0.path.utf8.lexicographicallyPrecedes($1.path.utf8) : order == .orderedAscending
                    }
                }
                let folders = listing.entries.filter { $0.kind == .folder }
                expandedFolderIds.formIntersection(Set(folders.map(\.id)))
                childCounts = Dictionary(uniqueKeysWithValues: folders.map { ($0.id, groups[Data($0.path.utf8)]?.count ?? 0) })
                // Iterative flattening keeps even deeply nested folders off the
                // Swift call stack. IDs own expansion; paths only locate children.
                var pending = (groups[Data(folder.utf8)] ?? []).reversed().map { ($0, 0) }
                while let (entry, depth) = pending.popLast() {
                    rows.append(entry)
                    rowDepths[entry.id] = depth
                    if entry.kind == .folder && expandedFolderIds.contains(entry.id) {
                        pending.append(contentsOf: (groups[Data(entry.path.utf8)] ?? []).reversed().map { ($0, depth + 1) })
                    }
                }
            }
        }
        if historyFailed { status = "Recent history could not be read. Your files are available in Files." }
        else if let listing = listing {
            status = listing.reconciliationComplete ? "" : "Vault reconciliation is incomplete. Some files or changes may not yet be available. Pull down to retry."
        }
        canCreateNote = !loading && listing != nil
        if loading { emptyMessage = "" }
        else if listing == nil || historyFailed { emptyMessage = "" }
        else if listing?.reconciliationComplete != true { emptyMessage = "No entries are available while vault reconciliation is incomplete." }
        else if preferences.selected == .recents { emptyMessage = "Notes you open appear here. Browse Files or create a new note to get started." }
        else { emptyMessage = "This folder is empty. Create a new note to get started." }
    }
}

final class NativePagesController: UIViewController {
    private let model: NativePagesModel
    private let coordinator: NativePagesCoordinator
    private var hosting: UIHostingController<NativePagesView>?
    private var activityObservers: [NSObjectProtocol] = []

    init(vault: LocalVault, root: URL, session: NativeMobileSession) {
        model = NativePagesModel(vault: vault)
        coordinator = NativePagesCoordinator(vault: vault, root: root, session: session)
        super.init(nibName: nil, bundle: nil)
        coordinator.owner = self
    }
    required init?(coder: NSCoder) { fatalError("Use the native vault picker.") }

    override func viewDidLoad() {
        super.viewDidLoad()
        model.onSearch = { [weak self] query in self?.coordinator.search(query) }
        model.onRouteChanged = { [weak self] route in self?.coordinator.recordPageNavigation(route) }
        coordinator.record(model.currentRoute)
        let pages = NativePagesView(model: model, navigate: { [weak self] direction in self?.coordinator.traverse(direction) }, open: { [weak self] entry in
            guard let self = self else { return }
            self.model.willOpen(entry)
            self.coordinator.openEditor(entry: entry, origin: self.model.preferences.selected.title)
        }, chooseVault: { [weak self] in self?.coordinator.chooseVault() }, refresh: { [weak self] in
            if let self = self { await self.coordinator.reload() }
        })
        let hosting = UIHostingController(rootView: pages)
        self.hosting = hosting
        view.backgroundColor = .systemBackground
        // A UIKit container marker does not propagate through SwiftUI's AX
        // environment and overwrite Settings/heading/tab/button identifiers.
        view.accessibilityIdentifier = "native.pages"
        view.isAccessibilityElement = false
        hosting.view.backgroundColor = .systemBackground
        hosting.view.clipsToBounds = false
        view.clipsToBounds = false
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
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.coordinator.foregroundRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.coordinator.cancelQueuedRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self, let scene = notification.object as? UIWindowScene,
                  scene === self.viewIfLoaded?.window?.windowScene else { return }
            self.coordinator.foregroundRefresh()
        })
        activityObservers.append(NotificationCenter.default.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self, let scene = notification.object as? UIWindowScene,
                  scene === self.viewIfLoaded?.window?.windowScene else { return }
            self.coordinator.cancelQueuedRefresh()
        })
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        coordinator.setVisible(true)
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        coordinator.setVisible(false)
        navigationController?.setNavigationBarHidden(false, animated: false)
    }
    deinit {
        for observer in activityObservers { NotificationCenter.default.removeObserver(observer) }
    }
    fileprivate var searchQuery: String { model.searchQuery }
    fileprivate func setSearchAdmissionBusy(_ busy: Bool) { model.setSearchAdmissionBusy(busy) }
    fileprivate func beginSearchDisplay() { model.beginSearchDisplay() }
    fileprivate func cancelSearchDisplay() { model.cancelSearchDisplay() }
    fileprivate func finishSearchDisplay(_ result: Result<NativeSearchResult, Error>) { model.finishSearchDisplay(result) }
    fileprivate var currentRoute: NativeRoute { model.currentRoute }
    fileprivate var originTitle: String { model.preferences.selected.title }
    fileprivate func supports(_ page: NativePage) -> Bool { model.supports(page) }
    fileprivate func applyRoute(page: NativePage, folder: NativeFileEntry?) { model.applyRoute(page: page, folder: folder) }
    fileprivate func showRouteUnavailable() { model.showRouteUnavailable() }
    fileprivate func resetFolderRoute() { model.applyRoute(page: model.preferences.selected, folder: nil) }
    fileprivate func setRouteAvailability(back: Bool, forward: Bool) { model.setRouteAvailability(back: back, forward: forward) }
    fileprivate func setLoading() { model.setLoading() }
    fileprivate func showListing(_ listing: NativeVaultListing) { model.showListing(listing) }
    fileprivate func showLoadFailure(missingSelection: Bool = false) { model.showLoadFailure(missingSelection: missingSelection) }
}

@MainActor
private struct NativePagesView: View {
    @ObservedObject var model: NativePagesModel
    let navigate: (Int) -> Void
    let open: (NativeFileEntry?) -> Void
    let chooseVault: () -> Void
    let refresh: () async -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace
    @AccessibilityFocusState private var focus: Focus?
    @State private var showingSettings = false
    @State private var chooseVaultAfterDismiss = false

    private enum Focus: Hashable { case settings, compose, heading, folderHeading, entry(String) }
    private var currentHeadingFocus: Focus { model.isInFolder ? .folderHeading : .heading }
    private var motion: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9) }

    private var selectedMode: Binding<NativePage> {
        Binding(get: { model.preferences.selected }, set: { page in
            withAnimation(motion) { model.select(page) }
            focus = .heading
        })
    }

    var body: some View {
        VStack(spacing: 0) {
            // Draw glass above the opaque TabView sibling so its diffuse shadow
            // can cross the header boundary rather than being overpainted there.
            topBar.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 12).zIndex(1)
            TabView {
                pageContent.tabItem {
                    Label("Notes", systemImage: "note.text")
                        .accessibilityIdentifier("native.pages.tab.notes")
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
        .sheet(isPresented: $showingSettings, onDismiss: {
            if chooseVaultAfterDismiss {
                chooseVaultAfterDismiss = false
                chooseVault()
            } else { focus = .settings }
        }) { settingsContent }
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.vault.name)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.pages.vault-name")
            Menu {
                Picker("Notes view", selection: selectedMode) {
                    ForEach(NativePage.allCases, id: \.self) { page in
                        Label(page.title, systemImage: page.symbol)
                            .tag(page)
                            .accessibilityIdentifier("native.pages.mode.\(page.rawValue)")
                    }
                }
                .pickerStyle(.inline)
            } label: {
                HStack(spacing: 8) {
                    Text(model.preferences.selected.title).font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "chevron.down").font(.body.weight(.semibold))
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Notes view")
            .accessibilityValue(model.preferences.selected.title)
            .accessibilityHint("Choose Recents or Files")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("native.pages.heading")
            .accessibilityFocused($focus, equals: .heading)
            .padding(.horizontal, 20)
            if model.isInFolder {
                Text(model.heading).font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("native.files.heading")
                    .accessibilityFocused($focus, equals: .folderHeading)
                    .padding(.horizontal, 20)
            }
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.footnote)
                    .foregroundColor(contrast == .increased ? .primary : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.pages.status")
                    .padding(.horizontal, 20)
            }
            if model.isInFolder {
                Button { withAnimation(motion) { model.parentFolder() }; focus = currentHeadingFocus } label: {
                    Label("Parent folder", systemImage: "chevron.left").frame(minHeight: 44)
                }
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.files.parent")
                .disabled(model.loading)
            }
            if model.loading && !model.rows.isEmpty {
                ProgressView("Updating vault").font(.footnote).padding(.horizontal, 20)
            }
            if model.searchQuery.isEmpty { entryList } else { searchList }
        }
    }

    @ViewBuilder private var topBar: some View {
        if #available(iOS 26, *), !reduceTransparency, contrast != .increased {
            GlassEffectContainer(spacing: 8) { tabControls }
        } else { tabControls }
    }

    private var tabControls: some View {
        HStack(spacing: 8) {
            if model.isInFolder {
                NativeHistoryControls(backEnabled: model.canGoBack && !model.loading,
                                      forwardEnabled: model.canGoForward && !model.loading,
                                      identifierPrefix: "native.pages", navigate: navigate)
            } else {
                Button {
                    model.beginSettingsPresentation()
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape").padding(12).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .modifier(PageControlSurface(id: "settings", namespace: glassNamespace))
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("native.pages.settings")
                .accessibilityFocused($focus, equals: .settings)
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").accessibilityHidden(true)
                TextField("Search notes", text: Binding(get: { model.searchQuery }, set: { model.setSearch($0) }))
                    .font(.body)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .submitLabel(.search)
                    .onSubmit { model.setSearch(model.searchQuery) }
                    .accessibilityIdentifier("native.search.field")
                if !model.searchQuery.isEmpty {
                    Button { model.setSearch("") } label: {
                        Image(systemName: "xmark.circle.fill").frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                    .accessibilityIdentifier("native.search.clear")
                }
            }
            .padding(.leading, 14).padding(.trailing, model.searchQuery.isEmpty ? 14 : 0)
            .frame(maxWidth: .infinity, minHeight: 44)
            .modifier(PageControlSurface(id: "search", namespace: glassNamespace))
            Button { open(nil) } label: {
                Image(systemName: "square.and.pencil").padding(12).frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .modifier(PageControlSurface(id: "compose", namespace: glassNamespace))
            .accessibilityLabel("New note")
            .accessibilityIdentifier("native.pages.new-note")
            .disabled(!model.canCreateNote || model.searchLoading || model.searchAdmissionBusy)
            .accessibilityFocused($focus, equals: .compose)
        }
        .font(.system(size: 17))
        .foregroundColor(.primary)
    }

    private var searchList: some View {
        List {
            if model.searchLoading {
                NativeLoadingSkeleton(editor: false).padding(.vertical, 12).listRowSeparator(.hidden)
            }
            if !model.searchStatus.isEmpty {
                Text(model.searchStatus).font(.footnote).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native.search.status")
            }
            ForEach(model.searchHits, id: \.rowId) { hit in
                Button { open(hit.entry) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(hit.entry.name).font(.body).foregroundColor(.primary)
                        Text(hit.entry.path).font(.caption).foregroundColor(.secondary)
                        Text(hit.snippet).font(.subheadline).foregroundColor(.secondary).lineLimit(3)
                        Text("Line \(UInt64(hit.line) + 1)").font(.caption2).foregroundColor(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.vertical, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.searchLoading || model.searchAdmissionBusy || model.loading)
                .accessibilityIdentifier("native.search.result.\(hit.entry.id).\(hit.line)")
                .accessibilityHint("Opens the current note in the editor")
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        .accessibilityIdentifier("native.search.results")
        .refreshable { await refresh() }
    }

    private var entryList: some View {
        ScrollViewReader { proxy in
            List {
                if model.loading && model.rows.isEmpty {
                    NativeLoadingSkeleton(editor: false).padding(.vertical, 12)
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
                    HStack(spacing: 0) {
                        if model.preferences.selected == .files {
                            if entry.kind == .folder {
                                Button {
                                    withAnimation(motion) { model.toggleFolder(entry) }
                                } label: {
                                    Image(systemName: model.expandedFolderIds.contains(entry.id) ? "chevron.down" : "chevron.right")
                                        .font(.body.weight(.semibold)).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(model.expandedFolderIds.contains(entry.id) ? "Collapse" : "Expand") \(entry.name)\(entry.parent.isEmpty ? "" : ", in " + entry.parent)")
                                .accessibilityValue(model.expandedFolderIds.contains(entry.id) ? "Expanded" : "Collapsed")
                                .accessibilityIdentifier("native.folder.expand.\(entry.id)")
                                .disabled(model.loading)
                            } else { Color.clear.frame(width: 44, height: 44).accessibilityHidden(true) }
                        }
                        Button {
                            if entry.kind == .folder {
                                withAnimation(motion) { model.enter(entry) }
                                focus = currentHeadingFocus
                            } else { open(entry) }
                        } label: {
                            HStack(spacing: 14) {
                                Image(systemName: entry.kind == .folder ? "folder.fill" : "doc.text")
                                    .font(.title2)
                                    .foregroundColor(entry.kind == .folder ? .accentColor : .secondary)
                                    .frame(minWidth: 28, minHeight: 44).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entry.name).font(.body).foregroundColor(.primary)
                                        .fixedSize(horizontal: false, vertical: true)
                                    let metadata = model.metadata(for: entry)
                                    if !metadata.isEmpty {
                                        Text(metadata).font(.caption).foregroundColor(.secondary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(!entry.parent.isEmpty
                                            ? "\(entry.name), \(entry.parent)" : entry.name)
                        .accessibilityValue(entry.kind == .folder ? "Folder, \(model.metadata(for: entry))" : model.metadata(for: entry))
                        .accessibilityHint(entry.kind == .folder ? "Opens folder contents" : "Opens in the editor. Return here when finished.")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityIdentifier("native.entry.\(entry.id)")
                        .disabled(model.loading || model.searchAdmissionBusy)
                        .accessibilityFocused($focus, equals: .entry(entry.id))
                    }
                    .padding(.leading, CGFloat(min(model.depth(for: entry), 8)) * 12)
                    .listRowSeparator(model.preferences.selected == .files ? .visible : .hidden)
                    .id(entry.id)
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
                } else { focus = currentHeadingFocus }
            }
        }
    }

    private var settingsContent: some View {
        NavigationView {
            Form {
                Section {
                    Text("\(model.vault.name) · On this device")
                    Button("Choose vault") {
                        // Finish the native modal dismissal before closing the
                        // unleased page host and popping to the vault picker.
                        chooseVaultAfterDismiss = true
                        showingSettings = false
                    }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("native.settings.choose-vault")
                }
            }
            .accessibilityIdentifier("native.settings")
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingSettings = false }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("native.settings.done")
                }
            }
        }
        .navigationViewStyle(.stack)
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
