import Foundation
import Darwin

// One app-owned, main-actor writer retained by the root coordinator. These are
// UI tab identities, not note content or Rust commit/lease receipts. No caller
// supplies a URL; UserDefaults compatibility policy remains root-owned.
@MainActor
final class NativeTabMetadataStore {
    enum LoadResult { case absent, restored(Data) }
    enum Kind { case invalidMetadata, unreadable, unsafePath, write, durability, cleanup }
    enum Stage {
        case locateSupport, openLibrary, openSupport, openStore, createDirectory
        case inspectTarget, openFile, readFile, validateMetadata, createTemp
        case writeTemp, syncTemp, closeTemp, replace, syncDirectory
        case closeFile, closeDirectory, cleanupTemp, syncCleanup
    }
    struct Issue: Error { let kind: Kind; let stage: Stage; let posixCode: Int32? }
    struct Failure: LocalizedError {
        let kind: Kind
        let stage: Stage
        let posixCode: Int32?
        let replacementMayBeVisible: Bool
        let temporaryFileMayRemain: Bool
        let cleanupFailures: [Issue]
        var errorDescription: String? {
            if replacementMayBeVisible {
                return "Tab metadata may already have been replaced, but its durable save is unconfirmed. Save the intended tab metadata successfully before acknowledging handoff."
            }
            return "Tab metadata could not be read or saved safely. Existing validated metadata has been retained."
        }
    }
    private static let limit = 131_072
    private static let fileName = "native-document-tabs-v1.json"
    private let library: URL
    private let supportName: String
    // This cache is never a claim about current disk bytes or a handoff ACK.
    // In particular it stays at the prior snapshot after uncertain replacement.
    private(set) var lastValidatedMetadata: Data?
    private var uncertainReplacement: Data?
    var requiresDurabilityRetry: Bool { uncertainReplacement != nil }

    init() throws {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
              support.isFileURL, support.path.hasPrefix("/"), !support.path.utf8.contains(0),
              !support.lastPathComponent.isEmpty, support.lastPathComponent != ".", support.lastPathComponent != ".." else {
            throw Failure(kind: .unsafePath, stage: .locateSupport, posixCode: nil,
                          replacementMayBeVisible: false, temporaryFileMayRemain: false, cleanupFailures: [])
        }
        library = support.deletingLastPathComponent()
        supportName = support.lastPathComponent
    }

    // ENOENT alone means absent. Invalid/unreadable bytes are never silently
    // converted into a fresh Home model or overwritten by load(). During an
    // uncertain save this reports visible bytes but does NOT promote the cache.
    func load() throws -> LoadResult {
        var descriptors: [(Int32, Stage)] = []
        var issue: Issue?
        var result: LoadResult = .absent
        do {
            if let directory = try openStore(create: false, descriptors: &descriptors) {
                let fd = Darwin.openat(directory, Self.fileName, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
                if fd < 0 {
                    if errno != ENOENT { throw problem(.unreadable, .openFile) }
                } else {
                    descriptors.append((fd, .closeFile))
                    let bytes = try readBounded(fd, directory: directory)
                    try validate(bytes)
                    result = .restored(bytes)
                }
            }
        } catch let failure as Issue { issue = failure }
        catch { issue = Issue(kind: .unreadable, stage: .readFile, posixCode: nil) }
        let cleanup = closeAll(&descriptors, kind: .unreadable)
        if issue != nil || !cleanup.isEmpty {
            throw failure(issue, cleanup: cleanup, visible: requiresDurabilityRetry, tempMayRemain: false)
        }
        if case .restored(let bytes) = result, !requiresDurabilityRetry { lastValidatedMetadata = bytes }
        return result
    }

    // Return without throwing is the only durable-save barrier this API offers.
    // Root may ACK the separate NewNote intent only after this succeeds AND its
    // selected tab/entry handoff is durably recoverable. Notes already live in Rust.
    func save(_ bytes: Data) throws {
        var descriptors: [(Int32, Stage)] = []
        var issue: Issue?
        var cleanup: [Issue] = []
        var directory: Int32?
        var tempFD: Int32 = -1
        var tempName: String?
        var tempIdentity: stat?
        var replacementAttempted = false
        var tempMayRemain = false
        do {
            try validate(bytes)
            // Root may re-encode the same model with different JSON key order.
            // Each explicit save validates and fully syncs its supplied bytes;
            // a failed prior attempt is never treated as durable or rolled back.
            guard let opened = try openStore(create: true, descriptors: &descriptors) else {
                throw Issue(kind: .write, stage: .openStore, posixCode: nil)
            }
            directory = opened
            _ = try inspectTarget(opened)
            let name = ".native-document-tabs-v1." + UUID().uuidString.lowercased() + ".tmp"
            tempFD = Darwin.openat(opened, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard tempFD >= 0 else { throw problem(.write, .createTemp) }
            tempName = name // Only an actually O_EXCL-created name is ours to unlink.
            var identity = stat()
            guard fstat(tempFD, &identity) == 0 else { throw problem(.write, .createTemp) }
            tempIdentity = identity
            guard identity.st_mode & S_IFMT == S_IFREG, identity.st_nlink == 1 else {
                throw Issue(kind: .unsafePath, stage: .createTemp, posixCode: nil)
            }
            guard fchmod(tempFD, 0o600) == 0 else { throw problem(.write, .createTemp) }
            try bytes.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(tempFD, buffer.baseAddress!.advanced(by: offset), min(16_384, buffer.count - offset))
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw problem(.write, .writeTemp) }
                    offset += count
                }
            }
            try sync(tempFD, stage: .syncTemp)
            let closing = tempFD; tempFD = -1 // Never retry close after an error.
            guard Darwin.close(closing) == 0 else { throw problem(.durability, .closeTemp) }
            guard try sameNamedFile(opened, name: name, identity: identity) else {
                throw Issue(kind: .unsafePath, stage: .inspectTarget, posixCode: nil)
            }
            _ = try inspectTarget(opened)
            replacementAttempted = true // Even a rename I/O error is not a rollback promise.
            guard Darwin.renameat(opened, name, opened, Self.fileName) == 0 else { throw problem(.write, .replace) }
            tempName = nil
            guard try sameNamedFile(opened, name: Self.fileName, identity: identity) else {
                throw Issue(kind: .unsafePath, stage: .replace, posixCode: nil)
            }
            try sync(opened, stage: .syncDirectory)
        } catch let failure as Issue { issue = failure }
        catch { issue = Issue(kind: .write, stage: .writeTemp, posixCode: nil) }
        if tempFD >= 0 {
            let closing = tempFD; tempFD = -1
            if Darwin.close(closing) != 0 { cleanup.append(problem(.cleanup, .closeTemp)) }
        }
        if let name = tempName, let directory = directory {
            do {
                // A name replaced by somebody else is not ours to delete. No
                // directory enumeration, stale-temp sweep or destination unlink.
                guard let identity = tempIdentity,
                      try sameNamedFile(directory, name: name, identity: identity) else {
                    throw Issue(kind: .cleanup, stage: .cleanupTemp, posixCode: nil)
                }
                guard Darwin.unlinkat(directory, name, 0) == 0 else { throw problem(.cleanup, .cleanupTemp) }
                try sync(directory, stage: .syncCleanup)
            } catch let failure as Issue { cleanup.append(failure); tempMayRemain = true }
            catch { cleanup.append(Issue(kind: .cleanup, stage: .cleanupTemp, posixCode: nil)); tempMayRemain = true }
        }
        cleanup.append(contentsOf: closeAll(&descriptors, kind: .durability))
        if issue != nil || !cleanup.isEmpty {
            if replacementAttempted { uncertainReplacement = bytes }
            throw failure(issue, cleanup: cleanup, visible: requiresDurabilityRetry || replacementAttempted, tempMayRemain: tempMayRemain)
        }
        // Includes checked file/directory sync, exact temp handling and closes.
        uncertainReplacement = nil; lastValidatedMetadata = bytes
    }

    private func validate(_ bytes: Data) throws {
        guard !bytes.isEmpty, bytes.count <= Self.limit, String(data: bytes, encoding: .utf8) != nil,
              NativeDocumentTabs(restoring: bytes).restoreDisposition == .restored else {
            throw Issue(kind: .invalidMetadata, stage: .validateMetadata, posixCode: nil)
        }
    }
    private func openStore(create: Bool, descriptors: inout [(Int32, Stage)]) throws -> Int32? {
        let fd = Darwin.open(library.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT && !create { return nil }
            throw problem(.unreadable, .openLibrary)
        }
        descriptors.append((fd, .closeDirectory))
        guard let support = try childDirectory(fd, name: supportName, create: create, stage: .openSupport, descriptors: &descriptors) else { return nil }
        // Sync ancestry on EVERY save, including retry after an earlier mkdir
        // succeeded but parent fsync failed. Child-only fsync would be insufficient.
        if create { try sync(fd, stage: .syncDirectory) }
        guard let store = try childDirectory(support, name: "Zorid", create: create, stage: .openStore, descriptors: &descriptors) else { return nil }
        if create {
            guard fchmod(store, 0o700) == 0 else { throw problem(.write, .openStore) }
            try sync(support, stage: .syncDirectory)
        }
        return store
    }
    private func childDirectory(_ parent: Int32, name: String, create: Bool, stage: Stage,
                                descriptors: inout [(Int32, Stage)]) throws -> Int32? {
        var fd = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 && errno == ENOENT && create {
            if Darwin.mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { throw problem(.write, .createDirectory) }
            fd = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        if fd < 0 {
            if errno == ENOENT && !create { return nil }
            throw problem(.unreadable, stage)
        }
        descriptors.append((fd, .closeDirectory))
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw problem(.unreadable, stage) }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw Issue(kind: .unsafePath, stage: stage, posixCode: nil) }
        return fd
    }
    private func inspectTarget(_ directory: Int32) throws -> stat? {
        var info = stat()
        if Darwin.fstatat(directory, Self.fileName, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return nil }; throw problem(.unreadable, .inspectTarget)
        }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else {
            throw Issue(kind: .unsafePath, stage: .inspectTarget, posixCode: nil)
        }
        return info
    }
    private func sameNamedFile(_ directory: Int32, name: String, identity: stat) throws -> Bool {
        var info = stat()
        if Darwin.fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) != 0 { throw problem(.unreadable, .inspectTarget) }
        return info.st_mode & S_IFMT == S_IFREG && info.st_nlink == 1
            && info.st_dev == identity.st_dev && info.st_ino == identity.st_ino
    }
    private func readBounded(_ fd: Int32, directory: Int32) throws -> Data {
        var before = stat()
        guard fstat(fd, &before) == 0 else { throw problem(.unreadable, .readFile) }
        guard before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1 else {
            throw Issue(kind: .unsafePath, stage: .readFile, posixCode: nil)
        }
        guard before.st_size > 0, before.st_size <= Self.limit else {
            throw Issue(kind: .invalidMetadata, stage: .readFile, posixCode: nil)
        }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, min($0.count, Self.limit + 1 - bytes.count)) }
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw problem(.unreadable, .readFile) }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
            guard bytes.count <= Self.limit else { throw Issue(kind: .invalidMetadata, stage: .readFile, posixCode: nil) }
        }
        var after = stat()
        guard fstat(fd, &after) == 0 else { throw problem(.unreadable, .readFile) }
        guard before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size,
              after.st_nlink == 1, bytes.count == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              try sameNamedFile(directory, name: Self.fileName, identity: after) else {
            throw Issue(kind: .unreadable, stage: .readFile, posixCode: nil)
        }
        return bytes
    }
    private func sync(_ fd: Int32, stage: Stage) throws {
        while fsync(fd) != 0 { if errno != EINTR { throw problem(.durability, stage) } }
    }
    private func closeAll(_ descriptors: inout [(Int32, Stage)], kind: Kind) -> [Issue] {
        var failures: [Issue] = []
        while let (fd, stage) = descriptors.popLast() {
            if Darwin.close(fd) != 0 { failures.append(problem(kind, stage)) }
        }
        return failures
    }
    private func problem(_ kind: Kind, _ stage: Stage) -> Issue {
        let code = errno
        return Issue(kind: code == ELOOP || code == ENOTDIR ? .unsafePath : kind, stage: stage, posixCode: code)
    }
    private func failure(_ primary: Issue?, cleanup: [Issue], visible: Bool, tempMayRemain: Bool) -> Failure {
        let first = primary ?? cleanup.first ?? Issue(kind: .unreadable, stage: .readFile, posixCode: nil)
        return Failure(kind: first.kind, stage: first.stage, posixCode: first.posixCode,
                       replacementMayBeVisible: visible, temporaryFileMayRemain: tempMayRemain,
                       cleanupFailures: primary == nil ? Array(cleanup.dropFirst()) : cleanup)
    }
}
