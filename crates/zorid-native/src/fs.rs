use crate::{Error, Result};
use rustix::fs::{self, Dir, Mode, OFlags, RenameFlags};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zorid_core::VaultPath;

pub(crate) fn identity(file: &File) -> Result<String> {
    let m = file.metadata()?;
    Ok(format!("{}:{}", m.dev(), m.ino()))
}
fn flags() -> OFlags {
    OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK
}
fn open_dir_at(parent: &File, name: &str) -> Result<File> {
    exact(parent, name)?;
    Ok(fs::openat(
        parent,
        name,
        flags() | OFlags::RDONLY | OFlags::DIRECTORY,
        Mode::empty(),
    )?
    .into())
}
// macOS supplies the stored leaf spelling directly. This is a fresh lookup,
// never a timestamp-based cache: FAT and network volumes may have coarse or
// unchanged directory timestamps after a case-only rename.
#[cfg(target_os = "macos")]
mod canonical_leaf {
    use super::*;
    use std::{
        ffi::{c_char, c_int, c_ulong, c_void, CString},
        os::fd::AsRawFd,
    };
    const NAME: u32 = 1;
    const DEVICE: u32 = 2;
    const RETURNED: u32 = 0x8000_0000;
    #[repr(C)]
    struct AttrList {
        count: u16,
        reserved: u16,
        common: u32,
        volume: u32,
        directory: u32,
        file: u32,
        fork: u32,
    }
    impl AttrList {
        fn new(common: u32, volume: u32) -> Self {
            Self {
                count: 5,
                reserved: 0,
                common,
                volume,
                directory: 0,
                file: 0,
                fork: 0,
            }
        }
    }
    unsafe extern "C" {
        fn fgetattrlist(
            fd: c_int,
            attributes: *mut c_void,
            buffer: *mut c_void,
            size: usize,
            options: u32,
        ) -> c_int;
        fn getattrlistat(
            fd: c_int,
            path: *const c_char,
            attributes: *mut c_void,
            buffer: *mut c_void,
            size: usize,
            options: c_ulong,
        ) -> c_int;
    }
    // ATTR_VOL_ATTRIBUTES contains validattr then nativeattr, each five u32s.
    // Require native support: XNU can otherwise synthesize NAME from vnode cache.
    pub(super) fn native_name_supported(words: &[u32]) -> bool {
        words.len() == 11 && words[0] == 44 && words[1] & NAME != 0 && words[6] & NAME != 0
    }
    pub(super) fn parse_name(bytes: &[u8], parent_device: u64) -> Option<&[u8]> {
        fn word(bytes: &[u8], at: usize) -> Option<u32> {
            Some(u32::from_ne_bytes(
                bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
            ))
        }
        let length = usize::try_from(word(bytes, 0)?).ok()?;
        if !(37..=bytes.len()).contains(&length)
            || word(bytes, 4)? != (NAME | DEVICE | RETURNED)
            || [8, 12, 16, 20]
                .into_iter()
                .any(|at| word(bytes, at) != Some(0))
            || u64::from(word(bytes, 32)?) != parent_device
        {
            return None;
        }
        // attrreference offset is signed and relative to its own address.
        let offset = i32::from_ne_bytes(bytes.get(24..28)?.try_into().ok()?);
        let start = 24usize.checked_add(usize::try_from(offset).ok()?)?;
        let size = usize::try_from(word(bytes, 28)?).ok()?;
        let end = start.checked_add(size)?;
        if start < 36 || size < 2 || end > length {
            return None;
        }
        let raw = bytes.get(start..end)?;
        if raw.last() != Some(&0) || raw[..raw.len() - 1].contains(&0) {
            return None;
        }
        let name = &raw[..raw.len() - 1];
        if name.contains(&b'/') || matches!(name, b"." | b"..") {
            return None;
        }
        Some(name)
    }
    pub(super) fn supported(parent: &File) -> bool {
        let mut attributes = AttrList::new(0, 0xc000_0000); // VOL_INFO | VOL_ATTRIBUTES
        let mut volume = [0u32; 11];
        // SAFETY: fixed ABI layouts from sys/attr.h; buffers are initialized,
        // writable, and correctly sized. Only the existing directory FD is used.
        if unsafe {
            fgetattrlist(
                parent.as_raw_fd(),
                (&mut attributes as *mut AttrList).cast(),
                volume.as_mut_ptr().cast(),
                std::mem::size_of_val(&volume),
                0,
            )
        } != 0
            || !native_name_supported(&volume)
        {
            return false;
        }
        true
    }
    pub(super) fn matches(parent: &File, name: &str) -> bool {
        let Ok(path) = CString::new(name) else {
            return false;
        };
        if name.is_empty() || name.contains('/') || matches!(name, "." | "..") {
            return false;
        }
        let Ok(metadata) = parent.metadata() else {
            return false;
        };
        if !metadata.is_dir() || metadata.nlink() == 0 {
            return false;
        }
        if !supported(parent) {
            return false;
        }
        let mut attributes = AttrList::new(NAME | DEVICE | RETURNED, 0);
        let mut output = [0u8; 2048];
        // FSOPT_NOFOLLOW preserves symlink treatment and never opens/closes a
        // target descriptor (especially SQLite-owned DB/SHM/WAL descriptors).
        if unsafe {
            getattrlistat(
                parent.as_raw_fd(),
                path.as_ptr(),
                (&mut attributes as *mut AttrList).cast(),
                output.as_mut_ptr().cast(),
                output.len(),
                1,
            )
        } != 0
        {
            return false;
        }
        parse_name(&output, metadata.dev()) == Some(name.as_bytes())
    }
}

#[cfg(test)]
thread_local! {
    static EXACT_ENUMERATED_ENTRIES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static EXACT_FORCE_ENUMERATION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// Reject a spelling which aliases another entry on a case/normalization folding
/// filesystem. NOFOLLOW separately rejects symlinks, including dangling ones.
pub(crate) fn exact(parent: &File, name: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        #[cfg(test)]
        let fast_path = !EXACT_FORCE_ENUMERATION.with(std::cell::Cell::get);
        #[cfg(not(test))]
        let fast_path = true;
        if fast_path && canonical_leaf::matches(parent, name) {
            return Ok(());
        }
    }
    // Unsupported native NAME, a different target filesystem, malformed output,
    // an error, or a nonmatching name all retain the original complete check.
    let mut found = false;
    for entry in Dir::read_from(parent)? {
        #[cfg(test)]
        EXACT_ENUMERATED_ENTRIES.with(|work| work.set(work.get() + 1));
        if entry?.file_name().to_bytes() == name.as_bytes() {
            found = true;
        }
    }
    if !found {
        match fs::statat(parent, name, fs::AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => return Err(Error::UnsafePath(format!("filesystem alias: {name}"))),
            Err(rustix::io::Errno::NOENT) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub(crate) fn regular(parent: &File, name: &str) -> Result<Option<File>> {
    exact(parent, name)?;
    match fs::openat(parent, name, flags() | OFlags::RDONLY, Mode::empty()) {
        Ok(fd) => {
            let file: File = fd.into();
            let m = file.metadata()?;
            if !m.is_file() || m.nlink() != 1 {
                return Err(Error::UnsafePath(format!(
                    "not a single-link regular file: {name}"
                )));
            }
            Ok(Some(file))
        }
        Err(rustix::io::Errno::NOENT) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
/// Inspect SQLite-owned paths without opening them. On Unix, closing ANY
/// descriptor for a DB/SHM inode drops this process's POSIX locks on that inode,
/// including locks held by SQLite through another descriptor. Never use regular()
/// (or File::open/read) for these checks while a connection may be alive.
pub(crate) fn regular_identity(parent: &File, name: &str) -> Result<Option<String>> {
    exact(parent, name)?;
    match fs::statat(parent, name, fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => {
            if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::RegularFile
                || stat.st_nlink != 1
            {
                return Err(Error::UnsafePath(format!(
                    "not a single-link regular file: {name}"
                )));
            }
            Ok(Some(format!("{}:{}", stat.st_dev, stat.st_ino)))
        }
        Err(rustix::io::Errno::NOENT) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
#[derive(Debug)]
pub(crate) struct Snapshot {
    pub bytes: Vec<u8>,
    pub identity: String,
}
pub(crate) fn snapshot(parent: &File, name: &str, limit: usize) -> Result<Option<Snapshot>> {
    let Some(mut file) = regular(parent, name)? else {
        return Ok(None);
    };
    let before = file.metadata()?;
    if before.len() > limit as u64 {
        return Err(Error::Unsupported(
            "file exceeds configured whole-file limit",
        ));
    }
    let mut bytes = Vec::new();
    (&mut file).take(limit as u64 + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() > limit {
        return Err(Error::Unsupported(
            "file exceeds configured whole-file limit",
        ));
    }
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(Error::Busy("file changed while reading"));
    }
    // Check pathname still identifies this opened file. Never infer ancestry from
    // mtime alone; byte comparisons and persisted baselines decide import policy.
    let current = regular(parent, name)?.ok_or(Error::Busy("file disappeared while reading"))?;
    let id = identity(&file)?;
    if identity(&current)? != id {
        return Err(Error::Busy("file replaced while reading"));
    }
    Ok(Some(Snapshot {
        bytes,
        identity: id,
    }))
}
pub(crate) fn rename_new(from: &File, old: &str, to: &File, new: &str) -> Result<()> {
    exact(from, old)?;
    exact(to, new)?;
    fs::renameat_with(from, old, to, new, RenameFlags::NOREPLACE)?;
    from.sync_all()?;
    to.sync_all()?;
    Ok(())
}
/// Retire one proven regular file in an already verified private directory.
/// The caller must revalidate captured content immediately before this call.
/// Unix has no compare-inode-and-unlink operation: this uses the same private,
/// current-user-owned directory trust boundary as the native staging renames.
/// It is not an unlink primitive for concurrently hostile public directories.
pub(crate) fn unlink_regular_identity(parent: &File, name: &str, expected: &str) -> Result<()> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err(Error::UnsafePath(
            "unlink requires an exact leaf name".into(),
        ));
    }
    if regular_identity(parent, name)?.as_deref() != Some(expected) {
        return Err(Error::Busy(
            "retained file identity changed before retirement",
        ));
    }
    fs::unlinkat(parent, name, fs::AtFlags::empty())?;
    parent.sync_all()?;
    Ok(())
}
pub(crate) fn stage(dir: &File, name: &str, bytes: &[u8]) -> Result<String> {
    exact(dir, name)?;
    let mut f: File = fs::openat(
        dir,
        name,
        flags() | OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL,
        Mode::from_raw_mode(0o600),
    )?
    .into();
    #[cfg(test)]
    if std::env::var_os("ZORID_NATIVE_TEST_PARTIAL_STAGE").is_some() {
        f.write_all(&bytes[..bytes.len() / 2])?;
        f.sync_all()?;
        std::process::exit(78);
    }
    f.write_all(bytes)?;
    f.sync_all()?;
    dir.sync_all()?;
    identity(&f)
}
pub(crate) struct Paths {
    pub root: File,
    pub private: File,
    pub absolute: PathBuf,
    pub private_id: String,
    pub db_id: Option<String>,
}
impl Paths {
    pub fn open(path: &Path, create: bool) -> Result<Self> {
        // Resolve the explicitly selected root ONCE. All content traversal from
        // this handle is descriptor-relative and rejects symlink components.
        let absolute = path.canonicalize()?;
        let root: File = fs::open(
            &absolute,
            flags() | OFlags::RDONLY | OFlags::DIRECTORY,
            Mode::empty(),
        )?
        .into();
        exact(&root, ".zorid")?;
        if create {
            match fs::mkdirat(&root, ".zorid", Mode::from_raw_mode(0o700)) {
                Ok(()) => root.sync_all()?,
                Err(rustix::io::Errno::EXIST) => {}
                Err(e) => return Err(e.into()),
            }
        }
        let private = open_dir_at(&root, ".zorid")?;
        let m = private.metadata()?;
        if m.uid() != rustix::process::geteuid().as_raw() || m.mode() & 0o077 != 0 {
            return Err(Error::UnsafePath(
                ".zorid must be private and owned by current user".into(),
            ));
        }
        let private_id = identity(&private)?;
        let result = Self {
            root,
            private,
            absolute,
            private_id,
            db_id: None,
        };
        result.verify()?;
        Ok(result)
    }
    pub fn verify(&self) -> Result<()> {
        let root_now: File = fs::open(
            &self.absolute,
            flags() | OFlags::RDONLY | OFlags::DIRECTORY,
            Mode::empty(),
        )?
        .into();
        if identity(&root_now)? != identity(&self.root)?
            || identity(&open_dir_at(&self.root, ".zorid")?)? != self.private_id
        {
            return Err(Error::UnsafePath(
                "vault or private directory identity changed".into(),
            ));
        }
        let private_metadata = self.private.metadata()?;
        if private_metadata.uid() != rustix::process::geteuid().as_raw()
            || private_metadata.mode() & 0o077 != 0
        {
            return Err(Error::UnsafePath(
                "private metadata permissions changed".into(),
            ));
        }
        for name in [
            "vault.sqlite",
            "vault.sqlite-wal",
            "vault.sqlite-shm",
            "vault.sqlite-journal",
            "vault.lock",
        ] {
            if let Some(current_id) = regular_identity(&self.private, name)? {
                if name == "vault.sqlite" && self.db_id.as_ref().is_some_and(|id| &current_id != id)
                {
                    return Err(Error::UnsafePath("database identity changed".into()));
                }
            } else if name == "vault.sqlite" && self.db_id.is_some() {
                return Err(Error::UnsafePath("database disappeared".into()));
            }
        }
        Ok(())
    }
    pub fn lock(&self, timeout: Duration) -> Result<File> {
        self.verify()?;
        exact(&self.private, "vault.lock")?;
        let file: File = fs::openat(
            &self.private,
            "vault.lock",
            flags() | OFlags::RDWR | OFlags::CREATE,
            Mode::from_raw_mode(0o600),
        )?
        .into();
        let m = file.metadata()?;
        if !m.is_file() || m.nlink() != 1 {
            return Err(Error::UnsafePath("invalid lock file".into()));
        }
        let deadline = Instant::now() + timeout;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(std::fs::TryLockError::WouldBlock) => return Err(Error::LockTimeout),
                Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
            }
        }
        let named = regular(&self.private, "vault.lock")?
            .ok_or_else(|| Error::UnsafePath("lock disappeared".into()))?;
        if identity(&named)? != identity(&file)? {
            return Err(Error::UnsafePath("lock identity changed".into()));
        }
        self.verify()?;
        Ok(file)
    }
    pub fn parent(&self, path: &VaultPath) -> Result<(File, String)> {
        let (dir, name) = self.parent_scope(path)?;
        exact(&dir, &name)?;
        Ok((dir, name))
    }
    /// Namespace preflight may need a future case-only leaf spelling while the
    /// old source still occupies its alias. All ancestor spellings remain exact.
    /// This does not authorize reading/writing that unchecked leaf.
    pub(crate) fn parent_scope(&self, path: &VaultPath) -> Result<(File, String)> {
        let mut parts: Vec<&str> = path.as_str().split('/').collect();
        let name = parts.pop().unwrap().to_owned();
        let mut dir = self.root.try_clone()?;
        for part in parts {
            dir = open_dir_at(&dir, part)?;
        }
        Ok((dir, name))
    }
    pub(crate) fn verify_parent_scope(&self, path: &VaultPath, expected: &File) -> Result<()> {
        self.verify()?;
        let (current, _) = self.parent_scope(path)?;
        if identity(&current)? != identity(expected)? {
            return Err(Error::Busy("namespace parent directory moved or replaced"));
        }
        Ok(())
    }
    pub fn verify_parent(&self, path: &VaultPath, expected: &File) -> Result<()> {
        self.verify()?;
        let (current, _) = self.parent(path)?;
        if identity(&current)? != identity(expected)? {
            return Err(Error::Busy(
                "parent directory moved/replaced during projection",
            ));
        }
        Ok(())
    }
    pub fn directory(&self, path: &VaultPath) -> Result<File> {
        let (parent, name) = self.parent(path)?;
        open_dir_at(&parent, &name)
    }
}

pub(crate) fn node_type(parent: &File, name: &str) -> Result<Option<rustix::fs::FileType>> {
    exact(parent, name)?;
    match fs::statat(parent, name, fs::AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(Some(fs::FileType::from_raw_mode(stat.st_mode))),
        Err(rustix::io::Errno::NOENT) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn optional_directory(parent: &File, name: &str) -> Result<Option<File>> {
    match node_type(parent, name)? {
        None => Ok(None),
        Some(fs::FileType::Directory) => Ok(Some(open_dir_at(parent, name)?)),
        Some(_) => Err(Error::UnsafePath(format!(
            "expected real directory: {name}"
        ))),
    }
}
/// Emptiness is independent of UTF-8 representability and enumeration budgets.
/// Stop at the first real entry, including names the logical vault cannot import.
pub(crate) fn directory_empty(directory: &File) -> Result<bool> {
    for item in Dir::read_from(directory)? {
        let item = item?;
        let name = item.file_name().to_bytes();
        if name != b"." && name != b".." {
            return Ok(false);
        }
    }
    Ok(true)
}
pub(crate) fn directory_names(directory: &File, limit: usize, root: bool) -> Result<Vec<String>> {
    let mut names = Vec::new();
    for item in Dir::read_from(directory)? {
        let item = item?;
        let bytes = item.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        let name = std::str::from_utf8(bytes).map_err(|_| {
            Error::UnsafePath("non-UTF8 directory entry cannot be represented".into())
        })?;
        if root && name.eq_ignore_ascii_case(".zorid") {
            continue;
        }
        if names.len() >= limit {
            return Err(Error::Unsupported("scan entry budget exhausted"));
        }
        names.push(name.to_owned());
    }
    names.sort();
    Ok(names)
}
pub(crate) fn stage_directory(parent: &File, name: &str) -> Result<String> {
    exact(parent, name)?;
    fs::mkdirat(parent, name, Mode::from_raw_mode(0o700))?;
    let dir = open_dir_at(parent, name)?;
    dir.sync_all()?;
    parent.sync_all()?;
    identity(&dir)
}

#[cfg(test)]
mod exact_name_tests {
    use super::*;
    fn work() -> usize {
        EXACT_ENUMERATED_ENTRIES.with(std::cell::Cell::get)
    }
    fn check_alias(parent: &File, directory: &Path, name: &str) {
        use std::os::unix::ffi::OsStrExt;
        let exists = std::fs::symlink_metadata(directory.join(name)).is_ok();
        let listed = std::fs::read_dir(directory)
            .unwrap()
            .any(|entry| entry.unwrap().file_name().as_bytes() == name.as_bytes());
        let result = exact(parent, name);
        if exists && !listed {
            assert!(matches!(result, Err(Error::UnsafePath(_))));
        } else {
            result.unwrap();
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn exact_names_locked_pass_enumerates_stable_directory_once() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..1000 {
            std::fs::write(root.path().join(format!("Note {i:04}.md")), b"note").unwrap();
        }
        let parent = File::open(root.path()).unwrap();
        // This product optimization requires native NAME support. Other volumes
        // deliberately retain the original enumeration path, tested separately.
        if !canonical_leaf::supported(&parent) {
            return;
        }
        assert!(canonical_leaf::matches(&parent, "Note 0000.md"));
        EXACT_ENUMERATED_ENTRIES.with(|work| work.set(0));
        for _ in 0..2 {
            for i in 0..1000 {
                exact(&parent, &format!("Note {i:04}.md")).unwrap();
            }
        }
        let work = work();
        assert!(
            work <= 1002,
            "stable directory enumerated repeatedly: {work} entries"
        );
    }
    #[test]
    fn exact_names_fallback_preserves_complete_enumeration() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("A.md"), b"a").unwrap();
        let parent = File::open(root.path()).unwrap();
        EXACT_FORCE_ENUMERATION.with(|slot| slot.set(true));
        let before = work();
        exact(&parent, "A.md").unwrap();
        exact(&parent, "A.md").unwrap();
        check_alias(&parent, root.path(), "a.md");
        EXACT_FORCE_ENUMERATION.with(|slot| slot.set(false));
        assert!(work() - before >= 2);
    }
    #[test]
    fn exact_names_fresh_lookup_preserves_create_delete_and_case_rename() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Original.md"), b"note").unwrap();
        let parent = File::open(root.path()).unwrap();
        exact(&parent, "Original.md").unwrap();
        std::fs::write(root.path().join("Created.md"), b"new").unwrap();
        exact(&parent, "Created.md").unwrap();
        std::fs::remove_file(root.path().join("Created.md")).unwrap();
        assert!(regular(&parent, "Created.md").unwrap().is_none());
        std::fs::rename(
            root.path().join("Original.md"),
            root.path().join("original.md"),
        )
        .unwrap();
        check_alias(&parent, root.path(), "Original.md");
        exact(&parent, "original.md").unwrap();
    }
    #[test]
    fn exact_names_preserve_unicode_alias_and_nofollow_checks() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("é.md"), b"unicode").unwrap();
        let parent = File::open(root.path()).unwrap();
        check_alias(&parent, root.path(), "é.md");
        check_alias(&parent, root.path(), "e\u{301}.md");
        std::os::unix::fs::symlink("é.md", root.path().join("linked.md")).unwrap();
        exact(&parent, "linked.md").unwrap();
        assert!(regular(&parent, "linked.md").is_err());
        std::fs::hard_link(root.path().join("é.md"), root.path().join("hard.md")).unwrap();
        assert!(regular(&parent, "hard.md").is_err());
    }
    #[test]
    fn exact_names_parent_replacement_uses_actual_descriptor() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("parent")).unwrap();
        std::fs::write(root.path().join("parent/Before.md"), b"old").unwrap();
        let old = File::open(root.path().join("parent")).unwrap();
        exact(&old, "Before.md").unwrap();
        std::fs::rename(root.path().join("parent"), root.path().join("old-parent")).unwrap();
        std::fs::create_dir(root.path().join("parent")).unwrap();
        std::fs::write(root.path().join("parent/After.md"), b"new").unwrap();
        let current = File::open(root.path().join("parent")).unwrap();
        exact(&current, "After.md").unwrap();
        assert!(regular(&current, "Before.md").unwrap().is_none());
        assert!(regular(&old, "After.md").unwrap().is_none());
    }
    #[test]
    fn exact_names_sqlite_identity_does_not_open_or_close_database_descriptors() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("vault.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE retained(value); BEGIN IMMEDIATE; INSERT INTO retained VALUES(1);",
            )
            .unwrap();
        let parent = File::open(root.path()).unwrap();
        for _ in 0..10 {
            regular_identity(&parent, "vault.sqlite").unwrap().unwrap();
        }
        let competing = rusqlite::Connection::open(database).unwrap();
        competing.busy_timeout(Duration::ZERO).unwrap();
        assert!(competing.execute_batch("BEGIN IMMEDIATE").is_err());
        connection.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn exact_names_native_reply_rejects_unsupported_malformed_and_foreign_mount() {
        let mut volume = [0u32; 11];
        volume[0] = 44;
        volume[1] = 1;
        assert!(!canonical_leaf::native_name_supported(&volume));
        volume[6] = 1;
        assert!(canonical_leaf::native_name_supported(&volume));
        volume[0] = 40;
        assert!(!canonical_leaf::native_name_supported(&volume));
        let mut reply = [0u8; 40];
        fn put(reply: &mut [u8], at: usize, value: u32) {
            reply[at..at + 4].copy_from_slice(&value.to_ne_bytes());
        }
        put(&mut reply, 0, 40);
        put(&mut reply, 4, 0x8000_0003);
        put(&mut reply, 24, 12);
        put(&mut reply, 28, 2);
        put(&mut reply, 32, 42);
        reply[36] = b'a';
        assert_eq!(
            canonical_leaf::parse_name(&reply, 42),
            Some(b"a".as_slice())
        );
        assert_eq!(canonical_leaf::parse_name(&reply, 43), None);
        for (at, value) in [
            (0, 4096),
            (4, 1),
            (24, u32::MAX),
            (24, 0),
            (28, 0),
            (28, u32::MAX),
        ] {
            let mut bad = reply;
            put(&mut bad, at, value);
            assert_eq!(canonical_leaf::parse_name(&bad, 42), None);
        }
        let mut bad = reply;
        bad[37] = b'x';
        assert_eq!(canonical_leaf::parse_name(&bad, 42), None);
    }
}
