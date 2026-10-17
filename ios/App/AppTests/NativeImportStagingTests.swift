import XCTest
import CryptoKit
@testable import App

// Source-only until the owner registers a native test target and grants a slot.
// Fixtures are private temporary files, never the user's vault or provider data.
final class NativeImportStagingTests: XCTestCase {
    private var base: URL!
    private var inbox: URL!
    private var store: NativeImportStaging!
    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false)
        inbox = base.appendingPathComponent("inbox", isDirectory: true)
        store = NativeImportStaging(inboxRoot: inbox)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: base) }
    private func fixture(_ size: Int, name: String = "asset.bin") throws -> (URL, String) {
        let url = base.appendingPathComponent(name)
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
        let chunk = Data((0..<8192).map { UInt8($0 % 251) })
        var hash = SHA256(), remaining = size
        while remaining > 0 {
            let piece = chunk.prefix(min(chunk.count, remaining)); try handle.write(contentsOf: piece)
            hash.update(data: piece); remaining -= piece.count
        }
        try handle.synchronize()
        return (url, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }
    private func copy(_ url: URL, name: String? = nil, cancel: NativeImportCancellation = NativeImportCancellation()) throws -> NativeImportItem {
        try store.worker.sync { try store.copy(url, batchId: UUID(), fileName: name ?? url.lastPathComponent,
            typeIdentifier: "public.data", remaining: NativeImportStaging.batchLimit, cancellation: cancel) }
    }
    func testChunkBoundariesAndLargeBinaryPreserveExactBytes() throws {
        for size in [0, 1, 131071, 131072, 131073, 16 * 1024 * 1024 + 1, 64 * 1024 * 1024] {
            let (url, digest) = try fixture(size)
            let item = try copy(url)
            XCTAssertEqual(item.byteLength, UInt64(size)); XCTAssertEqual(item.sha256, digest)
            try store.worker.sync {
                let fd = try store.openPayload(item)
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
                var observed = SHA256(), count = 0
                while let chunk = try handle.read(upToCount: 131072), !chunk.isEmpty { observed.update(data: chunk); count += chunk.count }
                XCTAssertEqual(count, size); XCTAssertEqual(observed.finalize().map { String(format: "%02x", $0) }.joined(), digest)
                try store.removeConfirmed(item)
            }
            try FileManager.default.removeItem(at: url)
        }
        XCTAssertTrue(try store.worker.sync { try store.pending().isEmpty })
    }
    func testOversizeAndCancellationNeverPublish() throws {
        let url = base.appendingPathComponent("oversize.bin")
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        let file = try FileHandle(forWritingTo: url)
        try file.truncate(atOffset: NativeImportStaging.fileLimit + 1); try file.close()
        XCTAssertThrowsError(try copy(url))
        let (small, _) = try fixture(1)
        let cancellation = NativeImportCancellation(); cancellation.cancel()
        XCTAssertThrowsError(try copy(small, cancel: cancellation))
        XCTAssertTrue(try store.worker.sync { try store.pending().isEmpty })
    }
    func testTextClassificationRemainsRustAutoWithoutSwiftDowngrade() throws {
        let (url, _) = try fixture(262145, name: "note.md")
        let item = try copy(url)
        XCTAssertEqual(item.kind, "auto") // Core rejects unsupported text; shell never chooses binary.
        XCTAssertEqual(item.byteLength, 262145)
    }
    func testTraversalDirectoryAndSymbolicLinkSourcesAreRejected() throws {
        let (url, _) = try fixture(10)
        for name in ["../outside", "/absolute", "a/b", "a\\b", "..", "bad\nname"] { XCTAssertThrowsError(try copy(url, name: name)) }
        XCTAssertThrowsError(try copy(base, name: "directory"))
        let link = base.appendingPathComponent("link.bin")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
        XCTAssertThrowsError(try copy(link))
    }
    func testRecoveryRejectsSymlinkAncestorWithoutRemovingItsTarget() throws {
        let (url, _) = try fixture(1); let item = try copy(url)
        let batch = inbox.appendingPathComponent(item.batchId.uuidString)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try FileManager.default.removeItem(at: batch)
        try FileManager.default.createSymbolicLink(at: batch, withDestinationURL: outside)
        XCTAssertThrowsError(try store.worker.sync { try store.pending() })
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
    }
    func testRecoveryRemovesOnlyUnpublishedCopiesAndKeepsReadyItem() throws {
        let (url, _) = try fixture(1); let item = try copy(url)
        let batch = inbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let unready = batch.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: unready, withIntermediateDirectories: true)
        try Data([7]).write(to: unready.appendingPathComponent("payload.partial"))
        let recovered = try store.worker.sync { try store.pending() }
        XCTAssertEqual(recovered.map(\.itemId), [item.itemId]); XCTAssertFalse(FileManager.default.fileExists(atPath: batch.path))
    }
    func testCompletedBatchesDoNotAccumulateIntoRecoveryLimit() throws {
        let (url, _) = try fixture(0)
        for _ in 0..<101 { let item = try copy(url); try store.worker.sync { try store.removeConfirmed(item) } }
        XCTAssertTrue(try store.worker.sync { try store.pending().isEmpty })
    }
    func testSelectionJournalIsIdempotentAndCannotReplanAnUncertainOperation() throws {
        let (url, _) = try fixture(10); let item = try copy(url)
        let selection = NativeImportSelection(version: 1, clientId: UUID().uuidString.lowercased(),
            localStoreId: UUID().uuidString.lowercased(), operationId: UUID().uuidString.lowercased(),
            entryId: UUID().uuidString.lowercased(), destinationFolder: "", fileName: item.fileName,
            kind: "auto", expectedLength: String(item.byteLength), sha256: item.sha256)
        try store.worker.sync {
            try store.save(selection, for: item); try store.save(selection, for: item)
            XCTAssertEqual(try store.selection(for: item), selection)
            let replacement = NativeImportSelection(version: 1, clientId: selection.clientId,
                localStoreId: selection.localStoreId, operationId: UUID().uuidString.lowercased(),
                entryId: UUID().uuidString.lowercased(), destinationFolder: "", fileName: item.fileName,
                kind: "auto", expectedLength: String(item.byteLength), sha256: item.sha256)
            XCTAssertThrowsError(try store.save(replacement, for: item))
            XCTAssertEqual(try store.selection(for: item), selection)
        }
        let journal = inbox.appendingPathComponent(item.batchId.uuidString).appendingPathComponent(item.itemId.uuidString).appendingPathComponent("selection.json")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: journal)) as? [String: Any])
        XCTAssertNil(object["leaseToken"]); XCTAssertNil(object["sourcePath"])
    }

}
