import Foundation
import CryptoKit
import Darwin
import UniformTypeIdentifiers

// Provider bytes are copied here only. Vault storage and import semantics stay in Rust.
enum NativeImportFailure: Error {
    case unavailable, invalidSource, tooLarge, canceled, invalidJournal, invalidReply
    var message: String {
        switch self {
        case .tooLarge: return "This file exceeds the import limit (64 MiB; editable text 256 KiB)."
        case .canceled: return "Import canceled."
        default: return "The import could not be completed safely. Your staged files are retained for retry."
        }
    }
}

final class NativeImportCancellation {
    private let lock = NSLock()
    private var stopped = false
    private var progress: Progress?
    func cancel() { lock.lock(); stopped = true; let current = progress; lock.unlock(); current?.cancel() }
    func attach(_ value: Progress?) { lock.lock(); progress = value; let canceled = stopped; lock.unlock(); if canceled { value?.cancel() } }
    func check() throws { lock.lock(); let value = stopped; lock.unlock(); if value { throw NativeImportFailure.canceled } }
}

struct NativeImportItem: Codable {
    let version: Int
    let batchId: UUID
    let itemId: UUID
    let fileName: String
    let typeIdentifier: String
    let kind: String
    let byteLength: UInt64
    let sha256: String
}

// Persisted BEFORE begin. No URL, descriptor, root, provider metadata or secret crosses C ABI.
struct NativeImportSelection: Codable, Equatable {
    let version: Int
    let clientId: String
    let localStoreId: String
    let operationId: String
    let entryId: String
    let destinationFolder: String
    let fileName: String
    let kind: String
    let expectedLength: String
    let sha256: String
}

final class NativeImportStaging {
    static let fileLimit: UInt64 = 64 * 1024 * 1024
    static let textLimit: UInt64 = 262_144
    static let batchLimit: UInt64 = 512 * 1024 * 1024
    static let itemLimit = 20
    static let chunkSize = 128 * 1024
    static let shared = NativeImportStaging()
    // Synchronous provider callbacks MUST copy before their temporary URL expires.
    let worker = DispatchQueue(label: "app.zorid.import.staging", qos: .userInitiated)
    private let manager = FileManager.default
    private let inboxRoot: URL?
    init(inboxRoot: URL? = nil) { self.inboxRoot = inboxRoot }

    static func leaf(_ value: String) throws -> String {
        guard !value.isEmpty, value != ".", value != "..", value.utf8.count <= 255,
              !value.contains("/"), !value.contains("\\"),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { throw NativeImportFailure.invalidSource }
        return value
    }
    private func root() throws -> URL {
        let root: URL
        if let inboxRoot = inboxRoot { root = inboxRoot } else {
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            root = support.appendingPathComponent("NativeImportInbox-v1", isDirectory: true)
        }
        try directory(root)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutable = root; try mutable.setResourceValues(values)
        return root
    }
    private func directory(_ url: URL) throws {
        if !manager.fileExists(atPath: url.path) {
            try manager.createDirectory(at: url, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw NativeImportFailure.invalidSource }
    }
    private func location(_ item: NativeImportItem) throws -> URL {
        let batch = try root().appendingPathComponent(item.batchId.uuidString, isDirectory: true)
        try directory(batch)
        let itemURL = batch.appendingPathComponent(item.itemId.uuidString, isDirectory: true)
        try directory(itemURL)
        return itemURL
    }
    private func syncDirectory(_ url: URL) throws {
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw NativeImportFailure.unavailable }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw NativeImportFailure.unavailable }
    }
    private func durable(_ data: Data, to url: URL) throws {
        guard data.count <= 64 * 1024 else { throw NativeImportFailure.invalidJournal }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw NativeImportFailure.unavailable }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw NativeImportFailure.unavailable }
        try syncDirectory(url.deletingLastPathComponent())
    }

    // Called on staging worker; returns only after coordinated provider access ends.
    func copy(_ source: URL, batchId: UUID, fileName: String, typeIdentifier: String,
              remaining: UInt64, cancellation: NativeImportCancellation) throws -> NativeImportItem {
        let name = try Self.leaf(fileName)
        guard source.isFileURL, typeIdentifier.utf8.count <= 256 else { throw NativeImportFailure.invalidSource }
        try cancellation.check()
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var result: Result<NativeImportItem, Error>?
        NSFileCoordinator().coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { coordinated in
            result = Result { try self.copyCoordinated(coordinated, batchId: batchId, name: name,
                typeIdentifier: typeIdentifier, remaining: remaining, cancellation: cancellation) }
        }
        guard coordinationError == nil, let result = result else { throw NativeImportFailure.invalidSource }
        return try result.get()
    }
    private func copyCoordinated(_ source: URL, batchId: UUID, name: String, typeIdentifier: String,
                                 remaining: UInt64, cancellation: NativeImportCancellation) throws -> NativeImportItem {
        let sourceFD = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard sourceFD >= 0 else { throw NativeImportFailure.invalidSource }
        defer { Darwin.close(sourceFD) }
        var before = stat()
        guard fstat(sourceFD, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0 else { throw NativeImportFailure.invalidSource }
        // Rust Auto alone classifies editable text and enforces its 256KiB cap.
        let limit = min(remaining, Self.fileLimit)
        guard UInt64(before.st_size) <= limit else { throw NativeImportFailure.tooLarge }
        let batch = try root().appendingPathComponent(batchId.uuidString, isDirectory: true)
        try directory(batch)
        let itemId = UUID(), itemURL = batch.appendingPathComponent(itemId.uuidString, isDirectory: true)
        var destination: Int32 = -1
        var completed = false
        defer {
            if destination >= 0 { Darwin.close(destination) }
            // Only a never-published private item is removed here.
            if !completed {
                try? manager.removeItem(at: itemURL)
                if (try? manager.contentsOfDirectory(atPath: batch.path).isEmpty) == true {
                    try? manager.removeItem(at: batch); try? syncDirectory(batch.deletingLastPathComponent())
                }
            }
        }
        try directory(itemURL)
        let partial = itemURL.appendingPathComponent("payload.partial")
        destination = Darwin.open(partial.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard destination >= 0 else { throw NativeImportFailure.unavailable }
        var hash = SHA256(), total: UInt64 = 0
        var buffer = [UInt8](repeating: 0, count: Self.chunkSize)
        while true {
            try cancellation.check()
            let readCount = buffer.withUnsafeMutableBytes { Darwin.read(sourceFD, $0.baseAddress, $0.count) }
            if readCount < 0 { if errno == EINTR { continue }; throw NativeImportFailure.invalidSource }
            if readCount == 0 { break }
            guard total + UInt64(readCount) <= limit else { throw NativeImportFailure.tooLarge }
            buffer.withUnsafeBytes { hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[..<readCount])) }
            var offset = 0
            while offset < readCount {
                let count = buffer.withUnsafeBytes { Darwin.write(destination, $0.baseAddress!.advanced(by: offset), readCount - offset) }
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeImportFailure.unavailable }; offset += count
            }
            total += UInt64(readCount)
        }
        var after = stat()
        guard fstat(sourceFD, &after) == 0, total == UInt64(before.st_size), after.st_size == before.st_size,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
              after.st_ctimespec.tv_sec == before.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec
        else { throw NativeImportFailure.invalidSource }
        try cancellation.check()
        guard fsync(destination) == 0, fchmod(destination, 0o400) == 0 else { throw NativeImportFailure.unavailable }
        let payload = itemURL.appendingPathComponent("payload")
        guard Darwin.rename(partial.path, payload.path) == 0 else { throw NativeImportFailure.unavailable }
        let item = NativeImportItem(version: 1, batchId: batchId, itemId: itemId, fileName: name,
            typeIdentifier: typeIdentifier, kind: "auto", byteLength: total,
            sha256: hash.finalize().map { String(format: "%02x", $0) }.joined())
        try durable(JSONEncoder().encode(item), to: itemURL.appendingPathComponent("ready.json"))
        try syncDirectory(batch); try syncDirectory(batch.deletingLastPathComponent())
        completed = true
        return item
    }

    func pending() throws -> [NativeImportItem] {
        var items: [NativeImportItem] = []
        let root = try root()
        // Bound recovery enumeration too; no unbounded recursive directory walk.
        let batches = try children(root, limit: 100)
        var visited = 0
        for batch in batches {
            guard UUID(uuidString: batch.lastPathComponent) != nil else { continue }
            try directory(batch)
            for child in try children(batch, limit: 2000 - visited) {
                visited += 1
                guard visited <= 2000 else { throw NativeImportFailure.invalidJournal }
                guard UUID(uuidString: child.lastPathComponent) != nil else { throw NativeImportFailure.invalidJournal }
                try directory(child)
                let ready = child.appendingPathComponent("ready.json")
                guard manager.fileExists(atPath: ready.path) else {
                    // No ready manifest means begin could never have been admitted.
                    // A contradictory selection is corruption, retained for recovery.
                    guard !manager.fileExists(atPath: child.appendingPathComponent("selection.json").path) else { throw NativeImportFailure.invalidJournal }
                    try manager.removeItem(at: child); try syncDirectory(batch); continue
                }
                let data = try boundedRead(ready, limit: 8192)
                let item = try JSONDecoder().decode(NativeImportItem.self, from: data)
                guard item.version == 1, item.batchId.uuidString == batch.lastPathComponent, item.itemId.uuidString == child.lastPathComponent,
                      item.byteLength <= Self.fileLimit, item.kind == "auto",
                      item.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw NativeImportFailure.invalidJournal }
                _ = try Self.leaf(item.fileName); items.append(item)
            }
        }
        for batch in batches where (try? children(batch, limit: 1).isEmpty) == true {
            try manager.removeItem(at: batch); try syncDirectory(root)
        }
        return items
    }
    private func children(_ url: URL, limit: Int) throws -> [URL] {
        var failed = false
        guard let iterator = manager.enumerator(at: url, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants], errorHandler: { _, _ in failed = true; return false }) else { throw NativeImportFailure.invalidJournal }
        var result: [URL] = []
        for case let child as URL in iterator {
            guard result.count < limit else { throw NativeImportFailure.invalidJournal }
            result.append(child)
        }
        guard !failed else { throw NativeImportFailure.invalidJournal }; return result
    }
    private func boundedRead(_ url: URL, limit: Int) throws -> Data {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeImportFailure.invalidJournal }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0, info.st_size <= limit else { throw NativeImportFailure.invalidJournal }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count == info.st_size else { throw NativeImportFailure.invalidJournal }; return data
    }
    func selection(for item: NativeImportItem) throws -> NativeImportSelection? {
        let url = try location(item).appendingPathComponent("selection.json")
        if !manager.fileExists(atPath: url.path) { return nil }
        let selection = try JSONDecoder().decode(NativeImportSelection.self, from: boundedRead(url, limit: 8192))
        try validate(selection, item: item); return selection
    }
    func save(_ selection: NativeImportSelection, for item: NativeImportItem) throws {
        try validate(selection, item: item)
        if let existing = try self.selection(for: item) {
            guard existing == selection else { throw NativeImportFailure.invalidJournal }; return
        }
        try durable(JSONEncoder().encode(selection), to: try location(item).appendingPathComponent("selection.json"))
    }
    private func validate(_ selection: NativeImportSelection, item: NativeImportItem) throws {
        let canonical: (String) -> Bool = { UUID(uuidString: $0)?.uuidString.lowercased() == $0 }
        guard selection.version == 1, canonical(selection.clientId), canonical(selection.operationId), canonical(selection.entryId),
              selection.localStoreId.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              selection.fileName == item.fileName, selection.kind == item.kind, selection.sha256 == item.sha256,
              selection.expectedLength == String(item.byteLength), selection.destinationFolder.utf8.count <= 4096
        else { throw NativeImportFailure.invalidJournal }
    }
    func openPayload(_ item: NativeImportItem) throws -> Int32 {
        let fd = Darwin.open(try location(item).appendingPathComponent("payload").path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeImportFailure.invalidSource }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0, UInt64(info.st_size) == item.byteLength else {
            Darwin.close(fd); throw NativeImportFailure.invalidSource
        }
        return fd // Caller closes after synchronous native begin has duplicated it.
    }
    func removeConfirmed(_ item: NativeImportItem) throws {
        let url = try location(item)
        try manager.removeItem(at: url)
        let batch = url.deletingLastPathComponent()
        try syncDirectory(batch)
        if try manager.contentsOfDirectory(atPath: batch.path).isEmpty {
            try manager.removeItem(at: batch); try syncDirectory(batch.deletingLastPathComponent())
        }
    }
}
