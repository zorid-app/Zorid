// Compiled with the actual Foundation-only NativeRouteHistory.swift, no stubs.
@main
struct NativeTabRouteHistoriesHarness {
    @MainActor static func main() throws {
        var checks = 0
        func check(_ value: Bool, _ label: String) {
            precondition(value, label); checks += 1
        }
        func rejects(_ expected: NativeRouteHistoryError, _ label: String, _ operation: () throws -> Void) {
            do { try operation(); preconditionFailure("Expected error: " + label) }
            catch { check(error as? NativeRouteHistoryError == expected, label) }
        }
        let vault = UUID(), foreignVault = UUID(), owner = UUID(), foreignOwner = UUID()
        let tabA = UUID(), tabB = UUID()
        let registry = NativeTabRouteHistories(vaultID: vault)
        let otherContext = NativeTabRouteHistories(vaultID: foreignVault)
        let a = try registry.history(for: tabA), b = try registry.history(for: tabB)
        func page(_ folder: String?, vaultID: UUID? = nil, store: String = "store") throws -> NativeHistoryRoute {
            .page(try NativePageRoute(vaultID: vaultID ?? vault, localStoreID: store, mode: .files, folderID: folder))
        }
        func document(_ id: String, vaultID: UUID? = nil, store: String = "store") throws -> NativeHistoryRoute {
            .document(try NativeDocumentRoute(vaultID: vaultID ?? vault, localStoreID: store, stableFileID: id))
        }
        let aFolder = try page("folder-A"), a1 = try document("note-A1"), a2 = try document("note-A2")
        let bFolder = try page("folder-B"), b1 = try document("note-B1"), b2 = try document("note-B2")
        check(registry.vaultID == vault && a.vaultID == vault && b.vaultID == vault, "immutable registry/history scope")
        check(try registry.history(for: tabA) === a && registry.count == 2 && a !== b, "stable per-tab instance")
        try a.recordValidated(aFolder); try a.recordValidated(a1); try a.recordValidated(a2)
        try b.recordValidated(bFolder); try b.recordValidated(b1); try b.recordValidated(b2)
        let backA = try a.stage(direction: -1, sourceOwnerID: owner)
        check(a.currentRoute == a2 && !a.canGoBack && !a.canGoForward, "stage preserves cursor and disables traversal")
        rejects(.stale, "wrong history ticket") { try b.commit(backA, validatedRoute: a1, sourceOwnerID: owner) }
        check(!b.cancel(backA, sourceOwnerID: owner) && b.currentRoute == b2, "wrong history cancellation no mutation")
        rejects(.stale, "wrong owner commit") { try a.commit(backA, validatedRoute: a1, sourceOwnerID: foreignOwner) }
        check(!a.cancel(backA, sourceOwnerID: foreignOwner) && a.pending == backA, "wrong owner cancellation rejected")
        rejects(.mismatched, "wrong fresh target") { try a.commit(backA, validatedRoute: b1, sourceOwnerID: owner) }
        rejects(.busy, "record while traversal pending") { try a.recordValidated(a1) }
        try a.commit(backA, validatedRoute: a1, sourceOwnerID: owner)
        check(a.currentRoute == a1 && a.canGoForward && b.currentRoute == b2 && !b.canGoForward, "A cursor independent of B")
        rejects(.stale, "committed ticket cannot repeat") { try a.commit(backA, validatedRoute: a1, sourceOwnerID: owner) }
        let aRevision = a.revision
        try a.recordValidated(a1)
        check(a.canGoForward && a.revision == aRevision && a.count == 3, "duplicate validation retains forward branch")
        let backB = try b.stage(direction: -1, sourceOwnerID: owner)
        try b.commit(backB, validatedRoute: b1, sourceOwnerID: owner)
        let newA = try document("new-A")
        try a.recordValidated(newA)
        check(!a.canGoForward && b.canGoForward && b.currentRoute == b1, "new A branch never truncates B forward branch")
        let forwardB = try b.stage(direction: 1, sourceOwnerID: owner)
        check(forwardB.targetRoute == b2, "B forward target retained")
        try b.commit(forwardB, validatedRoute: b2, sourceOwnerID: owner)
        check(a.pageOrigin == { if case .page(let route) = aFolder { return route }; return nil }(), "A folder origin retained")
        check(b.pageOrigin == { if case .page(let route) = bFolder { return route }; return nil }(), "B folder origin retained")

        let foreign = try document("foreign", vaultID: foreignVault)
        let before = (a.count, a.currentRoute, a.revision, a.pageOrigin)
        rejects(.invalidRoute, "scoped foreign vault rejected") { try a.recordValidated(foreign) }
        check(a.count == before.0 && a.currentRoute == before.1 && a.revision == before.2 && a.pageOrigin == before.3, "foreign route changes no history metadata")
        let other = try otherContext.history(for: tabA)
        check(other !== a && other.vaultID == foreignVault, "same tab UUID different vault context isolated")
        rejects(.invalidRoute, "other scoped registry rejects first vault") { try other.recordValidated(a1) }
        try other.recordValidated(foreign)

        let pendingA = try a.stage(direction: -1, sourceOwnerID: owner)
        let retainedB = (b.revision, b.count, b.currentRoute, b.pageOrigin)
        try registry.retain(tabIDs: [tabB])
        check(registry.count == 1 && a.pending == nil && a.count == 0, "prune invalidates detached pending source")
        rejects(.stale, "pruned detached history cannot commit old ticket") { try a.commit(pendingA, validatedRoute: pendingA.targetRoute, sourceOwnerID: owner) }
        check(!a.cancel(pendingA, sourceOwnerID: owner), "pruned cancellation cannot redeem old ticket")
        let recreated = try registry.history(for: tabA)
        check(recreated !== a && recreated.count == 0, "recreated same UUID fresh history identity")
        rejects(.stale, "recreated history rejects old ticket") { try recreated.commit(pendingA, validatedRoute: pendingA.targetRoute, sourceOwnerID: owner) }
        check(!recreated.cancel(pendingA, sourceOwnerID: owner), "recreated history rejects old cancellation")
        check(try registry.history(for: tabB) === b && b.revision == retainedB.0 && b.count == retainedB.1 && b.currentRoute == retainedB.2 && b.pageOrigin == retainedB.3, "retained history not reset by prune")
        let pendingB = try b.stage(direction: -1, sourceOwnerID: owner)
        let retainedRevision = b.revision
        try registry.retain(tabIDs: [tabA, tabB])
        check(b.pending == pendingB && b.revision == retainedRevision, "retain preserves exact in-flight retained ticket")
        check(b.cancel(pendingB, sourceOwnerID: owner), "retained pending ticket still cancellable")
        check(!b.cancel(pendingB, sourceOwnerID: owner), "cancelled ticket one use")

        let bounded = NativeTabRouteHistories(vaultID: vault)
        let ids = (0..<64).map { _ in UUID() }
        var existing: [NativeRouteHistory] = []
        for id in ids { existing.append(try bounded.history(for: id)) }
        check(bounded.count == 64 && NativeTabRouteHistories.maximumTabs == 64, "capacity exactly 64")
        try existing[0].recordValidated(aFolder); try existing[0].recordValidated(a1)
        let pendingBounded = try existing[0].stage(direction: -1, sourceOwnerID: owner)
        rejects(.tabLimit, "65th getter throws without eviction") { _ = try bounded.history(for: UUID()) }
        check(bounded.count == 64 && existing[0].pending == pendingBounded, "capacity failure atomic")
        check(try bounded.history(for: ids[0]) === existing[0], "existing instance available at capacity")
        rejects(.tabLimit, "oversized retain rejected before pruning") { try bounded.retain(tabIDs: Set((0..<65).map { _ in UUID() })) }
        check(bounded.count == 64 && existing[0].pending == pendingBounded, "invalid retention preserves pending cursor")
        try bounded.retain(tabIDs: Set(ids.dropLast()))
        let admitted = try bounded.history(for: UUID())
        check(bounded.count == 64 && admitted.count == 0, "closed slot available for actual new tab")
        try bounded.retain(tabIDs: [])
        check(bounded.count == 0 && existing[0].pending == nil, "all removed histories reset")
        rejects(.stale, "pruned at capacity rejects retained old callback") { try existing[0].commit(pendingBounded, validatedRoute: aFolder, sourceOwnerID: owner) }
        try bounded.retain(tabIDs: Set(ids))
        check(bounded.count == 0, "retain never manufactures histories for IDs")

        // Existing unscoped history still resets on vault/store changes. Scoped
        // history retains that same-store rule without ever crossing its vault.
        let legacy = NativeRouteHistory()
        check(legacy.vaultID == nil, "legacy initializer stays unscoped")
        try legacy.recordValidated(aFolder); try legacy.recordValidated(a1)
        try legacy.recordValidated(foreign)
        check(legacy.count == 1 && legacy.currentRoute == foreign && legacy.pageOrigin == nil, "legacy cross-vault reset preserved")
        let storeChanged = try document("new-store-note", store: "other-store")
        try b.recordValidated(storeChanged)
        check(b.count == 1 && b.currentRoute == storeChanged && b.pageOrigin == nil, "same-vault changed-store reset preserved")
        rejects(.unavailable, "invalid direction") { _ = try b.stage(direction: 0, sourceOwnerID: owner) }
        rejects(.unavailable, "no backward entry") { _ = try b.stage(direction: -1, sourceOwnerID: owner) }
        let boundedEntries = NativeRouteHistory(vaultID: vault)
        try boundedEntries.recordValidated(aFolder)
        for index in 0..<110 { try boundedEntries.recordValidated(document("note-\(index)")) }
        check(boundedEntries.count == 100, "route entry limit remains100")
        check(boundedEntries.pageOrigin == { if case .page(let route) = aFolder { return route }; return nil }(), "evicted validated page origin retained")
        let staged = try boundedEntries.stage(direction: -1, sourceOwnerID: owner)
        let oldCurrent = boundedEntries.currentRoute
        check(boundedEntries.cancel(staged, sourceOwnerID: owner) && boundedEntries.currentRoute == oldCurrent, "cancel leaves committed cursor unchanged")
        boundedEntries.reset()
        rejects(.stale, "reset ticket stale") { try boundedEntries.commit(staged, validatedRoute: staged.targetRoute, sourceOwnerID: owner) }
        check(boundedEntries.count == 0 && boundedEntries.pageOrigin == nil, "explicit history reset behavior preserved")
        rejects(.invalidRoute, "malformed route rejected") { _ = try NativeDocumentRoute(vaultID: vault, localStoreID: "bad/store", stableFileID: "file") }
        rejects(.invalidRoute, "recents cannot carry folder") { _ = try NativePageRoute(vaultID: vault, localStoreID: "store", mode: .recents, folderID: "folder") }
        print("PASS \(checks) actual-source per-tab route history assertions (Foundation host only)")
    }
}
