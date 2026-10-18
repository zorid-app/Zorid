// Concatenated with the ACTUAL model/store sources by the companion runner.
// Only the Foundation application-support lookup is redirected in the temporary
// store copy. Production validation, FD paths, writes, fsync, close and cleanup
// execute unchanged. This is macOS host proof, not UIKit/iOS durability proof.
@main
struct ScopedTabsHarness {
    @MainActor static func main() throws {
        var checks = 0
        func check(_ condition: Bool, _ label: String) {
            precondition(condition, label)
            checks += 1
        }
        func rejects(_ label: String, _ action: () throws -> Void) {
            do { try action(); preconditionFailure("Expected rejection: " + label) }
            catch { checks += 1 }
        }
        func changedJSON(_ bytes: Data, _ change: (inout [String: Any]) -> Void) throws -> Data {
            var object = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            change(&object)
            return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        }
        guard let fixture = ProcessInfo.processInfo.environment["ZORID_SCOPED_TABS_FIXTURE"],
              fixture.hasPrefix("/private/tmp/zorid-scoped-tabs."),
              FileManager.default.fileExists(atPath: fixture) else {
            preconditionFailure("Only the runner's disposable fixture is permitted")
        }
        let fm = FileManager.default
        let base = URL(fileURLWithPath: fixture, isDirectory: true)
        try fm.createDirectory(at: base.appendingPathComponent("Library"), withIntermediateDirectories: true)
        let directory = base.appendingPathComponent("Library/Application Support/Zorid", isDirectory: true)
        let vaultA = UUID(), vaultB = UUID(), owner = UUID()
        func file(_ vault: UUID) -> URL {
            directory.appendingPathComponent("native-document-tabs-v2." + vault.uuidString.lowercased() + ".json")
        }
        let a = NativeDocumentTabs(vaultID: vaultA), b = NativeDocumentTabs(vaultID: vaultB)
        let homeID = a.selectedTabID
        let original = try a.encodedMetadata(), bytesB = try b.encodedMetadata()
        check(a.vaultID == vaultA && a.selectedTab.isHome && a.restoreDisposition == .fresh, "fresh scoped Home")
        let restoredHome = try NativeDocumentTabs(restoring: original, vaultID: vaultA)
        check(restoredHome.selectedTabID == homeID && restoredHome.vaultID == vaultA, "Home preserves exact UUID and scope")
        rejects("foreign Home scope") { _ = try NativeDocumentTabs(restoring: original, vaultID: vaultB) }
        let docA = try NativeTabDocument(vaultID: vaultA, localStoreID: "store-A", stableFileID: "file-A", displayTitle: "First")
        let docA2 = try NativeTabDocument(vaultID: vaultA, localStoreID: "store-other", stableFileID: "file-second", displayTitle: "Second")
        let docB = try NativeTabDocument(vaultID: vaultB, localStoreID: "store-B", stableFileID: "file-B", displayTitle: "Foreign")
        rejects("foreign replace") { _ = try a.prepare(.replaceSelected(docB), sourceOwnerID: owner) }
        rejects("foreign new tab") { _ = try a.prepare(.openInNewTab(docB), sourceOwnerID: owner) }
        let binding = try a.prepareActiveDocumentBinding(tabID: homeID, sourceOwnerID: owner)
        rejects("foreign active binding") { try a.bindActiveDocument(docB, using: binding, currentOwnerID: owner) }
        check(try a.encodedMetadata() == original && a.pendingIntent == nil, "foreign mutation leaves committed bytes exact")

        let ticket = try a.prepare(.replaceSelected(docA), sourceOwnerID: owner)
        let future = try a.encodedMetadata(for: ticket)
        check(try a.encodedMetadata() == original && a.selectedTabID == homeID && a.selectedTab.isHome, "prospective encode never mutates live UI")
        check(a.pendingIntent == ticket, "encoding does not consume ticket")
        let prospective = try NativeDocumentTabs(restoring: future, vaultID: vaultA)
        check(prospective.selectedTabID == homeID && prospective.selectedTab.document == docA, "future restores original slot as existing file")
        rejects("foreign model ticket same scope") { _ = try restoredHome.encodedMetadata(for: ticket) }
        rejects("foreign model ticket other scope") { _ = try b.encodedMetadata(for: ticket) }
        rejects("wrong close owner") { try a.commit(ticket, acknowledgement: .noActiveEditor(sourceOwnerID: UUID())) }
        check(try a.encodedMetadata() == original && a.encodedMetadata(for: ticket) == future, "failed ACK preserves old UI and exact retry bytes")

        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let legacy = directory.appendingPathComponent("native-document-tabs-v1.json")
        let legacyBytes = Data("untouched global development bytes".utf8)
        try legacyBytes.write(to: legacy)
        let storeA = try NativeTabMetadataStore(vaultID: vaultA), storeB = try NativeTabMetadataStore(vaultID: vaultB)
        if case .absent = try storeA.load() { checks += 1 } else { preconditionFailure("v1 must not be loaded") }
        try storeA.save(original)
        try storeB.save(bytesB)
        check(storeA.vaultID == vaultA && storeB.vaultID == vaultB, "immutable store scopes")
        let attributes = try fm.attributesOfItem(atPath: file(vaultA).path)
        check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "scoped file permissions 0600")
        rejects("store rejects other vault snapshot") { try storeA.save(bytesB) }
        check(try Data(contentsOf: file(vaultA)) == original && Data(contentsOf: file(vaultB)) == bytesB, "wrong scope save changes neither partition")
        // A concrete pre-replacement IO failure cannot advance UI or discard its
        // pending ticket. Repair only the disposable fixture and retry SAME bytes.
        try fm.removeItem(at: file(vaultA))
        try fm.createDirectory(at: file(vaultA), withIntermediateDirectories: false)
        rejects("unsafe target directory save") { try storeA.save(future) }
        check(try a.encodedMetadata() == original && a.pendingIntent == ticket, "failed save retains live state and plan")
        check(storeA.lastValidatedMetadata == original, "failure retains validated store cache")
        try fm.removeItem(at: file(vaultA))
        try storeA.save(future)
        check(!storeA.requiresDurabilityRetry && storeA.lastValidatedMetadata == future, "successful real save barrier")
        if case .restored(let disk) = try storeA.load() {
            check(disk == future, "durable prospective bytes exact")
            let afterCrash = try NativeDocumentTabs(restoring: disk, vaultID: vaultA)
            check(afterCrash.selectedTabID == homeID && afterCrash.selectedTab.document == docA, "future handoff survives model restart without new UUID")
        } else { preconditionFailure("saved target missing") }
        try a.cancel(ticket)
        rejects("cancelled encoding") { _ = try a.encodedMetadata(for: ticket) }
        rejects("cancelled commit") { try a.commit(ticket, acknowledgement: .noActiveEditor(sourceOwnerID: owner)) }
        check(try a.encodedMetadata() == original, "cancel after failed save/ACK leaves committed bytes unchanged")
        let replacement = try a.prepare(.replaceSelected(docA), sourceOwnerID: owner)
        rejects("superseded ticket") { _ = try a.encodedMetadata(for: ticket) }
        try a.commit(replacement, acknowledgement: .noActiveEditor(sourceOwnerID: owner))
        rejects("consumed future encoding") { _ = try a.encodedMetadata(for: replacement) }
        check(try a.encodedMetadata() == future, "commit matches durable prospective snapshot")
        let second = try a.prepare(.openInNewTab(docA2), sourceOwnerID: owner)
        try a.commit(second, acknowledgement: .noActiveEditor(sourceOwnerID: owner))
        let twoStores = try a.encodedMetadata()
        let two = try NativeDocumentTabs(restoring: twoStores, vaultID: vaultA)
        check(two.tabs.count == 2 && two.tabs[0].document == docA && two.tabs[1].document == docA2, "same vault opaque store identities retained independently")

        let invalid: [(String, Data)] = try [
            ("empty", Data()), ("malformed", Data("{".utf8)), ("utf8", Data([0xff])),
            ("v1", changedJSON(original) { $0["version"] = 1; $0.removeValue(forKey: "vaultID") }),
            ("schema", changedJSON(original) { $0["version"] = 99 }),
            ("unknown", changedJSON(original) { $0["content"] = "forbidden" }),
            ("missing original selected UUID", changedJSON(original) { $0["selectedTabID"] = UUID().uuidString }),
            ("duplicate tabs", changedJSON(original) { let tab = ($0["tabs"] as! [[String: Any]])[0]; $0["tabs"] = [tab, tab] }),
            ("oversized array", changedJSON(original) { let tab = ($0["tabs"] as! [[String: Any]])[0]; $0["tabs"] = Array(repeating: tab, count: 65) }),
            ("mixed vault document", changedJSON(future) { object in
                var tabs = object["tabs"] as! [[String: Any]]
                var document = tabs[0]["document"] as! [String: Any]
                document["vaultID"] = vaultB.uuidString
                tabs[0]["document"] = document; object["tabs"] = tabs
            }),
            ("encoded bytes bound", Data(repeating: 32, count: NativeDocumentTabs.maximumMetadataBytes + 1))
        ]
        for (label, bad) in invalid {
            rejects("restore " + label) { _ = try NativeDocumentTabs(restoring: bad, vaultID: vaultA) }
            try bad.write(to: file(vaultA))
            rejects("existing scoped file " + label) { _ = try storeA.load() }
            check(try Data(contentsOf: file(vaultA)) == bad, "invalid load never rewrites " + label)
            check(try Data(contentsOf: file(vaultB)) == bytesB, "other vault retained " + label)
        }
        // Existing foreign valid metadata at this vault's filename is an error.
        try bytesB.write(to: file(vaultA))
        rejects("foreign valid file at scoped path") { _ = try storeA.load() }
        try fm.removeItem(at: file(vaultA))
        try fm.createSymbolicLink(at: file(vaultA), withDestinationURL: file(vaultB))
        rejects("nofollow scoped read") { _ = try storeA.load() }
        rejects("nofollow scoped save") { try storeA.save(future) }
        check(try Data(contentsOf: file(vaultB)) == bytesB, "symlink target untouched")
        try fm.removeItem(at: file(vaultA))
        try storeA.save(twoStores)
        let reloadedA = try NativeTabMetadataStore(vaultID: vaultA)
        if case .restored(let disk) = try reloadedA.load() { check(disk == twoStores, "A independently restored") }
        else { preconditionFailure("A absent") }
        if case .restored(let disk) = try storeB.load() { check(disk == bytesB, "B independently restored") }
        else { preconditionFailure("B absent") }
        check(try Data(contentsOf: legacy) == legacyBytes, "global v1 left untouched")

        let bounded = NativeDocumentTabs(vaultID: vaultA)
        var hitEncodedLimit = false
        for index in 0..<64 {
            let before = try bounded.encodedMetadata()
            let escaped = try NativeTabDocument(vaultID: vaultA, localStoreID: "store", stableFileID: "file-\(index)", displayTitle: String(repeating: "\\", count: 1024))
            do {
                let plan = try bounded.prepare(.openInNewTab(escaped), sourceOwnerID: owner)
                try bounded.commit(plan, acknowledgement: .noActiveEditor(sourceOwnerID: owner))
            } catch NativeDocumentTabsError.metadataLimit {
                hitEncodedLimit = true
                check(try bounded.encodedMetadata() == before && bounded.pendingIntent == nil, "escaped JSON limit failure is atomic")
                break
            }
        }
        check(hitEncodedLimit, "escaped encoded budget checked before tab count")
        print("PASS \(checks) actual-source scoped model/store assertions (macOS disposable IO boundary)")
    }
}
