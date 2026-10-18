import UIKit
import SwiftUI
import UniformTypeIdentifiers

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
    let revision: String
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
                            guard !decoded.cursor.isEmpty, entries.allSatisfy({ !$0.deleted && NativeFileEntry.isValidEntryId($0.id) && NativeFileEntry.isValidEntryId($0.revision) && NativeFileEntry.isValidPath($0.path) }),
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

    // Both callbacks share the same Rust validation. Legacy activation does not
    // acquire the document-tab model's additional presentation-metadata limits.
    func recordNoteOpened(path: String, entryId: String, onValidated: @escaping (String) -> Void = { _ in },
                          completion: @escaping (Result<Void, Error>) -> Void) {
        recordOpenedWitness(path: path, entryId: entryId, isCurrent: { true },
                            onValidated: { _, entry in onValidated(entry.id) }, completion: completion)
    }

    func recordNoteOpened(path: String, entryId: String, isCurrent: @escaping () -> Bool = { true },
                          onValidated: @escaping (NativeTabDocument) -> Void,
                          completion: @escaping (Result<Void, Error>) -> Void) {
        recordOpenedWitness(path: path, entryId: entryId, isCurrent: isCurrent,
            onValidated: { listing, entry in
                let document = try NativeTabDocument(vaultID: self.vault.id, localStoreID: listing.localStoreId,
                                                     stableFileID: entry.id, displayTitle: entry.name)
                guard isCurrent() else { throw NativePageError.unavailable }
                onValidated(document)
            }, completion: completion)
    }

    private func recordOpenedWitness(path: String, entryId: String, isCurrent: @escaping () -> Bool,
                                     onValidated: @escaping (NativeVaultListing, NativeFileEntry) throws -> Void,
                                     completion: @escaping (Result<Void, Error>) -> Void) {
        guard isCurrent(), NativeFileEntry.isVisiblePath(path), NativeFileEntry.isValidEntryId(entryId) else {
            completion(.failure(NativePageError.invalidResponse)); return
        }
        pageListing { result in
            completion(result.flatMap { listing in
                Result {
                    guard isCurrent(), let entry = listing.entries.first(where: {
                        $0.id == entryId && NativeFileEntry.samePath($0.path, path) && $0.kind == .file
                    }) else { throw NativePageError.unavailable }
                    try onValidated(listing, entry)
                    // Binding may advance root ownership synchronously. Recheck
                    // before local history IO rather than recording a stale note.
                    guard isCurrent() else { throw NativePageError.unavailable }
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
    case invalid, invalidQuery, unsupported, cancelled, rebuildRequired, queryFailed, cleanup
}

private struct NativeSearchHit: Decodable {
    private let witness: Witness
    var entry: NativeFileEntry {
        NativeFileEntry(id: witness.id, revision: witness.revision, path: witness.path, kind: witness.kind, deleted: witness.deleted, presentation: nil)
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
private enum NativeSearchProgress {
    case preparing(UInt64, UInt64)
    case searching
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
    private let progress: (NativeSearchProgress) -> Void
    private var batchStarted = Date()
    private var batchOperations = 0

    init(session: NativeMobileSession, store: String, active: @escaping () -> Bool,
         progress: @escaping (NativeSearchProgress) -> Void) {
        self.session = session; self.store = store; self.active = active; self.progress = progress
    }
    private func check() throws {
        guard active() else { throw NativeSearchFailure.cancelled }
    }
    private func yieldBatch(limit: Int) async {
        // Rust bounds each pump/page. A soft batch boundary gives UI/lifecycle
        // work time without throwing away progress or restarting a scan prefix.
        batchOperations += 1
        await Task.yield()
        if batchOperations >= limit || Date().timeIntervalSince(batchStarted) >= 8 {
            batchOperations = 0
            batchStarted = Date()
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
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
        var previousPrepared: UInt64?
        var expectedTotal: UInt64?
        while true {
            try check()
            let report = try await document("pump", ["snapshot": try object(stage)], as: Progress.self)
            guard report.snapshot == stage, report.preparedDocuments <= report.totalDocuments,
                  report.reusedDocuments <= report.totalDocuments,
                  expectedTotal == nil || expectedTotal == report.totalDocuments,
                  report.ready || previousPrepared == nil || report.preparedDocuments > previousPrepared! else {
                throw NativeSearchFailure.invalid
            }
            expectedTotal = report.totalDocuments
            previousPrepared = report.preparedDocuments
            progress(.preparing(report.preparedDocuments, report.totalDocuments))
            if report.ready { break }
            await yieldBatch(limit: 64)
        }
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
            progress(.searching)
            while true {
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
                    if NativeFileEntry.isVisiblePath(hit.entry.path) {
                        // Retain only the bounded visible result set. Hidden
                        // matches may span the whole vault and are never kept.
                        guard hitIds.insert(hit.rowId).inserted else { throw NativeSearchFailure.invalid }
                        hits.append(hit)
                    }
                }
                cursor = page.cursor; complete = value.complete
                if cursor == nil || hits.count >= 50 { break }
                await yieldBatch(limit: 4)
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
    private var loanTicket: UUID?
    private var loanBorrowed = false
    private var tabOverviewSuspended = false
    private var tabSourceClosed = false
    private var tabRetirementTicket: UUID?
    private var tabRetirementSessionID: ObjectIdentifier?
    private var tabRetirementGeneration: UInt64?
    private var tabAdmissionGeneration: UInt64 = 0
    var documentTabTransitionRetired: Bool {
        tabSourceClosed && tabRetirementTicket != nil && tabRetirementSessionID != nil && tabRetirementGeneration == tabAdmissionGeneration
    }
    func invalidateDocumentTabRetirement() {
        tabAdmissionGeneration &+= 1
        tabRetirementTicket = nil; tabRetirementSessionID = nil; tabRetirementGeneration = nil
    }
    private var tabResumeAllowed = false
    private var tabResumeRequested = false
    private var tabDrainTicket: UUID?
    private var tabDrainCompletion: ((Result<Void, Error>) -> Void)?
    private var tabDrainProbing = false
    private var tabDrainClosing = false
    private var ownershipBlocked = false
    private var ownershipCheckRunning = false
    private var recovery: NativeMenuRecovery = .checking
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
    private var openingDestination: NativeFileOpenDestinationController?
    private var openingDestinationTicket: Int?
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
        guard !editorActive, !tabOverviewSuspended, !tabSourceClosed else { return }
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
        let available = pendingHistoryIndex == nil && !busy && (editorActive || recovery == .clear)
        let back = available && historyIndex > 0
        let forward = available && historyIndex + 1 < history.count
        owner?.setRouteAvailability(back: back, forward: forward)
        activeEditor?.setRouteAvailability(back: back, forward: forward)
    }

    func traverse(_ direction: Int) {
        if editorActive { traverseAfterRecovery(direction); return }
        withRecoveryGate { [weak self] in self?.traverseAfterRecovery(direction) }
    }
    private func traverseAfterRecovery(_ direction: Int) {
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
            if owner?.routeDocumentThroughRoot(entry, inNewTab: false) == true {
                pendingHistoryIndex = nil
                awaitingNoteActivation = false
                updateRouteControls()
                return
            }
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
        guard visible, !editorActive, !tabOverviewSuspended, !tabSourceClosed,
              UIApplication.shared.applicationState == .active,
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
        if tabOverviewSuspended { serviceDocumentTabDrain(); return }
        if tabSourceClosed { return }
        if tabResumeRequested {
            guard !busy, pageActive else { return }
            tabResumeRequested = false
            scheduleAutomaticRefresh()
            return
        }
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

    func search(_ query: String, userIntent: Bool = true) {
        guard !tabOverviewSuspended, !tabSourceClosed else { return }
        if userIntent {
            // Typing/toggling is newer intent than a pending note/history open.
            // Automatic query refresh must not cancel a staged traversal.
            editorOpenGeneration += 1
            pendingHistoryIndex = nil
            awaitingNoteActivation = false
            updateRouteControls()
        }
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
              !editorActive, recovery == .clear, !refreshRequested, let session = session,
              let store = historyStoreId else { return }
        pendingSearch = nil
        let ticket = searchGeneration
        busy = true
        owner?.setSearchAdmissionBusy(true)
        updateRouteControls()
        let operation = NativePageSearch(session: session, store: store, active: { [weak self] in
            guard let self = self else { return false }
            return self.searchGeneration == ticket && self.pageActive && !self.refreshRequested && !self.chooseVaultRequested
        }, progress: { [weak self] progress in
            guard let self = self, self.searchGeneration == ticket, self.pageActive else { return }
            self.owner?.showSearchProgress(progress)
        })
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
        invalidateDocumentTabRetirement()
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

                    if self.routeFailureOnReturn {
                        self.routeFailureOnReturn = false
                        self.owner?.showRouteUnavailable()
                    }
                }
                self.historyStoreId = listing.localStoreId
                let loan = self.startLoan()
                self.setRecovery(.checking)
                self.probeHeldLoan(loan, session: session, store: listing.localStoreId) { [weak self] result in
                    guard let self = self, self.loanTicket == loan, self.session === session else { completion(); return }
                    switch result {
                    case .success(let pending):
                        self.setRecovery(pending ? .pending : .clear)
                        self.finishLoan(loan, session: session, result: .success(()), refresh: false)
                        if self.pageActive, !pending {
                            if self.pendingHistoryIndex != nil { self.completeTraversal(listing, session: session) }
                            else if let route = self.owner?.currentRoute { self.record(route) }
                            if let query = self.owner?.searchQuery, !query.isEmpty { self.search(query, userIntent: false) }
                        } else if pending { self.pendingHistoryIndex = nil; self.awaitingNoteActivation = false }
                    case .failure(let error): self.finishLoan(loan, session: session, result: .failure(error), refresh: false)
                    }
                    self.updateRouteControls()
                    completion()
                }
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

    // Every borrowed admission first checks this native consumer's durable
    // intent. Review is the only caller allowed to borrow with one pending.
    func lendSession(review: Bool = false, refreshOnReturn: Bool = true, completion: @escaping (Result<(NativeExclusiveSessionBinding, NativeVaultListing), Error>) -> Void) {
        guard pageActive, !busy, !editorActive, let session = session,
              let store = historyStoreId else { completion(.failure(NativeFileActionFailure.unavailable)); return }
        cancelSearch()
        cancelQueuedRefresh()
        editorOpenGeneration += 1
        pendingHistoryIndex = nil
        awaitingNoteActivation = false
        let ticket = startLoan()
        session.pageListing { [weak self] result in
            guard let self = self, self.loanTicket == ticket, self.session === session else { return }
            switch result {
            case .success(let listing):
                guard listing.localStoreId == store, self.pageActive else {
                    self.finishLoan(ticket, session: session, result: .success(()), refresh: false)
                    completion(.failure(NativeFileActionFailure.unavailable)); return
                }
                self.probeHeldLoan(ticket, session: session, store: store) { [weak self] result in
                    guard let self = self, self.loanTicket == ticket, self.session === session else { return }
                    switch result {
                    case .success(let pending):
                        self.setRecovery(pending ? .pending : .clear)
                        guard !pending || review else {
                            self.finishLoan(ticket, session: session, result: .success(()), refresh: false)
                            completion(.failure(NativeFileActionFailure.recoveryRequired)); return
                        }
                        guard self.pageActive else {
                            self.finishLoan(ticket, session: session, result: .success(()), refresh: false)
                            completion(.failure(NativeFileActionFailure.unavailable)); return
                        }
                        let binding = NativeExclusiveSessionBinding(session: session, localStoreId: store,
                            folderId: nil, folderPath: "", finish: { [weak self] result in
                                guard let self = self else { return }
                                self.finishLoan(ticket, session: session, result: result, refresh: refreshOnReturn)
                            })
                        self.loanBorrowed = true
                        completion(.success((binding, listing)))
                    case .failure(let error):
                        self.finishLoan(ticket, session: session, result: .failure(error), refresh: false)
                        completion(.failure(error))
                    }
                }
            case .failure(let error):
                self.finishLoan(ticket, session: session, result: .failure(error), refresh: false)
                completion(.failure(error))
            }
        }
    }

    private func setRecovery(_ value: NativeMenuRecovery) {
        recovery = value
        owner?.setRecovery(value)
    }
    private func startLoan() -> UUID {
        invalidateDocumentTabRetirement()
        busy = true
        owner?.setNativeOperationBusy(true)
        updateRouteControls()
        let ticket = UUID()
        loanBorrowed = false
        loanTicket = ticket
        return ticket
    }

    // The probe owns a temporary claim, but keeps the outer loan until its
    // caller has examined the result. Never expose a transient reusable state.
    private func probeHeldLoan(_ ticket: UUID, session: NativeMobileSession, store: String,
                               completion: @escaping (Result<Bool, Error>) -> Void) {
        var returned: Result<Void, Error>?
        let binding = NativeExclusiveSessionBinding(session: session, localStoreId: store, folderId: nil, folderPath: "",
            finish: { result in returned = result })
        Task { @MainActor [weak self] in
            let result = await NativeFileCommand(binding: binding).probe()
            guard let self = self, self.loanTicket == ticket, self.session === session else { return }
            guard let returned = returned else { completion(.failure(NativeFileActionFailure.invalidReply)); return }
            if case .failure(let error) = returned { completion(.failure(error)) }
            else { completion(result) }
        }
    }

    private func finishLoan(_ ticket: UUID, session: NativeMobileSession, result: Result<Void, Error>, refresh: Bool = true, ownershipRecovered: Bool = false) {
        // Check identity before reading any outcome, especially a no-authority
        // failure. A stale callback cannot close/unlock a healthy newer owner.
        guard loanTicket == ticket, self.session === session else { return }
        if ownershipBlocked, !ownershipRecovered, case .success = result { return }
        if case .failure(let error) = result,
           let failure = error as? NativeSessionOperationFailure, !failure.sessionFenced {
            ownershipBlocked = true
            pendingHistoryIndex = nil
            awaitingNoteActivation = false
            setRecovery(.blocked)
            owner?.setNativeOperationBusy(true)
            updateRouteControls()
            serviceDocumentTabDrain()
            return // Retain exact ticket/session/busy; no close, nil, or success.
        }
        loanTicket = nil
        loanBorrowed = false
        ownershipBlocked = false
        if refresh { setRecovery(.checking) }
        let finish = { [weak self] in
            guard let self = self else { return }
            self.busy = false
            self.owner?.setNativeOperationBusy(false)
            self.updateRouteControls()
            if self.tabOverviewSuspended { self.serviceDocumentTabDrain() }
            else if refresh || self.tabResumeRequested { self.scheduleAutomaticRefresh(); self.drainAutomaticRefresh() }
        }
        switch result {
        case .success: finish()
        case .failure:
            setRecovery(.unavailable)
            self.session = nil
            session.close(completion: finish)
        }
    }

    // This action never releases a remembered/foreign token or closes the host.
    // If the real owner is still active, native_busy keeps the gate blocked.
    func recheckOwnership() {
        guard pageActive, ownershipBlocked, !ownershipCheckRunning,
              let ticket = loanTicket, let session = session, let store = historyStoreId else { return }
        ownershipCheckRunning = true
        owner?.setOwnershipRecoveryBusy(true)
        probeHeldLoan(ticket, session: session, store: store) { [weak self] result in
            guard let self = self, self.loanTicket == ticket, self.session === session else { return }
            self.ownershipCheckRunning = false
            self.owner?.setOwnershipRecoveryBusy(false)
            switch result {
            case .success(let pending):
                self.setRecovery(pending ? .pending : .clear)
                self.finishLoan(ticket, session: session, result: .success(()), refresh: false, ownershipRecovered: true)
                self.drainAutomaticRefresh()
            case .failure(let error): self.finishLoan(ticket, session: session, result: .failure(error), refresh: false)
            }
        }
    }

    private func withRecoveryGate(_ completion: @escaping () -> Void) {
        lendSession(refreshOnReturn: false) { [weak self] result in
            guard case .success(let (binding, _)) = result else { return }
            binding.finish(.success(())) // Probe's exact release ACK already succeeded.
            guard let self = self, self.pageActive, self.recovery == .clear, !self.busy else { return }
            completion()
        }
    }

    // Root injects the document-tab coordinator. Pages only drains its own
    // read/search/lease work and returns an actual close ACK; no metadata moves.
    func prepareForDocumentTabTransition(completion: @escaping (Result<Void, Error>) -> Void) {
        guard !tabSourceClosed, tabDrainTicket == nil, !editorActive, openingDestination == nil else {
            completion(.failure(NativePageError.unavailable)); return
        }
        invalidateDocumentTabRetirement()
        tabOverviewSuspended = true
        owner?.setDocumentTabSourceSuspended(true)
        tabResumeAllowed = false
        tabResumeRequested = false
        cancelSearch()
        cancelQueuedRefresh()
        editorOpenGeneration += 1
        pendingHistoryIndex = nil
        awaitingNoteActivation = false
        chooseVaultRequested = false // The newer root transition supersedes a queued native route.
        tabDrainTicket = UUID()
        tabDrainCompletion = completion
        serviceDocumentTabDrain()
    }

    private func finishDocumentTabDrain(_ result: Result<Void, Error>) {
        guard tabDrainTicket != nil else { return }
        let completion = tabDrainCompletion
        tabDrainTicket = nil; tabDrainCompletion = nil; tabDrainProbing = false
        if case .failure = result { tabResumeAllowed = true }
        completion?(result)
    }

    private func serviceDocumentTabDrain() {
        guard let transition = tabDrainTicket, !tabDrainProbing, !tabDrainClosing else { return }
        if ownershipBlocked || loanBorrowed {
            if ownershipBlocked { finishDocumentTabDrain(.failure(NativeFileActionFailure.authorityBlocked)) }
            else { finishDocumentTabDrain(.failure(NativePageError.unavailable)) }
            return // Retain the actual borrower's host and exact admission.
        }
        guard !busy else { return } // Existing worker completion re-enters here.
        guard !editorActive, openingDestination == nil, let session = session else {
            finishDocumentTabDrain(.failure(NativePageError.unavailable)); return
        }
        guard let store = historyStoreId else {
            // An overview may cover Pages before its initial listing begins.
            // Resolve the trusted host identity without opening another host.
            tabDrainProbing = true; busy = true
            session.pageListing { [weak self] result in
                guard let self = self, self.tabDrainTicket == transition, self.session === session else { return }
                self.busy = false; self.tabDrainProbing = false
                switch result {
                case .success(let listing):
                    self.historyStoreId = listing.localStoreId
                    self.serviceDocumentTabDrain()
                case .failure(let error): self.finishDocumentTabDrain(.failure(error))
                }
            }
            return
        }
        tabDrainProbing = true
        let loan = startLoan()
        let admissionGeneration = tabAdmissionGeneration
        probeHeldLoan(loan, session: session, store: store) { [weak self] result in
            guard let self = self, self.tabDrainTicket == transition,
                  self.loanTicket == loan, self.session === session else { return }
            switch result {
            case .success(let pending):
                self.setRecovery(pending ? .pending : .clear)
                if pending {
                    self.finishLoan(loan, session: session, result: .success(()), refresh: false)
                    self.finishDocumentTabDrain(.failure(NativeFileActionFailure.recoveryRequired))
                    return
                }
                // The temporary exact lease has been released. Keep the host,
                // ticket and busy gate until the serial worker closes it.
                self.tabDrainClosing = true
                session.close { [weak self] in
                    guard let self = self, self.tabDrainTicket == transition,
                          self.loanTicket == loan, self.session === session else { return }
                    self.session = nil
                    self.loanTicket = nil; self.loanBorrowed = false
                    self.busy = false; self.tabDrainClosing = false
                    self.tabSourceClosed = true
                    self.tabRetirementTicket = transition
                    self.tabRetirementSessionID = ObjectIdentifier(session)
                    self.tabRetirementGeneration = admissionGeneration
                    self.owner?.setNativeOperationBusy(false)
                    self.updateRouteControls()
                    self.finishDocumentTabDrain(.success(()))
                }
            case .failure(let error):
                self.finishLoan(loan, session: session, result: .failure(error), refresh: false)
                self.finishDocumentTabDrain(.failure(error))
            }
        }
    }

    func resumeAfterDocumentTabOverview() {
        guard tabOverviewSuspended, tabResumeAllowed, !tabSourceClosed,
              tabDrainTicket == nil, !tabDrainClosing else { return }
        tabOverviewSuspended = false
        owner?.setDocumentTabSourceSuspended(false)
        tabResumeAllowed = false
        tabResumeRequested = true
        // If root has not popped its overview yet, settled viewDidAppear will
        // schedule this refresh. No closed/successor source is ever reopened.
        scheduleAutomaticRefresh()
        drainAutomaticRefresh()
    }

    func reload() async {
        guard pageActive else { return }
        cancelSearch()
        if busy { scheduleAutomaticRefresh(); return }
        cancelQueuedRefresh()
        await withCheckedContinuation { continuation in load(refresh: true) { continuation.resume() } }
    }

    func openEditor(entry: NativeFileEntry?, origin: String) {
        guard recovery == .clear, !ownershipBlocked else { return }
        // Push the owned loading route immediately. Its final admission probe
        // happens inside that route, before any host reaches the editor.
        openEditorAfterRecovery(entry: entry, origin: origin)
    }
    private func openEditorAfterRecovery(entry: NativeFileEntry?, origin: String) {
        guard pageActive, !busy, !editorActive, let session = session,
              let navigation = owner?.navigationController else { return }
        generation += 1
        let ticket = generation
        editorOpenGeneration += 1
        let navigationTicket = editorOpenGeneration
        busy = true
        cancelQueuedRefresh()
        owner?.view.endEditing(true)
        // Take the idle host before routing. Native menus/search cannot borrow it
        // while the placeholder performs lookup or waits for cancellation cleanup.
        self.session = nil
        openingDestinationTicket = ticket
        let destination = NativeFileOpenDestinationController(vault: vault, root: root, session: session,
            title: entry?.name ?? "New note", ready: { [weak self] destination, session in
                guard let self = self, self.generation == ticket,
                      self.editorOpenGeneration == navigationTicket, !self.editorActive,
                      self.openingDestination === destination else {
                    destination.showFailure("This selection changed. Return and select the file again.", retry: false)
                    return
                }
                let complete: (NativeFileEntry?) -> Void = { [weak self, weak destination] current in
                    destination?.whenVisible { [weak self, weak destination] in
                        guard let self = self, let destination = destination,
                              self.generation == ticket, self.editorOpenGeneration == navigationTicket,
                              self.openingDestination === destination, destination.owns(session) else {
                            destination?.showFailure("This selection changed. Return and select the file again.", retry: false)
                            return
                        }
                        self.transfer(session, initialEntry: current, origin: origin)
                    }
                }
                guard let entry = entry else { complete(nil); return }
                session.pageListing { [weak self, weak destination] result in
                    guard let destination = destination, destination.owns(session) else { return }
                    guard let self = self, self.generation == ticket,
                          self.editorOpenGeneration == navigationTicket, !self.editorActive,
                          self.openingDestination === destination else {
                        destination.showFailure("This selection changed. Return and select the file again.", retry: false)
                        return
                    }
                    switch result {
                    case .success(let listing):
                        guard let current = listing.entries.first(where: { $0.id == entry.id && $0.kind == .file }) else {
                            destination.showFailure("The selected file is no longer available. Return and select it again.", retry: false)
                            return
                        }
                        complete(current)
                    case .failure: destination.showFailure("The file could not be opened. Your files remain on this device.")
                    }
                }
            }, closed: { [weak self] in
                guard let self = self, self.openingDestinationTicket == ticket else { return }
                self.openingDestinationTicket = nil; self.openingDestination = nil
                self.busy = false; self.pendingHistoryIndex = nil; self.awaitingNoteActivation = false
                self.updateRouteControls(); self.drainAutomaticRefresh()
            })
        openingDestination = destination
        updateRouteControls()
        navigation.pushViewController(destination, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func transfer(_ session: NativeMobileSession, initialEntry: NativeFileEntry?, origin: String) {
        let navigationTicket = editorOpenGeneration
        let destinationTicket = openingDestinationTicket
        if let destination = openingDestination {
            probeDestination(destination, session: session, navigationTicket: navigationTicket) { [weak self, weak destination] in
                destination?.whenVisible { [weak self, weak destination] in
                    guard let destination = destination, destination.owns(session) else { return }
                    guard let self = self, self.openingDestination === destination, self.editorOpenGeneration == navigationTicket,
                          self.openingDestinationTicket == destinationTicket else {
                        destination.showFailure("This selection changed. Return and choose the current destination.", retry: false)
                        return
                    }
                    self.transferAdmitted(session, initialEntry: initialEntry, origin: origin,
                        navigationTicket: navigationTicket, destinationTicket: destinationTicket)
                }
            }
            return
        }
        // Native history also passes here; no path may bypass this final probe.
        guard self.session === session, !busy, let store = historyStoreId else { return }
        let ticket = startLoan()
        probeHeldLoan(ticket, session: session, store: store) { [weak self] result in
            guard let self = self, self.loanTicket == ticket, self.session === session else { return }
            switch result {
            case .success(let pending):
                self.setRecovery(pending ? .pending : .clear)
                self.finishLoan(ticket, session: session, result: .success(()), refresh: false)
                if !pending, self.pageActive, self.editorOpenGeneration == navigationTicket {
                    self.transferAdmitted(session, initialEntry: initialEntry, origin: origin,
                        navigationTicket: navigationTicket, destinationTicket: destinationTicket)
                } else {
                    self.pendingHistoryIndex = nil; self.awaitingNoteActivation = false
                    self.updateRouteControls(); self.drainAutomaticRefresh()
                }
            case .failure(let error): self.finishLoan(ticket, session: session, result: .failure(error), refresh: false)
            }
        }
    }

    private func probeDestination(_ destination: NativeFileOpenDestinationController, session: NativeMobileSession,
                                  navigationTicket: Int, completion: @escaping () -> Void) {
        guard openingDestination === destination, openingDestinationTicket != nil, destination.owns(session),
              let store = historyStoreId, destination.beginAdmissionCheck() else { return }
        let ticket = openingDestinationTicket
        var returned: Result<Void, Error>?
        let binding = NativeExclusiveSessionBinding(session: session, localStoreId: store, folderId: nil, folderPath: "",
            finish: { result in returned = result })
        Task { @MainActor [weak self, destination] in
            let result = await NativeFileCommand(binding: binding).probe()
            guard let self = self, self.openingDestination === destination,
                  self.openingDestinationTicket == ticket, destination.owns(session) else { return }
            // A failed claim/release with no authority cannot dispose this host,
            // even via Back/deinit. Keep the strongly held destination blocked.
            if case .failure(let error)? = returned,
               let failure = error as? NativeSessionOperationFailure, !failure.sessionFenced {
                self.setRecovery(.blocked)
                destination.showAuthorityBlocked { [weak self, weak destination] in
                    guard let self = self, let destination = destination else { return }
                    self.probeDestination(destination, session: session, navigationTicket: navigationTicket, completion: completion)
                }
                return
            }
            destination.finishAdmissionCheck()
            guard case .success? = returned else {
                self.setRecovery(.unavailable)
                destination.showFailure("Saved native actions could not be checked safely. Return to review or retry.")
                return
            }
            switch result {
            case .success(let pending):
                self.setRecovery(pending ? .pending : .clear)
                guard self.editorOpenGeneration == navigationTicket else {
                    destination.showFailure("This selection changed. Return and choose the current destination.", retry: false)
                    return
                }
                if pending { destination.showFailure("A saved native file action needs review. Return to the vault page and choose Review pending file action.", retry: false) }
                else { completion() }
            case .failure:
                self.setRecovery(.unavailable)
                destination.showFailure("Saved native actions could not be checked safely. Return to review or retry.")
            }
        }
    }

    private func transferAdmitted(_ session: NativeMobileSession, initialEntry: NativeFileEntry?, origin: String,
                                  navigationTicket: Int, destinationTicket: Int?) {
        guard recovery == .clear, editorOpenGeneration == navigationTicket,
              openingDestinationTicket == destinationTicket else { return }
        guard let navigation = owner?.navigationController else { return }
        let destination = openingDestination
        if let destination = destination {
            guard destination.navigationController === navigation,
                  navigation.topViewController === destination,
                  destination.takeSession(session) else { return }
            openingDestination = nil; openingDestinationTicket = nil
        } else {
            guard pageActive, self.session === session else { return }
        }
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
        if destination != nil {
            var stack = navigation.viewControllers; stack[stack.count - 1] = editor
            navigation.setViewControllers(stack, animated: false)
        } else { navigation.pushViewController(editor, animated: !UIAccessibility.isReduceMotionEnabled) }
    }

    func chooseVault() {
        guard !editorActive, !tabOverviewSuspended, !tabSourceClosed else { return }
        // A full-screen Settings sheet may finish dismissal before UIKit sends
        // viewDidAppear. Retain intent until the page is active and reads drain.
        editorOpenGeneration += 1
        pendingHistoryIndex = nil
        awaitingNoteActivation = false
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

// This is the approved native navigation subset, not an editor command registry.
private enum NativePageAction: String, CaseIterable, Identifiable {
    case newNote, recents, files, settings, chooseVault
    var id: String { rawValue }
    var title: String {
        switch self {
        case .newNote: return "New note"
        case .recents: return "Show Recents"
        case .files: return "Show Files"
        case .settings: return "Settings"
        case .chooseVault: return "Choose vault"
        }
    }
    var symbol: String {
        switch self {
        case .newNote: return "square.and.pencil"
        case .recents: return "clock"
        case .files: return "folder"
        case .settings: return "gearshape"
        case .chooseVault: return "externaldrive"
        }
    }
}
private enum NativeNotesFieldMode { case search, actions }

// Only implemented native pages belong here. Recents/Files are Notes modes.
private enum NativeNavigationItem: String, CaseIterable, Identifiable, Codable {
    case notes
    var id: String { rawValue }
    var title: String { switch self { case .notes: return "Notes" } }
    var symbol: String { switch self { case .notes: return "note.text" } }
}

private struct NativeNavigationPreferences {
    private static let key = "native.navigation.items.v1"
    private let defaults: UserDefaults
    private(set) var items: [NativeNavigationItem]
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Missing, malformed, empty or all-unknown preferences restore Notes.
        // The native navigation bar always contains an implemented page.
        if let saved = defaults.array(forKey: Self.key) {
            items = Self.clean(saved.compactMap { ($0 as? String).flatMap(NativeNavigationItem.init(rawValue:)) })
        } else { items = [.notes] }
        if items.isEmpty { items = [.notes] }
        persist()
    }
    private static func clean(_ items: [NativeNavigationItem]) -> [NativeNavigationItem] {
        var seen = Set<NativeNavigationItem>()
        return items.filter { seen.insert($0).inserted }
    }
    mutating func replace(_ items: [NativeNavigationItem]) {
        let cleaned = Self.clean(items)
        guard !cleaned.isEmpty else { return }
        self.items = cleaned
        persist()
    }
    private func persist() {
        defaults.set(items.map(\.rawValue), forKey: Self.key)
    }
}

private enum NativeFileRowAction: String, CaseIterable {
    case duplicate, move, share, rename, delete
    // Expand only when the real bounded copy/export binding exists.
    static let supported: [Self] = [.move, .rename, .delete]
    var title: String {
        switch self {
        case .duplicate: return "Duplicate"
        case .move: return "Move"
        case .share: return "Share"
        case .rename: return "Rename"
        case .delete: return "Delete"
        }
    }
    var symbol: String {
        switch self {
        case .duplicate: return "plus.square.on.square"
        case .move: return "folder"
        case .share: return "square.and.arrow.up"
        case .rename: return "pencil"
        case .delete: return "trash"
        }
    }
}

// UIHostingConfiguration supplies a plain content view. UIKit owns the native
// context interaction, previews, dimming, dismissal and haptic; no custom popup
// or manually parented hosting controller is inserted in a list/bar hierarchy.
@available(iOS 16.0, *)
@MainActor
private struct NativeFileContextRow<Content: View>: UIViewRepresentable {
    let content: Content
    let enabled: Bool
    let menu: () -> UIMenu
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> NativeFileContextView {
        let view = NativeFileContextView()
        view.addInteraction(UIContextMenuInteraction(delegate: context.coordinator))
        return view
    }
    func updateUIView(_ uiView: NativeFileContextView, context: Context) {
        context.coordinator.makeMenu = enabled ? menu : nil
        uiView.update(UIHostingConfiguration { content }.margins(.all, 0))
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: NativeFileContextView, context: Context) -> CGSize? {
        uiView.systemLayoutSizeFitting(CGSize(width: proposal.width ?? 0, height: 0),
            withHorizontalFittingPriority: proposal.width == nil ? .fittingSizeLevel : .required,
            verticalFittingPriority: .fittingSizeLevel)
    }
    final class Coordinator: NSObject, UIContextMenuInteractionDelegate {
        var makeMenu: (() -> UIMenu)?
        func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                    configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
            guard let menu = makeMenu?() else { return nil }
            // The actions retain this exact menu-open identity/revision witness.
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in menu }
        }
    }
}

@available(iOS 16.0, *)
@MainActor
private final class NativeFileContextView: UIView {
    private var hosted: (UIView & UIContentView)?
    init() { super.init(frame: .zero); backgroundColor = .clear; isAccessibilityElement = false }
    required init?(coder: NSCoder) { fatalError("Use native file rows.") }
    func update(_ configuration: UIContentConfiguration) {
        if let hosted = hosted { hosted.configuration = configuration }
        else {
            let content = configuration.makeContentView()
            hosted = content
            content.backgroundColor = .clear
            content.translatesAutoresizingMaskIntoConstraints = false
            addSubview(content)
            NSLayoutConstraint.activate([
                content.topAnchor.constraint(equalTo: topAnchor), content.bottomAnchor.constraint(equalTo: bottomAnchor),
                content.leadingAnchor.constraint(equalTo: leadingAnchor), content.trailingAnchor.constraint(equalTo: trailingAnchor)
            ])
        }
        hosted?.invalidateIntrinsicContentSize()
        invalidateIntrinsicContentSize()
    }
}

private enum NativeFileActionFailure: Error, Equatable {
    case changed, unavailable, invalidName, invalidReply, previousPending, pending, rejected, recoveryRequired, authorityBlocked
}
// Picker-selected witness retained verbatim across confirmation and recovery.
// Rust validates this exact parent atomically; Swift snapshots are only UI guards.
private struct NativeDestinationWitness: Codable {
    let id: String?
    let revision: String?
    let path: String
    static let root = Self(id: nil, revision: nil, path: "")
    init(id: String?, revision: String?, path: String) { self.id = id; self.revision = revision; self.path = path }
    init(_ folder: NativeFileEntry) { id = folder.id; revision = folder.revision; path = folder.path }
    var wire: [String: String] {
        if let id = id, let revision = revision { return ["kind": "folder", "id": id, "revision": revision, "path": path] }
        return ["kind": "root"]
    }
    func validate() throws {
        if let id = id, let revision = revision {
            guard NativeFileEntry.isValidEntryId(id), NativeFileEntry.isValidEntryId(revision),
                  NativeFileEntry.isVisiblePath(path) else { throw NativeFileActionFailure.invalidReply }
        } else {
            guard id == nil, revision == nil, path.isEmpty else { throw NativeFileActionFailure.invalidReply }
        }
    }
}
private struct NativeFileActionRequest {
    let source: NativeFileEntry
    let action: NativeFileRowAction
    let folderId: String?
    let name: String
    let destinationParent: NativeDestinationWitness?
    init(source: NativeFileEntry, action: NativeFileRowAction, folderId: String?, name: String,
         destinationParent: NativeDestinationWitness? = nil) {
        self.source = source; self.action = action; self.folderId = folderId; self.name = name; self.destinationParent = destinationParent
    }
}

// Native UI orchestration only. Rust owns conditional mutations, receipts,
// projection and checkpoint durability; no file content or physical vault IO.
@MainActor
private final class NativeFileCommand {
    private struct WireError: Decodable { let code: String; let commit_uncertain: Bool; let message: String }
    private struct Envelope<T: Decodable>: Decodable {
        let version: UInt32; let request_id: String; let ok: Bool
        let result: T?; let error: WireError?
    }
    private struct Head: Decodable {
        let version: UInt32; let vaultId: String; let clientId: String; let key: String
        let revision: String; let sequence: String; let deleted: Bool; let byteLength: UInt32
    }
    private struct CheckpointReply: Decodable { let checkpoint: Head? }
    private struct Journal: Codable {
        let version: UInt32; let operationId: String; let action: String
        let entryId: String; let revision: String; let path: String; let kind: String
        let destination: String?
        let destinationParent: NativeDestinationWitness?
        func validate() throws {
            guard version == 1, UUID(uuidString: operationId)?.uuidString.lowercased() == operationId,
                  ["move", "rename", "delete"].contains(action), ["file", "folder"].contains(kind),
                  NativeFileEntry.isValidEntryId(entryId), NativeFileEntry.isValidEntryId(revision),
                  NativeFileEntry.isVisiblePath(path),
                  action == "delete" ? destination == nil : destination.map(NativeFileEntry.isVisiblePath) == true else {
                throw NativeFileActionFailure.invalidReply
            }
            if let parent = destinationParent {
                try parent.validate()
                guard action != "delete", let destination = destination,
                      NativeFileEntry.samePath(NativeFileEntry.pathComponents(destination).dropLast().joined(separator: "/"), parent.path) else {
                    throw NativeFileActionFailure.invalidReply
                }
            }
            // Legacy v1 journals without a parent stay decodable for exact
            // original status/replay; absence never silently becomes Root.
        }
        var family: [String: Any] {
            var mutation: [String: Any] = ["type": action == "delete" ? "delete" : "move", "id": entryId, "expected": revision]
            if action == "delete" { mutation["recursive"] = kind == "folder" }
            else { mutation["path"] = destination! }
            var family: [String: Any] = ["version": 1, "request": ["operation_id": operationId, "mutation": mutation], "create_mode": NSNull()]
            if let destinationParent = destinationParent { family["destination_parent"] = destinationParent.wire }
            return family
        }
    }
    // Bounded original root receipt, not current listing state. Rust owns the
    // atomic selected-parent precondition and original publication evidence.
    private struct OriginalStatus: Decodable {
        let status: String
        let local_store_id: String
        let operation_id: String
        let kind: String?
        let sequence: String?
        let source: NativeFileEntry?
        let target: NativeFileEntry?
        let change_count: String?
        let projection: String?
    }
    private func validate(_ status: OriginalStatus, for job: Journal) throws -> Bool {
        guard status.local_store_id == binding.localStoreId, status.operation_id == job.operationId else { throw NativeFileActionFailure.invalidReply }
        if status.status == "not_committed" {
            guard status.kind == nil, status.sequence == nil, status.source == nil, status.target == nil,
                  status.change_count == nil, status.projection == nil else { throw NativeFileActionFailure.invalidReply }
            return false // An observation only; never clears/changes operation identity.
        }
        guard status.status == "committed", status.kind == (job.action == "delete" ? "delete" : "move"),
              status.sequence.map(Self.decimal) == true, status.change_count.map(Self.decimal) == true,
              let source = status.source, let target = status.target,
              source.id == job.entryId, source.revision == job.revision, source.kind.rawValue == job.kind, !source.deleted,
              NativeFileEntry.samePath(source.path, job.path),
              target.id == source.id, target.kind == source.kind, target.revision != source.revision,
              NativeFileEntry.isValidEntryId(target.revision), NativeFileEntry.isVisiblePath(target.path),
              job.action == "delete" ? (target.deleted && NativeFileEntry.samePath(target.path, job.path)) :
                (!target.deleted && job.destination.map { NativeFileEntry.samePath(target.path, $0) } == true),
              status.projection == "settled" || status.projection == "pending" else { throw NativeFileActionFailure.invalidReply }
        return true
    }
    private func originalStatus(_ job: Journal, method: String) async throws -> OriginalStatus {
        let (status, body) = try await wire(["method": method, "client_id": binding.session.vault.clientId,
                                           "family": job.family], as: OriginalStatus.self)
        guard body.isEmpty else { throw NativeFileActionFailure.invalidReply }
        _ = try validate(status, for: job)
        return status
    }
    private struct Rejected: Error { let code: String; let uncertain: Bool }
    private let binding: NativeExclusiveSessionBinding
    private var admission: NativeSessionAdmission?
    private var requestId: UInt64 = 0
    // One pending native action per consumer, disjoint from editor checkpoints.
    private let key = "native-file-menu/v1/pending"
    init(binding: NativeExclusiveSessionBinding) { self.binding = binding }
    private var scope: [String: String] { ["vaultId": binding.localStoreId, "clientId": binding.session.vault.clientId] }
    private static func decimal(_ value: String) -> Bool { UInt64(value).map { String($0) == value && $0 > 0 } == true }
    private func wire<T: Decodable>(_ command: [String: Any], body: Data = Data(), as: T.Type) async throws -> (T, Data) {
        guard let admission = admission else { throw NativeFileActionFailure.unavailable }
        requestId += 1
        let id = String(requestId)
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "request_id": id,
            "command": command, "lease": admission.wireReference])
        guard bytes.count <= 1_048_576, body.count <= 65_536, let header = String(data: bytes, encoding: .utf8) else {
            throw NativeFileActionFailure.invalidName
        }
        let response: (String, String) = try await withCheckedThrowingContinuation { continuation in
            binding.session.request(header: header, body: body.base64EncodedString()) { continuation.resume(with: $0) }
        }
        guard let header = response.0.data(using: .utf8), response.1.utf8.count <= ((65_536 + 2) / 3) * 4,
              let payload = Data(base64Encoded: response.1), payload.count <= 65_536 else { throw NativeFileActionFailure.invalidReply }
        let reply = try JSONDecoder().decode(Envelope<T>.self, from: header)
        guard reply.version == 1, reply.request_id == id else { throw NativeFileActionFailure.invalidReply }
        if !reply.ok {
            guard payload.isEmpty, reply.result == nil, let error = reply.error,
                  !error.code.isEmpty, error.code.utf8.count <= 64,
                  error.code.utf8.allSatisfy({ (97...122).contains($0) || $0 == 95 }) else { throw NativeFileActionFailure.invalidReply }
            throw Rejected(code: error.code, uncertain: error.commit_uncertain)
        }
        guard reply.error == nil, let result = reply.result else { throw NativeFileActionFailure.invalidReply }
        return (result, payload)
    }
    private func checkHead(_ head: Head, body: Data) throws {
        guard head.version == 1, head.vaultId == binding.localStoreId, head.clientId == binding.session.vault.clientId,
              head.key == key, UUID(uuidString: head.revision)?.uuidString.lowercased() == head.revision,
              Self.decimal(head.sequence), head.byteLength == body.count,
              !head.deleted || body.isEmpty else { throw NativeFileActionFailure.invalidReply }
    }
    private func load() async throws -> (Head?, Data) {
        let (reply, body) = try await wire(["method": "checkpoint_load", "scope": scope, "key": key], as: CheckpointReply.self)
        if let head = reply.checkpoint { try checkHead(head, body: body) }
        else if !body.isEmpty { throw NativeFileActionFailure.invalidReply }
        return (reply.checkpoint, body)
    }
    private func persist(_ job: Journal?, after: Head?) async throws -> Head {
        let body = try job.map { try JSONEncoder().encode($0) } ?? Data()
        let revision = UUID().uuidString.lowercased()
        // Both CAS attempts retain identical bytes/revision after a lost ACK.
        let command: [String: Any] = ["method": "checkpoint_cas", "scope": scope, "key": key,
            "expected_revision": after.map { $0.revision as Any } ?? NSNull(), "next_revision": revision, "has_state": job != nil]
        var failure: Error = NativeFileActionFailure.pending
        for _ in 0..<2 {
            do {
                let (reply, bytes) = try await wire(command, body: body, as: CheckpointReply.self)
                guard let head = reply.checkpoint else { throw NativeFileActionFailure.invalidReply }
                try checkHead(head, body: bytes)
                guard head.revision == revision, head.deleted == (job == nil), bytes == body else { throw NativeFileActionFailure.invalidReply }
                return head
            } catch { failure = error }
        }
        throw failure
    }
    private func prepare(_ input: NativeFileActionRequest) async throws -> Journal {
        guard NativeFileRowAction.supported.contains(input.action) else { throw NativeFileActionFailure.authorityBlocked }
        let listing: NativeVaultListing = try await withCheckedThrowingContinuation { continuation in
            binding.session.pageListing { continuation.resume(with: $0) }
        }
        guard listing.localStoreId == binding.localStoreId,
              let current = listing.entries.first(where: { $0.id == input.source.id }),
              current.revision == input.source.revision, current.kind == input.source.kind,
              NativeFileEntry.samePath(current.path, input.source.path) else { throw NativeFileActionFailure.changed }
        var destination: String?
        if input.action != .delete {
            let folder = input.folderId.flatMap { id in listing.entries.first { $0.id == id && $0.kind == .folder } }
            guard let selected = input.destinationParent else { throw NativeFileActionFailure.authorityBlocked }
            try selected.validate()
            guard selected.id == input.folderId,
                  (selected.id == nil && folder == nil && selected.path.isEmpty) ||
                    (folder?.id == selected.id && folder?.revision == selected.revision &&
                     folder.map { NativeFileEntry.samePath($0.path, selected.path) } == true) else { throw NativeFileActionFailure.changed }
            guard !input.name.isEmpty, input.name.utf8.count <= 255, !input.name.utf8.contains(47),
                  !input.name.utf8.contains(92), input.name != ".", input.name != ".." else { throw NativeFileActionFailure.invalidName }
            let path = (folder.map { $0.path + "/" } ?? "") + input.name
            guard NativeFileEntry.isVisiblePath(path), !NativeFileEntry.samePath(path, current.path),
                  !Array(path.utf8).starts(with: Array(current.path.utf8) + [47]),
                  !listing.entries.contains(where: { NativeFileEntry.samePath($0.path, path) }) else { throw NativeFileActionFailure.changed }
            destination = path
        }
        let job = Journal(version: 1, operationId: UUID().uuidString.lowercased(), action: input.action.rawValue,
                          entryId: current.id, revision: current.revision, path: current.path,
                          kind: current.kind.rawValue, destination: destination, destinationParent: input.destinationParent)
        try job.validate()
        return job
    }
    // nil input explicitly retries the exact journaled action, never a new ID.
    // Success returns whether physical projection remains pending.
    func run(_ input: NativeFileActionRequest?) async -> Result<Bool, Error> {
        do {
            admission = try await withCheckedThrowingContinuation { continuation in
                binding.session.acquireNativeAdmission(expectedStoreId: binding.localStoreId) { continuation.resume(with: $0) }
            }
        } catch {
            // No authority is not proof of release. The lender must retain its
            // current ticket and expose recovery without touching another owner.
            binding.finish(.failure(error))
            return .failure(error)
        }
        let outcome: Result<Bool, Error>
        do {
            let (old, bytes) = try await load()
            let job: Journal
            let head: Head
            if let old = old, !old.deleted {
                guard input == nil else { throw NativeFileActionFailure.previousPending }
                job = try JSONDecoder().decode(Journal.self, from: bytes)
                try job.validate()
                head = old
            } else {
                guard let input = input else { throw NativeFileActionFailure.unavailable }
                job = try await prepare(input)
                head = try await persist(job, after: old) // Durable BEFORE mutation dispatch.
            }
            // Query the exact original composite before retry. A committed
            // legacy unguarded command remains queryable without upgrading it.
            var status = try await originalStatus(job, method: "file_command_status")
            if status.status == "not_committed" {
                guard job.action == "delete" || job.destinationParent != nil else {
                    throw NativeFileActionFailure.authorityBlocked
                }
                do { status = try await originalStatus(job, method: "file_command_compact") }
                catch let rejected as Rejected {
                    // Retain even a definite rejection here: no new operation ID
                    // or current-listing-based disposal is part of native review.
                    _ = rejected
                    throw NativeFileActionFailure.pending
                }
            }
            guard try validate(status, for: job) else { throw NativeFileActionFailure.pending }
            // Root-approved durable handoff: validated committed+pending proves
            // original Rust publication responsibility; it is not filesystem
            // completion. Retire only our exact CAS journal, then release ACK.
            _ = try await persist(nil, after: head)
            outcome = .success(status.projection == "pending")
        } catch { outcome = .failure(error) }
        return await returnHost(outcome)
    }

    // Read only this consumer-owned checkpoint, under a temporary exact lease.
    // Absence/tombstone is the sole clear result; current files never prove it.
    func probe() async -> Result<Bool, Error> {
        do {
            admission = try await withCheckedThrowingContinuation { continuation in
                binding.session.acquireNativeAdmission(expectedStoreId: binding.localStoreId) { continuation.resume(with: $0) }
            }
        } catch { binding.finish(.failure(error)); return .failure(error) }
        let outcome: Result<Bool, Error>
        do {
            let (head, bytes) = try await load()
            if let head = head, !head.deleted {
                let job = try JSONDecoder().decode(Journal.self, from: bytes)
                try job.validate()
                outcome = .success(true)
            } else { outcome = .success(false) }
        } catch { outcome = .failure(error) }
        return await returnHost(outcome)
    }

    private func returnHost(_ outcome: Result<Bool, Error>) async -> Result<Bool, Error> {
        do {
            guard let admission = admission else { throw NativeFileActionFailure.invalidReply }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                binding.session.releaseNativeAdmission(admission) { continuation.resume(with: $0) }
            }
            // Malformed native records are fenced even after a clean release.
            if case .failure(let failure) = outcome, !(failure is NativeFileActionFailure) || failure as? NativeFileActionFailure == .invalidReply {
                binding.finish(.failure(failure))
            } else { binding.finish(.success(())) }
            return outcome
        } catch {
            binding.finish(.failure(error))
            return .failure(error)
        }
    }
}

private enum NativeMenuRecovery { case checking, clear, pending, blocked, unavailable }

// Presentation state and local preferences belong to this model; UIKit owns the
// push/pop flow and Rust owns the snapshot. No parallel SwiftUI navigation stack.
@MainActor
private final class NativePagesModel: ObservableObject {
    let vault: LocalVault
    @Published var documentTabSourceSuspended = false
    @Published var canShowDocumentTabs = false
    @Published var canOpenInNewTab = false
    @Published var canRouteDocument = true
    @Published var canRouteCreate = true
    @Published var canRouteChooseVault = true
    @Published var recovery: NativeMenuRecovery = .checking
    @Published var ownershipRecoveryBusy = false
    var admissionBlocked: Bool { recovery != .clear }
    @Published var nativeOperationBusy = false
    @Published var fileActionStatus = ""
    @Published var fileActionPending = false
    var fileActionsAvailable: Bool { !loading && !searchLoading && !searchAdmissionBusy && !nativeOperationBusy && !admissionBlocked && !documentTabSourceSuspended }
    @Published private(set) var navigation = NativeNavigationPreferences()
    private(set) var navigationRevision: UInt64 = 0
    var unusedNavigationItems: [NativeNavigationItem] { NativeNavigationItem.allCases.filter { !navigation.items.contains($0) } }
    func setNavigationItems(_ items: [NativeNavigationItem]) {
        guard !items.isEmpty else { return }
        navigationRevision &+= 1
        navigation.replace(items)
    }
    func addNavigationItem(_ item: NativeNavigationItem) {
        guard !navigation.items.contains(item) else { return }
        setNavigationItems(navigation.items + [item])
    }
    func removeNavigationItem(_ item: NativeNavigationItem) {
        guard navigation.items.count > 1 else { return }
        setNavigationItems(navigation.items.filter { $0 != item })
    }
    func moveNavigationItem(_ item: NativeNavigationItem, by offset: Int) {
        guard let index = navigation.items.firstIndex(of: item) else { return }
        let destination = index + offset
        guard navigation.items.indices.contains(destination) else { return }
        var items = navigation.items
        items.swapAt(index, destination)
        setNavigationItems(items)
    }
    @Published private(set) var fieldMode: NativeNotesFieldMode = .search
    @Published private(set) var searchQuery = ""
    func toggleFieldMode() {
        fieldMode = fieldMode == .search ? .actions : .search
        searchHits = []
        searchStatus = ""
        onSearch?(fieldMode == .search ? searchQuery : "")
    }
    func leaveActionMode() {
        fieldMode = .search
        setSearch("")
    }
    func showPage(_ page: NativePage) {
        applyRoute(page: page, folder: nil)
        onRouteChanged?(currentRoute)
    }
    func canPerform(_ action: NativePageAction) -> Bool {
        guard !nativeOperationBusy, !documentTabSourceSuspended else { return false }
        if admissionBlocked, action != .settings && action != .chooseVault { return false }
        switch action {
        case .newNote: return canRouteCreate && canCreateNote && !searchLoading && !searchAdmissionBusy
        case .recents: return !loading && !searchAdmissionBusy
        case .files: return !loading && !searchAdmissionBusy
        case .settings: return true
        case .chooseVault: return canRouteChooseVault
        }
    }
    var matchingActions: [NativePageAction] {
        NativePageAction.allCases.filter { searchQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(searchQuery) }
    }
    @Published private(set) var searchAdmissionBusy = false
    @Published private(set) var searchLoading = false
    @Published private(set) var searchHits: [NativeSearchHit] = []
    @Published private(set) var searchStatus = ""
    var onSearch: ((String) -> Void)?
    func setSearch(_ query: String) {
        searchQuery = query
        searchHits = []
        searchStatus = ""
        onSearch?(fieldMode == .search ? query : "")
    }
    func showSearchProgress(_ progress: NativeSearchProgress) {
        switch progress {
        case .preparing(let prepared, let total): searchStatus = "Preparing search: \(prepared) of \(total) documents…"
        case .searching: searchStatus = "Searching note content…"
        }
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
        fieldMode = .search
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
    var showInitialSkeleton: Bool { loading && listing == nil }

    func setLoading() {
        loading = true
        status = listing == nil ? "Loading vault…" : ""
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
        guard supports(page), preferences.selected != page || fieldMode == .actions else { return }
        fieldMode = .search
        if !searchQuery.isEmpty { setSearch("") }
        preferences.selected = page
        preferences.persist()
        focusedEntryId = nil
        render()
        onRouteChanged?(currentRoute)
    }
    func beginSettingsPresentation() {
        fieldMode = .search
        if !searchQuery.isEmpty { setSearch("") }
        // Opening a sheet is newer UI intent too. Cancel any staged route/file
        // admission without changing the current Notes mode or route history.
        onRouteChanged?(currentRoute)
    }
    func enter(_ folder: NativeFileEntry) {
        guard !loading, folder.kind == .folder else { return }
        fieldMode = .search
        if !searchQuery.isEmpty { setSearch("") }
        self.folder = folder.path
        folderId = folder.id
        render()
        onRouteChanged?(currentRoute)
    }
    func parentFolder() {
        guard !loading else { return }
        fieldMode = .search
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
        if loading && listing == nil { emptyMessage = "" }
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
    // Root owns tab metadata/activation. No dependency on its draft coordinator.
    var onShowDocumentTabs: (() -> Void)? { didSet { updateDocumentTabRouting() } }
    var onOpenDocument: ((NativeFileEntry, Bool) -> Void)? { didSet { updateDocumentTabRouting() } }
    var onCreateNote: (() -> Void)? { didSet { updateDocumentTabRouting() } }
    var onChooseVault: (() -> Void)? { didSet { updateDocumentTabRouting() } }
    private var documentTabRoutingConfigured: Bool {
        onShowDocumentTabs != nil || onOpenDocument != nil || onCreateNote != nil || onChooseVault != nil
    }
    private func updateDocumentTabRouting() {
        coordinator.invalidateDocumentTabRetirement() // A new root configuration cannot inherit an old close fact.
        model.canShowDocumentTabs = onShowDocumentTabs != nil
        model.canOpenInNewTab = onOpenDocument != nil
        model.canRouteDocument = !documentTabRoutingConfigured || onOpenDocument != nil
        model.canRouteCreate = !documentTabRoutingConfigured || onCreateNote != nil
        model.canRouteChooseVault = !documentTabRoutingConfigured || onChooseVault != nil
    }
    // A terminal fact for this exact retained controller. Root must also match
    // its captured owner/source; this is never foreground/navigation authority.
    // Successfully retired instances cannot reopen another host.
    var documentTabTransitionRetired: Bool { coordinator.documentTabTransitionRetired }
    func prepareForDocumentTabTransition(completion: @escaping (Result<Void, Error>) -> Void) {
        viewIfLoaded?.endEditing(true)
        coordinator.prepareForDocumentTabTransition(completion: completion)
    }
    func resumeAfterDocumentTabOverview() { coordinator.resumeAfterDocumentTabOverview() }

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
        let pages = NativePagesView(model: model, fileAction: { [weak self] action, entry in self?.fileAction(action, entry: entry) }, retryFileAction: { [weak self] in self?.retryFileAction() }, checkOwnership: { [weak self] in self?.coordinator.recheckOwnership() }, navigate: { [weak self] direction in self?.coordinator.traverse(direction) }, open: { [weak self] entry in
            guard let self = self else { return }
            self.requestOpen(entry, inNewTab: false)
        }, showDocumentTabs: { [weak self] in
            guard let self = self, !self.model.documentTabSourceSuspended, !self.model.nativeOperationBusy else { return }
            self.onShowDocumentTabs?()
        }, openInNewTab: { [weak self] entry in self?.requestOpen(entry, inNewTab: true) }, showSettings: { [weak self] in self?.showSettings() }, chooseVault: { [weak self] in self?.requestChooseVault() }, refresh: { [weak self] in
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
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Do not disable an in-progress Settings swipe-back in viewWillAppear.
        // Once settled, root/editor admission regains the existing pop guard.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
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
    // Returns true whenever root routing is configured, including a missing
    // callback: partial configuration must never fall through to a second host.
    fileprivate func routeDocumentThroughRoot(_ entry: NativeFileEntry, inNewTab: Bool) -> Bool {
        guard documentTabRoutingConfigured else { return false }
        guard !model.documentTabSourceSuspended, !model.admissionBlocked, !model.nativeOperationBusy, let open = onOpenDocument else {
            model.fileActionStatus = "Document tabs are not ready to open this file safely."
            return true
        }
        model.willOpen(entry)
        open(entry, inNewTab)
        return true
    }
    private func requestOpen(_ entry: NativeFileEntry?, inNewTab: Bool) {
        guard !model.documentTabSourceSuspended, !model.admissionBlocked, !model.nativeOperationBusy, !model.searchAdmissionBusy,
              !model.searchLoading, !model.loading else { return }
        if let entry = entry {
            guard entry.kind == .file else { return }
            if routeDocumentThroughRoot(entry, inNewTab: inNewTab) { return }
            guard !inNewTab else { return }
        } else if documentTabRoutingConfigured {
            guard let create = onCreateNote else {
                model.fileActionStatus = "Document tabs are not ready to create a note safely."
                return
            }
            create()
            return
        }
        model.willOpen(entry)
        coordinator.openEditor(entry: entry, origin: model.preferences.selected.title)
    }

    private func fileAction(_ action: NativeFileRowAction, entry: NativeFileEntry) {
        guard NativeFileRowAction.supported.contains(action), model.fileActionsAvailable,
              presentedViewController == nil, navigationController?.topViewController === self else { return }
        view.endEditing(true)
        coordinator.lendSession { [weak self] result in
            guard case .success(let (binding, listing)) = result else {
                self?.model.fileActionStatus = "File actions are unavailable. Wait for loading to finish and try again."
                return
            }
            guard let self = self, self.navigationController?.topViewController === self,
                  UIApplication.shared.applicationState == .active else { binding.finish(.success(())); return }
            guard let current = listing.entries.first(where: { $0.id == entry.id }),
                  current.revision == entry.revision, current.kind == entry.kind,
                  NativeFileEntry.samePath(current.path, entry.path) else {
                binding.finish(.success(()))
                self.model.fileActionStatus = "This item changed. Open its current menu and try again."
                return
            }
            switch action {
            case .rename:
                let alert = UIAlertController(title: "Rename", message: "Enter a file or folder name, including its extension.", preferredStyle: .alert)
                alert.addTextField { field in field.text = entry.name; field.autocorrectionType = .no; field.autocapitalizationType = .none }
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in binding.finish(.success(())) })
                alert.addAction(UIAlertAction(title: "Rename", style: .default) { [weak self, weak alert] _ in
                    guard let self = self else { binding.finish(.success(())); return }
                    let parent = listing.entries.first { $0.kind == .folder && NativeFileEntry.samePath($0.path, entry.parent) }
                    guard entry.parent.isEmpty || parent != nil else {
                        binding.finish(.success(())); self.model.fileActionStatus = "The parent folder changed. Try again."; return
                    }
                    self.executeFileAction(binding, input: NativeFileActionRequest(source: entry, action: .rename,
                        folderId: parent?.id, name: alert?.textFields?.first?.text ?? "",
                        destinationParent: parent.map(NativeDestinationWitness.init) ?? .root))
                })
                self.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
            case .delete:
                let message = entry.kind == .folder
                    ? "Delete this folder and everything inside it? There is no undo in this menu."
                    : "Delete this file? There is no undo in this menu."
                let alert = UIAlertController(title: "Delete “\(entry.name)” ?", message: message, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in binding.finish(.success(())) })
                alert.addAction(UIAlertAction(title: "Delete", style: .destructive) { [weak self] _ in
                    guard let self = self else { binding.finish(.success(())); return }
                    self.executeFileAction(binding, input: NativeFileActionRequest(source: entry, action: .delete, folderId: nil, name: ""))
                })
                self.present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
            case .move:
                let picker = NativeMoveDestinationController(entries: listing.entries, source: entry) { [weak self] destination in
                    guard let self = self else { binding.finish(.success(())); return }
                    self.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) {
                        guard let destination = destination else { binding.finish(.success(())); return }
                        self.executeFileAction(binding, input: NativeFileActionRequest(source: entry, action: .move,
                            folderId: destination.id, name: entry.name, destinationParent: destination.parent))
                    }
                }
                let navigation = UINavigationController(rootViewController: picker)
                navigation.isModalInPresentation = true // Cancel owns returning the exclusive host.
                self.present(navigation, animated: !UIAccessibility.isReduceMotionEnabled)
            case .duplicate, .share: binding.finish(.success(())) // Not advertised without a real binding.
            }
        }
    }

    private func executeFileAction(_ binding: NativeExclusiveSessionBinding, input: NativeFileActionRequest?) {
        guard UIApplication.shared.applicationState == .active else {
            binding.finish(.success(())); model.fileActionStatus = "Action cancelled while the app was inactive."; return
        }
        model.fileActionStatus = "Applying file action…"
        Task { @MainActor [weak self] in
            let result = await NativeFileCommand(binding: binding).run(input)
            guard let self = self else { return }
            switch result {
            case .success(let pending):
                self.model.recovery = .checking
                self.model.fileActionPending = false
                self.model.fileActionStatus = pending ? "Change saved. Updating files is still pending." : ""
            case .failure(let error):
                if let authority = error as? NativeSessionOperationFailure, !authority.sessionFenced {
                    self.model.fileActionStatus = "Session ownership is not available. Use Check session ownership after the current operation finishes."
                    return
                }
                switch error as? NativeFileActionFailure {
                case .recoveryRequired: self.model.fileActionStatus = "Review the saved native action first."
                case .authorityBlocked: self.model.fileActionStatus = "This action needs the atomic Rust destination/status capability. The saved operation is retained unchanged."
                case .unavailable:
                    self.model.fileActionPending = false
                    self.model.fileActionStatus = "No saved action was found. Pull down to check the vault again."
                case .changed: self.model.fileActionStatus = "This item or destination changed. Open its current menu and try again."
                case .invalidName: self.model.fileActionStatus = "Use a valid name of at most 255 bytes without a slash."
                case .previousPending, .pending:
                    self.model.recovery = .pending
                    self.model.fileActionPending = true
                    self.model.fileActionStatus = "A file action needs confirmation. Review it before making another change."
                case .rejected: self.model.fileActionStatus = "The file action was rejected. Reload the current item before trying again."
                default:
                    self.model.fileActionPending = true
                    self.model.fileActionStatus = "The action could not be confirmed safely. A pending action may remain; reopen the vault, then review it."
                }
            }
            UIAccessibility.post(notification: .announcement, argument: self.model.fileActionStatus.isEmpty ? "File action finished" : self.model.fileActionStatus)
        }
    }

    private func retryFileAction() {
        if model.recovery == .unavailable {
            Task { @MainActor [weak self] in await self?.coordinator.reload() }
            return
        }
        guard !model.nativeOperationBusy, !model.loading, presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Retry pending file action?",
            message: "This retries the exact previously confirmed action, which may rename, move or delete an item. It does not create a new action.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Retry action", style: .destructive) { [weak self] _ in
            guard let self = self else { return }
            self.coordinator.lendSession(review: true) { [weak self] result in
                if case .success(let (binding, _)) = result {
                    guard let self = self else { binding.finish(.success(())); return }
                    self.executeFileAction(binding, input: nil)
                } else {
                    self?.model.fileActionStatus = "Could not obtain safe ownership. Pull down to reopen and check the saved action."
                }
            }
        })
        present(alert, animated: !UIAccessibility.isReduceMotionEnabled)
    }

    private func showSettings() {
        guard !model.documentTabSourceSuspended, !model.nativeOperationBusy else { return }
        guard let navigation = navigationController, navigation.topViewController === self else { return }
        view.endEditing(true)
        model.beginSettingsPresentation() // Invalidates any pending file-open/search admission.
        let settings = NativeSettingsPageController(page: .settings, rootView: AnyView(
            NativeSettingsView(model: model, back: { [weak self] in self?.popSettingsPage(.settings) },
                               configure: { [weak self] in self?.showNavigationConfiguration() },
                               chooseVault: { [weak self] in self?.chooseVaultFromSettings() })))
        navigation.pushViewController(settings, animated: !UIAccessibility.isReduceMotionEnabled)
    }
    private func showNavigationConfiguration() {
        guard let navigation = navigationController,
              let page = navigation.topViewController as? NativeSettingsPageController, page.page == .settings else { return }
        let configuration = NativeSettingsPageController(page: .navigationBar, rootView: AnyView(
            NativeNavigationConfigurationView(model: model, back: { [weak self] in self?.popSettingsPage(.navigationBar) })))
        navigation.pushViewController(configuration, animated: !UIAccessibility.isReduceMotionEnabled)
    }
    private func popSettingsPage(_ expected: NativeSettingsPageController.Page) {
        guard let navigation = navigationController,
              let page = navigation.topViewController as? NativeSettingsPageController, page.page == expected else { return }
        navigation.popViewController(animated: !UIAccessibility.isReduceMotionEnabled)
    }
    // Root owns draining the matching Pages source and the eventual foreground
    // popToRoot. A configured callback never closes or pops locally.
    private func routeChooseVaultThroughRoot() -> Bool {
        guard documentTabRoutingConfigured else { return false }
        guard !model.documentTabSourceSuspended, !model.nativeOperationBusy, let choose = onChooseVault else {
            model.fileActionStatus = "Document navigation is not ready to choose a vault safely."
            return true
        }
        choose()
        return true
    }
    private func requestChooseVault() {
        guard !model.documentTabSourceSuspended, !model.nativeOperationBusy else { return }
        if routeChooseVaultThroughRoot() { return }
        coordinator.chooseVault()
    }

    private func chooseVaultFromSettings() {
        guard let navigation = navigationController, navigation.viewControllers.contains(where: { $0 === self }),
              navigation.topViewController is NativeSettingsPageController else { return }
        if routeChooseVaultThroughRoot() { return }
        // All four callbacks are unset: retain the legacy unconfigured route.
        // Queue cleanup, then let settled Pages appearance drain the intent.
        coordinator.chooseVault()
        navigation.popToViewController(self, animated: !UIAccessibility.isReduceMotionEnabled)
    }
    fileprivate func setDocumentTabSourceSuspended(_ value: Bool) { model.documentTabSourceSuspended = value }
    fileprivate func setRecovery(_ value: NativeMenuRecovery) {
        model.recovery = value
        model.fileActionPending = value == .pending || value == .unavailable
    }
    fileprivate func setOwnershipRecoveryBusy(_ value: Bool) { model.ownershipRecoveryBusy = value }
    fileprivate func setNativeOperationBusy(_ value: Bool) { model.nativeOperationBusy = value }
    fileprivate var searchQuery: String { model.fieldMode == .search ? model.searchQuery : "" }
    fileprivate func showSearchProgress(_ progress: NativeSearchProgress) { model.showSearchProgress(progress) }
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
    let fileAction: (NativeFileRowAction, NativeFileEntry) -> Void
    let retryFileAction: () -> Void
    let checkOwnership: () -> Void
    let navigate: (Int) -> Void
    let open: (NativeFileEntry?) -> Void
    let showDocumentTabs: () -> Void
    let openInNewTab: (NativeFileEntry) -> Void
    let showSettings: () -> Void
    let chooseVault: () -> Void
    let refresh: () async -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace
    @AccessibilityFocusState private var focus: Focus?
    @FocusState private var fieldFocused: Bool

    private enum Focus: Hashable { case settings, fieldMode, compose, tabs, heading, folderHeading, entry(String) }
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
                ForEach(model.navigation.items) { item in
                    navigationPage(item).tabItem {
                        Label(item.title, systemImage: item.symbol)
                            .accessibilityIdentifier("native.pages.tab.\(item.rawValue)")
                    }.tag(item)
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
    }

    @ViewBuilder private func navigationPage(_ item: NativeNavigationItem) -> some View {
        switch item { case .notes: pageContent }
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
            .disabled(model.nativeOperationBusy || model.documentTabSourceSuspended)
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
            if !model.fileActionStatus.isEmpty {
                Text(model.fileActionStatus).font(.footnote).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 20)
                    .accessibilityIdentifier("native.file-action.status")
            }
            if model.recovery == .checking {
                Text("Checking saved native actions…").font(.footnote).padding(.horizontal, 20)
                    .accessibilityIdentifier("native.file-action.checking")
            }
            if model.recovery == .blocked {
                Text("Another native operation still owns this session. Wait for it to finish, then check ownership. This page will not close or release that operation.")
                    .font(.footnote).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 20)
                Button("Check session ownership", action: checkOwnership)
                    .frame(minHeight: 44).padding(.horizontal, 20)
                    .disabled(model.ownershipRecoveryBusy)
                    .accessibilityIdentifier("native.file-action.check-ownership")
            }
            if model.fileActionPending {
                Text("A saved native file action needs review before opening notes or starting another operation.")
                    .font(.footnote).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 20)
                Button("Review pending file action", action: retryFileAction)
                    .frame(minHeight: 44).padding(.horizontal, 20)
                    .disabled(model.loading || model.searchAdmissionBusy || model.nativeOperationBusy)
                    .accessibilityIdentifier("native.file-action.retry")
            }
            if model.isInFolder {
                Button { withAnimation(motion) { model.parentFolder() }; focus = currentHeadingFocus } label: {
                    Label("Parent folder", systemImage: "chevron.left").frame(minHeight: 44)
                }
                .padding(.horizontal, 20)
                .accessibilityIdentifier("native.files.parent")
                .disabled(model.loading || model.nativeOperationBusy || model.documentTabSourceSuspended)
            }
            Group {
                if model.fieldMode == .actions { actionList }
                else if model.searchQuery.isEmpty { entryList } else { searchList }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Color.clear.frame(height: 84).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            composeControl.padding(.trailing, 20).padding(.bottom, 16)
        }
    }

    private var composeControl: some View {
        Button { fieldFocused = false; open(nil) } label: {
            Image(systemName: "square.and.pencil").font(.title2.weight(.semibold))
                .frame(width: 60, height: 60)
        }
        .buttonStyle(.plain)
        .modifier(PageControlSurface(id: "compose", namespace: glassNamespace))
        .accessibilityLabel("New note")
        .accessibilityIdentifier("native.pages.new-note")
        .disabled(!model.canRouteCreate || !model.canCreateNote || model.searchLoading || model.searchAdmissionBusy || model.nativeOperationBusy || model.admissionBlocked || model.documentTabSourceSuspended)
        .accessibilityFocused($focus, equals: .compose)
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
                    fieldFocused = false
                    showSettings()
                } label: {
                    Image(systemName: "gearshape").padding(12).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .modifier(PageControlSurface(id: "settings", namespace: glassNamespace))
                .disabled(model.nativeOperationBusy || model.documentTabSourceSuspended)
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("native.pages.settings")
                .accessibilityFocused($focus, equals: .settings)
            }
            HStack(spacing: 8) {
                Button {
                    withAnimation(motion) { model.toggleFieldMode() }
                } label: {
                    Image(systemName: model.fieldMode == .search ? "magnifyingglass" : "command")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.fieldMode == .search ? "Switch to app actions" : "Switch to note search")
                .accessibilityValue(model.fieldMode == .search ? "Note content search" : "App actions")
                .accessibilityIdentifier("native.search.mode")
                .accessibilityFocused($focus, equals: .fieldMode)
                TextField(model.fieldMode == .search ? "Search note content" : "Find an action", text: Binding(get: { model.searchQuery }, set: { model.setSearch($0) }))
                    .font(.body)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .submitLabel(.search)
                    .focused($fieldFocused)
                    .onSubmit {
                        if model.fieldMode == .actions {
                            if let action = model.matchingActions.first, model.canPerform(action) { perform(action) }
                        } else { model.setSearch(model.searchQuery) }
                    }
                    .accessibilityIdentifier("native.search.field")
                if !model.searchQuery.isEmpty {
                    Button { model.setSearch("") } label: {
                        Image(systemName: "xmark.circle.fill").frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.fieldMode == .search ? "Clear search" : "Clear action filter")
                    .accessibilityIdentifier("native.search.clear")
                }
            }
            .padding(.trailing, model.searchQuery.isEmpty ? 14 : 0)
            .frame(maxWidth: .infinity, minHeight: 44)
            .modifier(PageControlSurface(id: "search", namespace: glassNamespace))
            .disabled(model.nativeOperationBusy || model.admissionBlocked || model.documentTabSourceSuspended)
            Button { fieldFocused = false; showDocumentTabs() } label: {
                Image(systemName: "square.on.square").padding(12).frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .modifier(PageControlSurface(id: "tabs", namespace: glassNamespace))
            .accessibilityLabel("Show tabs")
            .accessibilityIdentifier("native.pages.show-tabs")
            .disabled(!model.canShowDocumentTabs || model.nativeOperationBusy || model.documentTabSourceSuspended)
            .accessibilityFocused($focus, equals: .tabs)
        }
        .font(.system(size: 17))
        .foregroundColor(.primary)
    }

    private func perform(_ action: NativePageAction) {
        guard model.canPerform(action) else { return }
        fieldFocused = false
        model.leaveActionMode()
        switch action {
        case .newNote: open(nil)
        case .recents: withAnimation(motion) { model.showPage(.recents) }; focus = .heading
        case .files: withAnimation(motion) { model.showPage(.files) }; focus = .heading
        case .settings: showSettings()
        case .chooseVault: chooseVault()
        }
    }

    private var actionList: some View {
        List {
            if model.matchingActions.isEmpty {
                Text("No matching app actions.").foregroundColor(.secondary)
                    .accessibilityIdentifier("native.actions.empty")
            }
            ForEach(model.matchingActions) { action in
                Button { perform(action) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: action.symbol).frame(width: 28).accessibilityHidden(true)
                        Text(action.title).font(.body)
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canPerform(action))
                .accessibilityIdentifier("native.actions.\(action.rawValue)")
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        .accessibilityIdentifier("native.actions.entries")
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
                .disabled(model.searchLoading || model.searchAdmissionBusy || model.loading || model.nativeOperationBusy || model.admissionBlocked || !model.canRouteDocument || model.documentTabSourceSuspended)
                .accessibilityIdentifier("native.search.result.\(hit.entry.id).\(hit.line)")
                .accessibilityHint("Opens the current note in the editor")
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        .accessibilityIdentifier("native.search.results")
        .refreshable { await refresh() }
    }

    @ViewBuilder private func contextRow<Content: View>(_ entry: NativeFileEntry, @ViewBuilder content: () -> Content) -> some View {
        if #available(iOS 16, *) {
            NativeFileContextRow(content: content(), enabled: model.fileActionsAvailable,
                                 menu: { fileMenu(entry) })
                .accessibilityActions {
                    if entry.kind == .file, model.canOpenInNewTab {
                        Button("Open in new tab") { if model.fileActionsAvailable { openInNewTab(entry) } }
                    }
                    ForEach(NativeFileRowAction.supported, id: \.rawValue) { action in
                        Button(action.title) { if model.fileActionsAvailable { fileAction(action, entry) } }
                    }
                }
        } else {
            content().contextMenu {
                if model.fileActionsAvailable {
                    if entry.kind == .file, model.canOpenInNewTab {
                        Button { openInNewTab(entry) } label: { Label("Open in new tab", systemImage: "plus.square.on.square") }
                        Divider()
                    }
                    ForEach(NativeFileRowAction.supported, id: \.rawValue) { action in
                        Button(role: action == .delete ? .destructive : nil) { fileAction(action, entry) }
                        label: { Label(action.title, systemImage: action.symbol) }
                    }
                }
            }
        }
    }

    @available(iOS 16, *)
    private func fileMenu(_ entry: NativeFileEntry) -> UIMenu {
        func action(_ value: NativeFileRowAction) -> UIAction {
            UIAction(title: value.title, image: UIImage(systemName: value.symbol),
                     attributes: value == .delete ? .destructive : []) { _ in fileAction(value, entry) }
        }
        // Medium is the public horizontal icon-above-label layout. Duplicate
        // and Share remain absent until their reviewed native bindings are wired.
        let primaryActions = [NativeFileRowAction.duplicate, .move, .share].filter { NativeFileRowAction.supported.contains($0) }
        let primary = UIMenu(options: .displayInline, children: primaryActions.map(action))
        primary.preferredElementSize = .medium
        let secondary = UIMenu(options: .displayInline, children: [NativeFileRowAction.rename, .delete].filter { NativeFileRowAction.supported.contains($0) }.map(action))
        var groups: [UIMenuElement] = primaryActions.isEmpty ? [secondary] : [primary, secondary]
        if entry.kind == .file, model.canOpenInNewTab {
            let open = UIAction(title: "Open in new tab", image: UIImage(systemName: "plus.square.on.square")) { _ in openInNewTab(entry) }
            groups.insert(UIMenu(options: .displayInline, children: [open]), at: 0)
        }
        return UIMenu(children: groups)
    }

    private func entryRow(_ entry: NativeFileEntry) -> some View {
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
                    .disabled(model.loading || model.nativeOperationBusy || model.documentTabSourceSuspended)
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
            .disabled(model.loading || model.searchAdmissionBusy || model.nativeOperationBusy || model.documentTabSourceSuspended || (entry.kind == .file && (model.admissionBlocked || !model.canRouteDocument)))
            .accessibilityFocused($focus, equals: .entry(entry.id))
        }
        .padding(.leading, CGFloat(min(model.depth(for: entry), 8)) * 12)
    }

    private var entryList: some View {
        ScrollViewReader { proxy in
            List {
                if model.showInitialSkeleton {
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
                    contextRow(entry) {
                        entryRow(entry)
                    }
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

}

// These are real navigation-controller children, never bar custom-view hosts.
@MainActor
private final class NativeSettingsPageController: UIHostingController<AnyView> {
    enum Page: Equatable { case settings, navigationBar }
    let page: Page
    init(page: Page, rootView: AnyView) {
        self.page = page
        super.init(rootView: rootView)
        view.backgroundColor = .systemBackground
        view.clipsToBounds = false
        view.accessibilityIdentifier = page == .settings ? "native.settings" : "native.navigation"
        view.isAccessibilityElement = false
    }
    @MainActor required dynamic init?(coder: NSCoder) { fatalError("Use native Settings navigation.") }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        // Only unleased native Settings pages use this gesture. NativePages
        // disables it again before an editor can be admitted.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }
}

@MainActor
private struct NativeSettingsHeader: View {
    let title: String
    let identifier: String
    let back: () -> Void
    @Namespace private var glassNamespace
    var body: some View {
        HStack(spacing: 12) {
            Button(action: back) {
                Image(systemName: "chevron.left").font(.body.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .modifier(PageControlSurface(id: "back", namespace: glassNamespace))
            .accessibilityLabel("Back")
            .accessibilityIdentifier("\(identifier).back")
            Text(title).font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("\(identifier).heading")
            Spacer(minLength: 0)
        }
        .foregroundColor(.primary)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}

@MainActor
private struct NativeSettingsView: View {
    @ObservedObject var model: NativePagesModel
    let back: () -> Void
    let configure: () -> Void
    let chooseVault: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            NativeSettingsHeader(title: "Settings", identifier: "native.settings", back: back).zIndex(1)
            List {
                Section {
                    Button(action: configure) {
                        HStack(spacing: 12) {
                            Label("Navigation bar", systemImage: "menubar.rectangle")
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").foregroundColor(.secondary).accessibilityHidden(true)
                        }.frame(minHeight: 44)
                    }
                    .foregroundColor(.primary)
                    .accessibilityIdentifier("native.settings.navigation-bar")
                }
                Section(header: Text("Vault")) {
                    Text("\(model.vault.name) · On this device").foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Choose vault", action: chooseVault).frame(minHeight: 44)
                        .disabled(!model.canRouteChooseVault || model.nativeOperationBusy || model.documentTabSourceSuspended)
                        .accessibilityIdentifier("native.settings.choose-vault")
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 44)
            .accessibilityIdentifier("native.settings.entries")
        }
        .background(Color(uiColor: .systemBackground))
    }
}

private enum NativeNavigationPlacement { case bar(Int), unused }
private enum NativeNavigationOrder {
    static func placing<Item: Equatable>(_ item: Item, before position: Int, in original: [Item]) -> [Item]? {
        guard (0...original.count).contains(position) else { return nil }
        var items = original.filter { $0 != item }
        var destination = position
        if let previous = original.firstIndex(of: item), previous < position { destination -= 1 }
        items.insert(item, at: min(destination, items.count))
        return items
    }
}

private struct NativeNavigationDrag {
    static let type = UTType(exportedAs: "app.zorid.native-navigation-item")
    struct Payload: Codable, Equatable { let token: String; let item: NativeNavigationItem }
    let payload: Payload
    let revision: UInt64
    let items: [NativeNavigationItem]
    func applyingDrop(_ bytes: Data, currentDrag: NativeNavigationDrag?, revision: UInt64,
                      currentItems: [NativeNavigationItem], active: Bool,
                      placement: NativeNavigationPlacement) -> [NativeNavigationItem]? {
        guard active, currentDrag?.payload == payload, revision == self.revision,
              currentItems == items, bytes.count <= 512,
              let received = try? JSONDecoder().decode(Payload.self, from: bytes), received == payload else { return nil }
        switch placement {
        case .unused:
            guard items.contains(payload.item) else { return nil }
            let remaining = items.filter { $0 != payload.item }
            return remaining.isEmpty ? nil : remaining
        case .bar(let position): return NativeNavigationOrder.placing(payload.item, before: position, in: items)
        }
    }
}

@MainActor
private struct NativeNavigationDrop: DropDelegate {
    let allowed: () -> Bool
    let receive: (NSItemProvider) -> Bool
    func validateDrop(info: DropInfo) -> Bool {
        allowed() && info.itemProviders(for: [NativeNavigationDrag.type]).count == 1
    }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: validateDrop(info: info) ? .move : .forbidden)
    }
    func performDrop(info: DropInfo) -> Bool {
        guard validateDrop(info: info), let provider = info.itemProviders(for: [NativeNavigationDrag.type]).first else { return false }
        return receive(provider)
    }
}

@MainActor
private struct NativeNavigationConfigurationView: View {
    @ObservedObject var model: NativePagesModel
    let back: () -> Void
    @State private var drag: NativeNavigationDrag?
    @State private var active = false
    @State private var dropError = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var glassNamespace
    private var motion: Animation? { reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.9) }

    var body: some View {
        VStack(spacing: 0) {
            NativeSettingsHeader(title: "Navigation bar", identifier: "native.navigation", back: back).zIndex(1)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(model.navigation.items.count > 1
                         ? "Drag items to reorder. Drop an item below to remove it."
                         : "Keep at least one page in the navigation bar.")
                        .font(.subheadline).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text("Navigation bar").font(.headline).accessibilityAddTraits(.isHeader)
                    barPreview
                    Text("Available pages").font(.headline).accessibilityAddTraits(.isHeader)
                    unusedItems
                    if !dropError.isEmpty {
                        Text(dropError).font(.footnote).foregroundColor(.secondary)
                            .accessibilityIdentifier("native.navigation.error")
                    }
                }
                .padding(20)
            }
            .accessibilityIdentifier("native.navigation.configuration")
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear { active = true }
        .onDisappear { active = false; drag = nil }
    }

    private var barPreview: some View {
        HStack(spacing: 8) {
            if model.navigation.items.isEmpty {
                Text("Drag Notes here, or use Add below.")
                    .font(.subheadline).foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 64)
                    .accessibilityIdentifier("native.navigation.empty")
            }
            ForEach(Array(model.navigation.items.enumerated()), id: \.element.id) { index, item in
                Menu {
                    Button("Move earlier") { edit { model.moveNavigationItem(item, by: -1) } }
                        .disabled(index == 0)
                    Button("Move later") { edit { model.moveNavigationItem(item, by: 1) } }
                        .disabled(index + 1 == model.navigation.items.count)
                    Button("Remove from navigation bar") { edit { model.removeNavigationItem(item) } }
                        .disabled(model.navigation.items.count <= 1)
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: item.symbol).font(.title3)
                        Text(item.title).font(.caption).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(minWidth: 64, maxWidth: .infinity, minHeight: 64)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(item.title)
                .accessibilityValue("Position \(index + 1) of \(model.navigation.items.count)")
                .accessibilityHint("Drag to move, or activate for move and remove actions")
                .accessibilityAddTraits(.isSelected)
                .accessibilityIdentifier("native.navigation.item.\(item.rawValue)")
                .onDrag { beginDrag(item) }
                .onDrop(of: [NativeNavigationDrag.type], delegate: drop(.bar(index)))
            }
        }
        .padding(12)
        .modifier(PageControlSurface(id: "navigation-preview", namespace: glassNamespace))
        .onDrop(of: [NativeNavigationDrag.type], delegate: drop(.bar(model.navigation.items.count)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("native.navigation.preview")
    }

    private var unusedItems: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.unusedNavigationItems.isEmpty {
                Text(model.navigation.items.count > 1
                     ? "All available pages are in the navigation bar. Drop an item here to remove it."
                     : "All available pages are in the navigation bar. Keep at least one page in the bar.")
                    .font(.subheadline).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.unusedNavigationItems) { item in
                HStack(spacing: 12) {
                    Label(item.title, systemImage: item.symbol).font(.body)
                    Spacer(minLength: 0)
                    Button("Add") { edit { model.addNavigationItem(item) } }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Add \(item.title) to navigation bar")
                        .accessibilityIdentifier("native.navigation.add.\(item.rawValue)")
                }
                .frame(minHeight: 44).contentShape(Rectangle())
                .onDrag { beginDrag(item) }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .padding(16)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .onDrop(of: [NativeNavigationDrag.type], delegate: drop(.unused))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("native.navigation.unused")
    }

    private func edit(_ change: () -> Void) {
        drag = nil // Invalidate delayed drop callbacks before any button edit.
        dropError = ""
        withAnimation(motion, change)
    }
    private func beginDrag(_ item: NativeNavigationItem) -> NSItemProvider {
        let current = NativeNavigationDrag(payload: .init(token: UUID().uuidString.lowercased(), item: item),
                                           revision: model.navigationRevision, items: model.navigation.items)
        drag = current
        dropError = ""
        if current.items.count == 1, current.items.contains(item) {
            dropError = "Keep at least one page in the navigation bar."
            UIAccessibility.post(notification: .announcement, argument: dropError)
        }
        let bytes = (try? JSONEncoder().encode(current.payload)) ?? Data()
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: NativeNavigationDrag.type.identifier, visibility: .ownProcess) { completion in
            completion(bytes, nil)
            return nil
        }
        return provider
    }
    private func drop(_ placement: NativeNavigationPlacement) -> NativeNavigationDrop {
        NativeNavigationDrop(allowed: {
            guard active, let drag = drag, drag.revision == model.navigationRevision,
                  drag.items == model.navigation.items else { return false }
            if case .unused = placement { return drag.items.count > 1 && drag.items.contains(drag.payload.item) }
            return true
        }, receive: { provider in
            guard let expected = drag else { return false }
            _ = provider.loadDataRepresentation(forTypeIdentifier: NativeNavigationDrag.type.identifier) { data, _ in
                DispatchQueue.main.async {
                    guard active, drag?.payload.token == expected.payload.token else { return }
                    guard let data = data,
                          let items = expected.applyingDrop(data, currentDrag: drag, revision: model.navigationRevision,
                                                            currentItems: model.navigation.items, active: active, placement: placement) else {
                        drag = nil
                        dropError = "Navigation changed. Try dragging the item again."
                        return
                    }
                    edit { model.setNavigationItems(items) }
                }
            }
            return true
        })
    }
}

// Real Liquid Glass is restricted to the functional native controls. Content stays
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

private struct NativeMoveDestination {
    let parent: NativeDestinationWitness
    var id: String? { parent.id }
}
@MainActor
private final class NativeMoveChoice {
    private var completion: ((NativeMoveDestination?) -> Void)?
    init(_ completion: @escaping (NativeMoveDestination?) -> Void) { self.completion = completion }
    func finish(_ destination: NativeMoveDestination?) {
        guard let completion = completion else { return }
        self.completion = nil
        completion(destination)
    }
}

// This picker displays only the Rust snapshot. The selected stable folder ID is
// resolved again immediately before dispatch; no Swift filesystem traversal.
@MainActor
private final class NativeMoveDestinationController: UITableViewController {
    private let entries: [NativeFileEntry]
    private let source: NativeFileEntry
    private let folder: NativeFileEntry?
    private let choice: NativeMoveChoice
    private var folders: [NativeFileEntry] {
        let path = folder?.path ?? ""
        return entries.filter {
            $0.kind == .folder && NativeFileEntry.samePath($0.parent, path) && $0.id != source.id &&
            !(source.kind == .folder && Array($0.path.utf8).starts(with: Array(source.path.utf8) + [47]))
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    init(entries: [NativeFileEntry], source: NativeFileEntry, folder: NativeFileEntry? = nil,
         completion: @escaping (NativeMoveDestination?) -> Void) {
        self.entries = entries; self.source = source; self.folder = folder; self.choice = NativeMoveChoice(completion)
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError("Use the native move action.") }
    override func viewDidLoad() {
        super.viewDidLoad()
        title = folder?.name ?? "Vault root"
        let chooseItem = UIBarButtonItem(title: "Move here", style: .done, target: self, action: #selector(choose))
        chooseItem.isEnabled = !NativeFileEntry.samePath(source.parent, folder?.path ?? "")
        chooseItem.accessibilityIdentifier = "native.file-action.move-here"
        navigationItem.rightBarButtonItems = [chooseItem, UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancel))]
        tableView.accessibilityIdentifier = "native.file-action.destinations"
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 52
    }
    private init(entries: [NativeFileEntry], source: NativeFileEntry, folder: NativeFileEntry, choice: NativeMoveChoice) {
        self.entries = entries; self.source = source; self.folder = folder; self.choice = choice
        super.init(style: .insetGrouped)
    }
    @objc private func cancel() { finish(nil) }
    @objc private func choose() { finish(NativeMoveDestination(parent: folder.map(NativeDestinationWitness.init) ?? .root)) }
    private func finish(_ destination: NativeMoveDestination?) {
        choice.finish(destination)
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { folders.count }
    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let entry = folders[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = entry.name
        cell.textLabel?.font = .preferredFont(forTextStyle: .body)
        cell.textLabel?.adjustsFontForContentSizeCategory = true
        cell.textLabel?.numberOfLines = 0
        cell.imageView?.image = UIImage(systemName: "folder")
        cell.accessoryType = .disclosureIndicator
        cell.accessibilityIdentifier = "native.file-action.destination.\(entry.id)"
        cell.accessibilityHint = "Opens this folder to choose a destination"
        return cell
    }
    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: !UIAccessibility.isReduceMotionEnabled)
        let next = NativeMoveDestinationController(entries: entries, source: source, folder: folders[indexPath.row], choice: choice)
        navigationController?.pushViewController(next, animated: !UIAccessibility.isReduceMotionEnabled)
    }
}


// Owns exactly one idle host while the selected file's native route is visible.
// The editor gets that host only after settled navigation and stable-ID lookup.
private final class NativeFileOpenDestinationController: UIViewController {
    private let vault: LocalVault
    private let root: URL
    private let ready: (NativeFileOpenDestinationController, NativeMobileSession) -> Void
    private var closed: (() -> Void)?
    private var session: NativeMobileSession?
    private var hosting: UIHostingController<AnyView>?
    private var observers: [NSObjectProtocol] = []
    private var pending: (() -> Void)?
    private var closeCompletions: [() -> Void] = []
    private var closing = false
    private var opening = false
    private var started = false
    private var visible = false
    private var abandoned = false
    private var replacing = false
    private var attempt = 0
    private var waitingForTransition = false
    private var failure: String?
    private var retryAllowed = true
    private var admissionChecking = false
    private var authorityRetry: (() -> Void)?

    init(vault: LocalVault, root: URL, session: NativeMobileSession, title: String,
         ready: @escaping (NativeFileOpenDestinationController, NativeMobileSession) -> Void,
         closed: @escaping () -> Void) {
        self.vault = vault; self.root = root; self.session = session
        self.ready = ready; self.closed = closed
        super.init(nibName: nil, bundle: nil); self.title = title
    }
    required init?(coder: NSCoder) { fatalError("Use the native file picker.") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "native.file.opening"
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
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.schedule() })
        }
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); navigationController?.setNavigationBarHidden(false, animated: false)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated); visible = true
        navigationController?.interactivePopGestureRecognizer?.isEnabled = !admissionChecking; schedule()
    }
    override func viewWillDisappear(_ animated: Bool) { visible = false; super.viewWillDisappear(animated) }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !replacing, navigationController?.topViewController !== self { abandon() }
    }
    private var current: Bool {
        !abandoned && visible && navigationController?.topViewController === self
            && viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive
            && UIApplication.shared.applicationState == .active && presentedViewController == nil
    }
    func beginAdmissionCheck() -> Bool {
        guard !admissionChecking, !abandoned, !replacing, !closing else { return false }
        admissionChecking = true; authorityRetry = nil
        navigationItem.hidesBackButton = true
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
        failure = nil; render()
        return true
    }
    func finishAdmissionCheck() {
        admissionChecking = false; authorityRetry = nil
        navigationItem.hidesBackButton = false
        navigationController?.interactivePopGestureRecognizer?.isEnabled = true
    }
    func showAuthorityBlocked(retry: @escaping () -> Void) {
        guard !abandoned, !replacing else { return }
        // Keep Back blocked, but permit an explicit new claim/check attempt.
        authorityRetry = { [weak self] in
            guard let self = self else { return }
            self.admissionChecking = false
            retry()
        }
        failure = "Another native operation owns this session. Wait for it to finish, then check ownership. This route will not close or release that operation."
        retryAllowed = false; render()
    }
    func owns(_ expected: NativeMobileSession) -> Bool { !abandoned && !replacing && session === expected }
    func takeSession(_ expected: NativeMobileSession) -> Bool {
        guard current, !closing, !admissionChecking, navigationController?.transitionCoordinator == nil, owns(expected) else { return false }
        session = nil; replacing = true; closed = nil; pending = nil
        return true
    }
    func whenVisible(_ operation: @escaping () -> Void) { guard !abandoned else { return }; pending = operation; schedule() }
    private func schedule() { DispatchQueue.main.async { [weak self] in self?.settle() } }
    private func settle() {
        guard current, !closing, !opening else { return }
        if let transition = navigationController?.transitionCoordinator {
            guard !waitingForTransition else { return }
            waitingForTransition = true
            transition.animate(alongsideTransition: nil) { [weak self] _ in
                self?.waitingForTransition = false; self?.schedule()
            }
            return
        }
        if let operation = pending { pending = nil; operation(); return }
        guard !started, failure == nil else { return }
        started = true
        if let session = session { ready(self, session); return }
        attempt += 1; let ticket = attempt
        opening = true
        // Accepted reopen work keeps its loader/cleanup gate alive through Back.
        NativeMobileSession.open(vault: vault, root: root) { [self] result in
            opening = false
            guard !abandoned, attempt == ticket else {
                if case .success(let returned) = result { session = returned }
                disposeHost {}; return
            }
            switch result {
            case .success(let returned):
                session = returned
                whenVisible { [weak self] in
                    guard let self = self, self.owns(returned) else { return }; self.ready(self, returned)
                }
            case .failure: failure = "The vault could not be reopened. Return or try again."; render()
            }
        }
    }

    func showFailure(_ message: String, retry: Bool = true) {
        guard !abandoned, !replacing, !admissionChecking else { return }
        pending = nil
        disposeHost { [weak self] in
            guard let self = self, !self.abandoned else { return }
            self.failure = message; self.retryAllowed = retry; self.render()
        }
    }
    private func retry() {
        guard current, !closing, failure != nil, retryAllowed else { return }
        failure = nil; started = false; render(); schedule()
    }
    private func disposeHost(_ completion: @escaping () -> Void) {
        closeCompletions.append(completion)
        guard !opening, !closing else { return }
        guard let session = session else { finishClose(); return }
        self.session = nil; closing = true
        // Retain the loader until close ACK; Back cannot unlock the page early.
        session.close { [self] in closing = false; finishClose() }
    }
    private func finishClose() {
        let callbacks = closeCompletions; closeCompletions = []
        for callback in callbacks { callback() }
    }

    private func abandon() {
        guard !abandoned, !replacing, !admissionChecking else { return }
        abandoned = true; attempt += 1; pending = nil
        disposeHost { [self] in let callback = closed; closed = nil; callback?() }
    }
    private func render() {
        hosting?.rootView = AnyView(ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let message = failure {
                    Text("Could not open file").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                    Text(message).fixedSize(horizontal: false, vertical: true)
                    if authorityRetry != nil {
                        Button("Check session ownership") { [weak self] in self?.authorityRetry?() }
                            .buttonStyle(.borderedProminent).accessibilityIdentifier("native.file.open.check-ownership")
                    } else if retryAllowed {
                        Button("Retry") { [weak self] in self?.retry() }
                            .buttonStyle(.borderedProminent).accessibilityIdentifier("native.file.open.retry")
                    }
                } else { NativeLoadingSkeleton(editor: true) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }.background(Color(uiColor: .systemBackground)))
    }
    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        // Teardown cannot attest ownership after a failed claim/stale release.
        // Never explicitly close another operation's healthy session or emit a
        // reusable completion; the actual owner's retained lifetime governs it.
        if !admissionChecking {
            let callback = closed
            if let session = session { session.close { callback?() } } else { callback?() }
        }
    }
}
