import Foundation
import CoreFoundation

// Native-only empty-text intent. Rust owns naming collisions, commit, text mode,
// projection and receipt authority. No host/editor is opened by this helper.
@MainActor
final class NativeNewNoteRequest {
    struct Intent { let creationID: UUID; let tabID: UUID }
    struct Selection: Codable, Equatable {
        let creationID: String; let tabID: String; let vaultID: String
        let localStoreID: String; let clientID: String
        let operationID: String; let entryID: String; let rootFileName: String
        let familyJSON: String
    }
    struct HandoffToken {
        fileprivate let selection: Selection
        fileprivate let sequence: String
        fileprivate let targetRevision: String
        let creationID: UUID
        let tabID: UUID
    }
    struct Handoff {
        let document: NativeTabDocument
        let entry: NativeFileEntry
        let token: HandoffToken
    }
    enum Action { case inspectPending, create(Intent), resumePending }
    enum Outcome { case clear, pending(Selection), rejected(Selection), ready(Handoff) }
    enum Failure: LocalizedError {
        case busy, consumed, invalidJournal, invalidReply, pending, unavailable
        var errorDescription: String? {
            switch self {
            case .pending: return "The original new-note request is retained. Review or retry that request before creating another note."
            case .busy: return "Wait for the current new-note operation."
            case .consumed: return "This borrowed session has already been returned."
            default: return "The new-note request could not be completed safely. Its original identity is retained."
            }
        }
    }
    private enum Phase: String, Codable { case pending, acknowledged, rejected }
    private struct Record: Codable, Equatable { let version: Int; let selection: Selection; let phase: Phase }
    private struct Head { let revision: String; let body: Data; let record: Record? }
    private struct CAS {
        let key: String; let expected: String?; let next: String; let body: Data
    }
    private struct Reply { let value: [String: Any]; let body: Data }
    private struct Rejected: Error { let code: String; let uncertain: Bool }
    private struct Receipt { let sequence: String; let revision: String }
    private static let currentKey = "native-new-note/v1/current"
    private static let limit = 8192
    private let binding: NativeExclusiveSessionBinding
    private var admission: NativeSessionAdmission?
    private var busy = false, loanFinished = false
    private var requestID: UInt64 = 0
    private var uncertainCAS: CAS?
    // Once this loan starts terminal retirement it must finish THAT rejection,
    // including release ACK, before a fresh loan can plan another CID/name.
    private var retiringRejection: Selection?
    // Enforce the documented fresh ACK-only helper role even when its release
    // fails: callers may retry ACK or fence, never use that loan to plan a create.
    private var acknowledgingHandoff = false
    private var settlingLoan = false
    // Root MUST retain this instance while true, and must not lend/open another
    // host until an exact release/fence ACK. A timeout is not that ACK.
    var retainsReservation: Bool { !loanFinished && (busy || admission != nil || uncertainCAS != nil) }
    init(binding: NativeExclusiveSessionBinding) { self.binding = binding }
    private var scope: [String: String] {
        ["vaultId": binding.localStoreId, "clientId": binding.session.vault.clientId]
    }
    private func requestKey(_ selection: Selection) -> String { "native-new-note/v1/request/" + selection.creationID }

    func execute(_ action: Action, completion: @escaping (Result<Outcome, Error>) -> Void) {
        guard !busy, !loanFinished else { completion(.failure(loanFinished ? Failure.consumed : Failure.busy)); return }
        guard !acknowledgingHandoff else { completion(.failure(Failure.pending)); return }
        busy = true
        Task {
            let result: Result<Outcome, Error>
            do {
                try await acquire()
                // Consult even a delayed requested CID before retrying any
                // uncertain current CAS from an earlier invocation.
                if case .create(let intent) = action {
                    _ = try await load("native-new-note/v1/request/" + intent.creationID.uuidString.lowercased())
                }
                try await reconcileUncertainCAS()
                result = .success(try await run(action))
            } catch { result = .failure(error) } // Held admission and exact journal remain on uncertainty.
            busy = false; completion(result)
        }
    }

    private func run(_ requestedAction: Action) async throws -> Outcome {
        if let selection = retiringRejection { return try await rejected(selection) }
        // After release starts or a terminal repair begins, this loan may only
        // recover/settle. A new CID requires a fresh post-ACK binding.
        let action: Action = settlingLoan ? .inspectPending : requestedAction
        // CID tombstones take precedence even over a newer pending current. A
        // delayed UI callback must never retry an old terminal create or replace
        // the current request. No create dispatch occurs before this lookup.
        if case .create(let intent) = action,
           let prior = try await load("native-new-note/v1/request/" + intent.creationID.uuidString.lowercased())?.record {
            if prior.phase == .rejected { return try await rejected(prior.selection) }
            let current = try await load(Self.currentKey)
            if let index = current, let record = index.record, record.selection == prior.selection {
                let reconciled = try await reconcile(record, index: index)
                return try await resolve(reconciled, retry: record.phase == .pending)
            }
            guard prior.phase == .acknowledged else { throw Failure.pending }
            return try await resolve(prior, retry: false)
        }
        let current = try await load(Self.currentKey)
        if let index = current, let record = index.record {
            let reconciled = try await reconcile(record, index: index)
            if record.phase == .pending {
                // Retirement/recovery and replacement are separate user actions.
                if reconciled.phase == .rejected { return try await rejected(reconciled.selection) }
                if reconciled.phase == .acknowledged { try await release(); return .clear }
                let retry: Bool
                switch action {
                case .resumePending: retry = true
                case .create(let intent): retry = reconciled.selection.creationID == intent.creationID.uuidString.lowercased()
                case .inspectPending: retry = false
                }
                return try await resolve(reconciled, retry: retry)
            }
            switch action {
            case .inspectPending, .resumePending:
                if reconciled.phase == .rejected { return try await rejected(reconciled.selection) }
                try await release(); return .clear
            case .create: break
            }
        }
        guard case .create(let intent) = action else { try await release(); return .clear }
        // Root may lend this fresh binding only after the preceding loan's exact
        // release/fence ACK. A failed release never exposes a rejected outcome.
        let selection = try await prepare(intent)
        let record = Record(version: 1, selection: selection, phase: .pending)
        _ = try await persist(record, key: Self.currentKey, after: current)
        _ = try await persist(record, key: requestKey(selection), after: nil)
        return try await resolve(record, retry: true)
    }

    // Call ONLY on a NEW helper with a FRESH owned same-client binding, after
    // durable tab metadata + recoverable existing-ID handoff. Never borrow a live
    // editor just to ACK, and never reuse the helper that returned .ready.
    func acknowledgeHandoff(_ token: HandoffToken, completion: @escaping (Result<Void, Error>) -> Void) {
        guard !busy, !loanFinished else { completion(.failure(loanFinished ? Failure.consumed : Failure.busy)); return }
        guard retiringRejection == nil else { completion(.failure(Failure.pending)); return }
        acknowledgingHandoff = true
        busy = true
        Task {
            let result: Result<Void, Error>
            do {
                try await acquire(); try await reconcileUncertainCAS()
                try validate(token.selection)
                guard let index = try await load(Self.currentKey), let indexRecord = index.record,
                      let ledger = try await load(requestKey(token.selection)), let ledgerRecord = ledger.record,
                      ledgerRecord.selection == token.selection, ledgerRecord.phase != .rejected,
                      !(indexRecord.selection == token.selection && indexRecord.phase == .rejected) else { throw Failure.invalidJournal }
                if indexRecord.selection != token.selection {
                    guard indexRecord.phase == .acknowledged else { throw Failure.pending }
                    guard ledgerRecord.phase == .acknowledged else { throw Failure.invalidJournal }
                }
                let receipt = try await originalStatus(token.selection)
                guard let receipt = receipt, receipt.sequence == token.sequence,
                      receipt.revision == token.targetRevision else { throw Failure.pending }
                _ = try await freshEntry(token.selection)
                let acknowledged = Record(version: 1, selection: token.selection, phase: .acknowledged)
                if ledgerRecord.phase != .acknowledged {
                    _ = try await persist(acknowledged, key: requestKey(token.selection), after: ledger)
                }
                if indexRecord.selection == token.selection, indexRecord.phase != .acknowledged {
                    _ = try await persist(acknowledged, key: Self.currentKey, after: index)
                }
                try await release(); result = .success(())
            } catch { result = .failure(error) }
            busy = false; completion(result)
        }
    }

    // Explicit abandonment of THIS held host reservation, not of the durable
    // create intent. Cancel cannot undo a committed file or erase its journal.
    func closeRetainedReservation(completion: @escaping (Result<Void, Error>) -> Void) {
        guard !busy else { completion(.failure(Failure.busy)); return }
        guard !loanFinished, let held = admission else { completion(.failure(Failure.consumed)); return }
        busy = true
        binding.session.fenceNativeAdmission(held) { [self] result in
            busy = false
            switch result {
            case .success:
                admission = nil
                finish(.failure(NativeSessionOperationFailure(code: "native_new_note_retained", commitUncertain: true, sessionFenced: true)))
                completion(.success(()))
            case .failure(let error):
                if let typed = error as? NativeSessionOperationFailure, typed.sessionFenced {
                    admission = nil; finish(.failure(typed)); completion(.success(()))
                } else { completion(.failure(error)) } // No authority over a newer/foreign loan.
            }
        }
    }
    private func acquire() async throws {
        if admission != nil { return }
        do {
            admission = try await withCheckedThrowingContinuation { continuation in
                binding.session.acquireNativeAdmission(expectedStoreId: binding.localStoreId) { continuation.resume(with: $0) }
            }
        } catch {
            finish(.failure(error)) // Preserve typed no-authority vs fenced classification.
            throw error
        }
    }
    private func release() async throws {
        guard let held = admission else { throw Failure.unavailable }
        settlingLoan = true
        let result: Result<Void, Error> = await withCheckedContinuation { continuation in
            binding.session.releaseNativeAdmission(held) { continuation.resume(returning: $0) }
        }
        switch result {
        case .success:
            admission = nil; finish(result)
        case .failure(let error):
            // Unknown release retains the exact loan and gate for retry/fencing.
            // Only a typed exact fence ACK permits retirement on failure.
            if let typed = error as? NativeSessionOperationFailure, typed.sessionFenced {
                admission = nil; finish(result)
            }
            throw error
        }
    }
    private func finish(_ result: Result<Void, Error>) {
        guard !loanFinished else { return }; loanFinished = true; binding.finish(result)
    }

    private func prepare(_ intent: Intent) async throws -> Selection {
        let listing = try await listing()
        guard listing.localStoreId == binding.localStoreId else { throw Failure.invalidReply }
        let paths = Set(listing.entries.map { Data($0.path.utf8) })
        var name = "Untitled.md"
        for suffix in 0...10_000 {
            name = suffix == 0 ? "Untitled.md" : "Untitled \(suffix).md"
            if !paths.contains(Data(name.utf8)) { break }
            if suffix == 10_000 { throw Failure.unavailable }
        }
        let operation = UUID().uuidString.lowercased(), entry = UUID().uuidString.lowercased()
        let family = try Self.family(operation: operation, entry: entry, path: name)
        let selection = Selection(creationID: intent.creationID.uuidString.lowercased(), tabID: intent.tabID.uuidString.lowercased(),
            vaultID: binding.session.vault.id.uuidString.lowercased(), localStoreID: binding.localStoreId,
            clientID: binding.session.vault.clientId, operationID: operation, entryID: entry, rootFileName: name, familyJSON: family)
        try validate(selection); return selection
    }
    private func reconcile(_ indexRecord: Record, index: Head) async throws -> Record {
        let key = requestKey(indexRecord.selection)
        guard let ledger = try await load(key) else {
            // Crash after current CAS but before per-request CAS. No create was
            // allowed yet; restore the EXACT original request, never fresh IDs.
            guard indexRecord.phase == .pending else { throw Failure.invalidJournal }
            _ = try await persist(indexRecord, key: key, after: nil); return indexRecord
        }
        guard let prior = ledger.record, prior.selection == indexRecord.selection else { throw Failure.invalidJournal }
        if prior.phase == indexRecord.phase { return prior }
        guard indexRecord.phase == .pending else { throw Failure.invalidJournal }
        if prior.phase == .acknowledged {
            // ACK ledger was durable before its index update. This represents a
            // prior explicit durable UI binding, not a guessed current path.
            guard try await originalStatus(prior.selection) != nil else { throw Failure.pending }
        } else if prior.phase == .rejected {
            retiringRejection = prior.selection
        } else { throw Failure.invalidJournal }
        settlingLoan = true
        // Both terminal transitions write the CID ledger first. Repair ONLY the
        // same selection; never infer authority to overwrite a newer current.
        _ = try await persist(prior, key: Self.currentKey, after: index)
        return prior
    }
    private func rejected(_ selection: Selection) async throws -> Outcome {
        guard let ledger = try await load(requestKey(selection))?.record,
              ledger.selection == selection, ledger.phase == .rejected else { throw Failure.invalidJournal }
        retiringRejection = selection
        if let index = try await load(Self.currentKey), let record = index.record, record.selection == selection {
            if record.phase == .pending {
                _ = try await persist(ledger, key: Self.currentKey, after: index)
            } else if record.phase != .rejected { throw Failure.invalidJournal }
            guard let verified = try await load(Self.currentKey)?.record,
                  verified == ledger else { throw Failure.invalidJournal }
        }
        guard let verified = try await load(requestKey(selection))?.record,
              verified == ledger else { throw Failure.invalidJournal }
        try await release()
        return .rejected(selection)
    }
    private func reject(_ selection: Selection) async throws -> Outcome {
        guard let ledger = try await load(requestKey(selection)), let record = ledger.record,
              record.selection == selection, record.phase == .pending,
              let index = try await load(Self.currentKey), let current = index.record,
              current == record else { throw Failure.invalidJournal }
        let terminal = Record(version: 1, selection: selection, phase: .rejected)
        retiringRejection = selection
        _ = try await persist(terminal, key: requestKey(selection), after: ledger)
        return try await rejected(selection) // Matching current CAS, verify, then release.
    }
    private func resolve(_ record: Record, retry: Bool) async throws -> Outcome {
        let selection = record.selection
        try validate(selection)
        // Always consult the CID ledger immediately before status/create. Its
        // terminal record wins over a stale in-memory/current pending snapshot.
        guard let ledger = try await load(requestKey(selection))?.record,
              ledger.selection == selection else { throw Failure.invalidJournal }
        if ledger.phase == .rejected { return try await rejected(selection) }
        guard ledger.phase == record.phase else { throw Failure.invalidJournal }
        var receipt = try await originalStatus(selection)
        if receipt == nil, retry, ledger.phase == .pending {
            guard let current = try await load(Self.currentKey)?.record,
                  current == ledger else { throw Failure.pending }
            var exactRejection = false
            do {
                _ = try await wire(["method": "create_text", "client_id": selection.clientID,
                    "operation_id": selection.operationID, "id": selection.entryID, "path": selection.rootFileName])
            } catch let error as Rejected {
                exactRejection = error.code == "invalid_request" && !error.uncertain
            }
            // Awaited completed create reply, then SAME loan / exact family
            // status. No other task dispatches on this exclusive serial loan.
            receipt = try await originalStatus(selection)
            if receipt == nil, exactRejection { return try await reject(selection) }
        }
        guard let receipt = receipt else { return .pending(selection) }
        let entry = try await freshEntry(selection)
        let document = try NativeTabDocument(vaultID: binding.session.vault.id, localStoreID: selection.localStoreID,
            stableFileID: entry.id, displayTitle: entry.name)
        guard let creationID = UUID(uuidString: selection.creationID), let tabID = UUID(uuidString: selection.tabID) else { throw Failure.invalidJournal }
        let token = HandoffToken(selection: selection, sequence: receipt.sequence, targetRevision: receipt.revision,
                                 creationID: creationID, tabID: tabID)
        try await release() // No .entry/editor admission is permitted before this ACK.
        return .ready(Handoff(document: document, entry: entry, token: token))
    }
    private func listing() async throws -> NativeVaultListing {
        try await withCheckedThrowingContinuation { continuation in binding.session.pageListing { continuation.resume(with: $0) } }
    }
    private func freshEntry(_ selection: Selection) async throws -> NativeFileEntry {
        let listing = try await listing()
        let entries = listing.entries.filter { $0.id == selection.entryID }
        guard listing.localStoreId == selection.localStoreID, entries.count == 1,
              let entry = entries.first, entry.kind == .file, !entry.deleted,
              NativeFileEntry.isVisiblePath(entry.path) else { throw Failure.pending }
        return entry // Fresh path is a locator; original receipt still binds the original root path.
    }
    private func originalStatus(_ selection: Selection) async throws -> Receipt? {
        let family = try JSONSerialization.jsonObject(with: Data(selection.familyJSON.utf8))
        let reply = try await wire(["method": "file_command_status", "client_id": selection.clientID, "family": family])
        let value = reply.value
        guard reply.body.isEmpty, value["local_store_id"] as? String == selection.localStoreID,
              value["operation_id"] as? String == selection.operationID else { throw Failure.invalidReply }
        if value["status"] as? String == "not_committed" {
            guard Set(value.keys) == Set(["status", "local_store_id", "operation_id"]) else { throw Failure.invalidReply }
            return nil
        }
        guard Set(value.keys) == Set(["status", "local_store_id", "operation_id", "kind", "sequence", "source", "target", "change_count", "projection"]),
              value["status"] as? String == "committed", value["kind"] as? String == "create", value["source"] is NSNull,
              let sequence = value["sequence"] as? String, Self.decimal(sequence, positive: true),
              value["change_count"] as? String == "1", ["settled", "pending"].contains(value["projection"] as? String ?? ""),
              let target = value["target"] as? [String: Any], Set(target.keys) == Set(["id", "revision", "path", "kind", "deleted"]),
              target["id"] as? String == selection.entryID, target["kind"] as? String == "file", Self.boolean(target["deleted"]) == false,
              let path = target["path"] as? String, path.utf8.elementsEqual(selection.rootFileName.utf8),
              let revision = target["revision"] as? String, NativeFileEntry.isValidEntryId(revision) else { throw Failure.invalidReply }
        // Rust checks retained exact composite including Text/Some(empty)/null
        // parent; this compact receipt is never reconstructed from a listing.
        return Receipt(sequence: sequence, revision: revision)
    }
    private static func family(operation: String, entry: String, path: String) throws -> String {
        let value: [String: Any] = ["version": 1, "request": ["operation_id": operation,
            "mutation": ["type": "create", "id": entry, "path": path, "kind": "file"]],
            "create_mode": "text", "destination_parent": NSNull()]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func validate(_ selection: Selection) throws {
        guard Self.uuid(selection.creationID), Self.uuid(selection.tabID), Self.uuid(selection.vaultID),
              Self.uuid(selection.clientID), Self.uuid(selection.operationID), NativeFileEntry.isValidEntryId(selection.entryID),
              NativeFileEntry.isValidEntryId(selection.localStoreID), selection.localStoreID == binding.localStoreId,
              selection.clientID == binding.session.vault.clientId, selection.vaultID == binding.session.vault.id.uuidString.lowercased(),
              selection.rootFileName.utf8.count <= 255,
              selection.rootFileName.range(of: "^Untitled(?: [1-9][0-9]{0,4})?\\.md$", options: .regularExpression) != nil,
              !selection.rootFileName.contains("/"), !selection.rootFileName.contains("\\"), NativeFileEntry.isVisiblePath(selection.rootFileName),
              selection.familyJSON.utf8.count <= 2048,
              selection.familyJSON == (try Self.family(operation: selection.operationID, entry: selection.entryID, path: selection.rootFileName)) else { throw Failure.invalidJournal }
    }

    private func load(_ key: String) async throws -> Head? {
        let reply = try await wire(["method": "checkpoint_load", "scope": scope, "key": key])
        return try decodeHead(reply, key: key)
    }
    private func decodeHead(_ reply: Reply, key: String) throws -> Head? {
        guard Set(reply.value.keys) == Set(["checkpoint"]) else { throw Failure.invalidReply }
        if reply.value["checkpoint"] is NSNull {
            guard reply.body.isEmpty else { throw Failure.invalidReply }; return nil
        }
        guard let head = reply.value["checkpoint"] as? [String: Any],
              Set(head.keys) == Set(["version", "vaultId", "clientId", "key", "revision", "sequence", "deleted", "byteLength"]),
              Self.one(head["version"]), head["vaultId"] as? String == binding.localStoreId,
              head["clientId"] as? String == binding.session.vault.clientId, head["key"] as? String == key,
              let revision = head["revision"] as? String, Self.uuid(revision),
              let sequence = head["sequence"] as? String, Self.decimal(sequence, positive: true),
              let deleted = Self.boolean(head["deleted"]), let size = Self.number(head["byteLength"]), size == reply.body.count else { throw Failure.invalidReply }
        if deleted { guard reply.body.isEmpty else { throw Failure.invalidReply }; throw Failure.invalidJournal }
        guard String(data: reply.body, encoding: .utf8) != nil,
              let object = (try? JSONSerialization.jsonObject(with: reply.body)) as? [String: Any],
              Set(object.keys) == Set(["version", "selection", "phase"]), Self.one(object["version"]),
              let selection = object["selection"] as? [String: Any],
              Set(selection.keys) == Set(["creationID", "tabID", "vaultID", "localStoreID", "clientID", "operationID", "entryID", "rootFileName", "familyJSON"]) else { throw Failure.invalidJournal }
        let record = try JSONDecoder().decode(Record.self, from: reply.body)
        try validate(record.selection)
        if key != Self.currentKey, key != requestKey(record.selection) { throw Failure.invalidJournal }
        return Head(revision: revision, body: reply.body, record: record)
    }
    private func persist(_ record: Record, key: String, after: Head?) async throws -> Head {
        guard uncertainCAS == nil else { throw Failure.pending }
        try validate(record.selection)
        let body = try JSONEncoder().encode(record)
        guard body.count <= Self.limit else { throw Failure.invalidJournal }
        let pending = CAS(key: key, expected: after?.revision, next: UUID().uuidString.lowercased(), body: body)
        uncertainCAS = pending
        let head = try await performCAS(pending)
        uncertainCAS = nil; return head
    }
    private func performCAS(_ pending: CAS) async throws -> Head {
        let record = try JSONDecoder().decode(Record.self, from: pending.body)
        try validate(record.selection)
        // A retained retry cannot downgrade a CID tombstone, even if invoked by
        // a stale UI action. Current terminal writes require ledger-first proof.
        let ledger = try await load(requestKey(record.selection))?.record
        if let ledger = ledger {
            guard ledger.selection == record.selection else { throw Failure.invalidJournal }
            if ledger.phase != .pending, ledger != record { throw Failure.invalidJournal }
        }
        if pending.key == Self.currentKey, record.phase != .pending {
            guard ledger == record else { throw Failure.invalidJournal }
        }
        let command: [String: Any] = ["method": "checkpoint_cas", "scope": scope, "key": pending.key,
            "expected_revision": pending.expected.map { $0 as Any } ?? NSNull(), "next_revision": pending.next, "has_state": true]
        let reply = try await wire(command, body: pending.body)
        guard let head = try decodeHead(reply, key: pending.key), head.revision == pending.next,
              head.body == pending.body else { throw Failure.invalidReply }
        return head
    }
    private func reconcileUncertainCAS() async throws {
        guard let pending = uncertainCAS else { return }
        let actual = try await load(pending.key)
        if actual?.revision == pending.next, actual?.body == pending.body { uncertainCAS = nil; return }
        guard actual?.revision == pending.expected else { throw Failure.pending }
        _ = try await performCAS(pending) // SAME next UUID/body/expected, never rotate on uncertainty.
        uncertainCAS = nil
    }
    private func wire(_ command: [String: Any], body: Data = Data()) async throws -> Reply {
        guard let held = admission, body.count <= Self.limit else { throw Failure.unavailable }
        guard requestID < UInt64.max else { throw Failure.unavailable }
        requestID += 1; let id = String(requestID)
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "request_id": id, "command": command, "lease": held.wireReference])
        guard bytes.count <= 8192, let header = String(data: bytes, encoding: .utf8) else { throw Failure.invalidReply }
        let response: (String, String) = try await withCheckedThrowingContinuation { continuation in
            binding.session.request(header: header, body: body.base64EncodedString()) { continuation.resume(with: $0) }
        }
        guard response.0.utf8.count <= 1_048_576, response.1.utf8.count <= ((Self.limit + 2) / 3) * 4,
              let payload = Data(base64Encoded: response.1), payload.count <= Self.limit,
              payload.base64EncodedString() == response.1,
              let value = (try? JSONSerialization.jsonObject(with: Data(response.0.utf8))) as? [String: Any],
              Self.one(value["version"]), value["request_id"] as? String == id, let ok = Self.boolean(value["ok"]) else { throw Failure.invalidReply }
        if !ok {
            guard Set(value.keys) == Set(["version", "request_id", "ok", "error"]), payload.isEmpty,
                  let error = value["error"] as? [String: Any], Set(error.keys) == Set(["code", "commit_uncertain", "message"]),
                  let code = error["code"] as? String, code.range(of: "^[a-z_]{1,64}$", options: .regularExpression) != nil,
                  let uncertain = Self.boolean(error["commit_uncertain"]), let message = error["message"] as? String,
                  message.utf8.count <= 4096 else { throw Failure.invalidReply }
            throw Rejected(code: code, uncertain: uncertain)
        }
        guard Set(value.keys) == Set(["version", "request_id", "ok", "result"]), let result = value["result"] as? [String: Any] else { throw Failure.invalidReply }
        return Reply(value: result, body: payload)
    }
    private static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func decimal(_ value: String, positive: Bool) -> Bool {
        UInt64(value).map { String($0) == value && $0 <= UInt64(Int64.max) && (!positive || $0 > 0) } == true
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }; return number.boolValue
    }
    private static func one(_ value: Any?) -> Bool { number(value) == 1 }
    private static func number(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded(.down) == number.doubleValue else { return nil }; return number.intValue
    }
}
