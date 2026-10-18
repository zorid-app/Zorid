import Foundation

// Scene-local native navigation metadata. Paths, labels, editor state, leases
// and tab persistence never authorize or form the identity of these routes.
enum NativeRouteHistoryError: Error, Equatable {
    case invalidRoute, busy, unavailable, stale, mismatched
}

private func nativeRouteToken(_ value: String) -> Bool {
    (1...128).contains(value.utf8.count) && value.utf8.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
    }
}

struct NativePageRoute: Hashable {
    enum Mode: String, Hashable { case recents, files }
    let vaultID: UUID
    let localStoreID: String
    let mode: Mode
    let folderID: String? // nil is explicitly the native root, never a path.

    init(vaultID: UUID, localStoreID: String, mode: Mode, folderID: String?) throws {
        guard nativeRouteToken(localStoreID), folderID.map(nativeRouteToken) ?? true,
              mode == .files || folderID == nil else { throw NativeRouteHistoryError.invalidRoute }
        self.vaultID = vaultID; self.localStoreID = localStoreID
        self.mode = mode; self.folderID = folderID
    }
}

struct NativeDocumentRoute: Hashable {
    let vaultID: UUID
    let localStoreID: String
    let stableFileID: String

    init(vaultID: UUID, localStoreID: String, stableFileID: String) throws {
        guard nativeRouteToken(localStoreID), nativeRouteToken(stableFileID) else { throw NativeRouteHistoryError.invalidRoute }
        self.vaultID = vaultID; self.localStoreID = localStoreID; self.stableFileID = stableFileID
    }
}

enum NativeHistoryRoute: Hashable {
    case page(NativePageRoute)
    case document(NativeDocumentRoute)

    var vaultID: UUID {
        switch self { case .page(let route): return route.vaultID; case .document(let route): return route.vaultID }
    }
    var localStoreID: String {
        switch self { case .page(let route): return route.localStoreID; case .document(let route): return route.localStoreID }
    }
    fileprivate func sharesScope(with other: Self) -> Bool {
        vaultID == other.vaultID && localStoreID == other.localStoreID
    }
}

// One instance per scene, independent of document-tab metadata. Root alone
// verifies close ACK, foreground/install eligibility and fresh activation; a
// ticket only protects this RAM cursor from stale/foreign callbacks.
@MainActor
final class NativeRouteHistory {
    struct Ticket: Equatable {
        let id: UUID
        let sourceOwnerID: UUID
        let historyRevision: UInt64
        let targetRoute: NativeHistoryRoute
        fileprivate let historyID: UUID
        fileprivate let targetIndex: Int
        fileprivate init(sourceOwnerID: UUID, historyRevision: UInt64, targetRoute: NativeHistoryRoute,
                         historyID: UUID, targetIndex: Int) {
            id = UUID(); self.sourceOwnerID = sourceOwnerID; self.historyRevision = historyRevision
            self.targetRoute = targetRoute; self.historyID = historyID; self.targetIndex = targetIndex
        }
    }

    private let id = UUID()
    private var entries: [NativeHistoryRoute] = []
    private var cursor = -1
    private var evictedPageOrigin: NativePageRoute?
    private(set) var revision: UInt64 = 0
    private(set) var pending: Ticket?
    var count: Int { entries.count }
    var currentRoute: NativeHistoryRoute? { entries.indices.contains(cursor) ? entries[cursor] : nil }
    var canGoBack: Bool { pending == nil && cursor > 0 }
    var canGoForward: Bool { pending == nil && cursor + 1 < entries.count }

    // Preserve the last actually visited native folder when returning from a
    // document. nil means no recorded page origin, not an inferred root route.
    var pageOrigin: NativePageRoute? {
        guard let current = currentRoute else { return nil }
        for entry in entries.prefix(cursor + 1).reversed() where entry.sharesScope(with: current) {
            if case .page(let route) = entry { return route }
        }
        guard let origin = evictedPageOrigin, origin.vaultID == current.vaultID,
              origin.localStoreID == current.localStoreID else { return nil }
        return origin
    }

    // Call only after actual validated activation/restoration. An ordinary
    // duplicate callback must preserve the forward branch after a traversal.
    func recordValidated(_ route: NativeHistoryRoute) throws {
        guard pending == nil else { throw NativeRouteHistoryError.busy }
        if currentRoute == route { return }
        if let current = currentRoute, !route.sharesScope(with: current) {
            entries = []; cursor = -1; evictedPageOrigin = nil
        }
        entries = Array(entries.prefix(cursor + 1))
        entries.append(route)
        if entries.count > 100 {
            let removed = entries.count - 100
            // One bounded origin snapshot survives list eviction for Return to
            // Notes. It is not an extra traversable entry or per-tab history.
            for entry in entries.prefix(removed) {
                if case .page(let route) = entry { evictedPageOrigin = route }
            }
            entries.removeFirst(removed)
        }
        cursor = entries.count - 1
        revision &+= 1
    }

    func stage(direction: Int, sourceOwnerID: UUID) throws -> Ticket {
        guard pending == nil else { throw NativeRouteHistoryError.busy }
        guard direction == -1 || direction == 1, entries.indices.contains(cursor + direction) else {
            throw NativeRouteHistoryError.unavailable
        }
        let target = cursor + direction
        let ticket = Ticket(sourceOwnerID: sourceOwnerID, historyRevision: revision,
                            targetRoute: entries[target], historyID: id, targetIndex: target)
        pending = ticket
        return ticket
    }

    // validatedRoute must come from the current root-owned target's fresh Rust
    // activation or completed exact-folder restoration. Presentation/password/
    // error/factory installation alone is not evidence to call this method.
    func commit(_ ticket: Ticket, validatedRoute: NativeHistoryRoute, sourceOwnerID: UUID) throws {
        guard matches(ticket, sourceOwnerID: sourceOwnerID) else { throw NativeRouteHistoryError.stale }
        guard ticket.targetRoute == validatedRoute, entries.indices.contains(ticket.targetIndex),
              entries[ticket.targetIndex] == ticket.targetRoute else { throw NativeRouteHistoryError.mismatched }
        cursor = ticket.targetIndex
        pending = nil
        revision &+= 1
    }

    @discardableResult
    func cancel(_ ticket: Ticket, sourceOwnerID: UUID) -> Bool {
        guard matches(ticket, sourceOwnerID: sourceOwnerID) else { return false }
        pending = nil
        revision &+= 1
        return true
    }

    func reset() {
        entries = []; cursor = -1; pending = nil; evictedPageOrigin = nil
        revision &+= 1
    }

    private func matches(_ ticket: Ticket, sourceOwnerID: UUID) -> Bool {
        ticket.historyID == id && ticket.sourceOwnerID == sourceOwnerID && ticket.historyRevision == revision && pending == ticket
    }
}
