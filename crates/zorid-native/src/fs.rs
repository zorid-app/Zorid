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
/// Reject a spelling which aliases another entry on a case/normalization folding
/// filesystem. NOFOLLOW separately rejects symlinks, including dangling ones.
pub(crate) fn exact(parent: &File, name: &str) -> Result<()> {
    let mut found = false;
    for entry in Dir::read_from(parent)? {
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
