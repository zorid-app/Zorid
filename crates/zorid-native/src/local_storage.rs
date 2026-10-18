//! Trusted locations for local retained history and rebuildable data.
//! Resolution is shared by native shells and the standalone CLI; it never
//! creates directories, opens databases or claims cache migration is complete.
use sha2::{Digest, Sha256};
use std::{
    io,
    path::{Path, PathBuf},
};
use zorid_core::OperationId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalStoragePaths {
    pub recovery: PathBuf,
    pub cache: PathBuf,
}

impl LocalStoragePaths {
    /// Include physical location as well as authority identity: copied vaults
    /// keep separate local history, while canonical aliases reuse one bucket.
    pub fn resolve(
        root: &Path,
        local_store_id: &OperationId,
        data_root: &Path,
    ) -> io::Result<Self> {
        if !data_root.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "local data root must be absolute",
            ));
        }
        let canonical = std::fs::canonicalize(root)?;
        let resolved = resolve_local_destination(data_root)?;
        if resolved.starts_with(&canonical) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "local data root is inside vault",
            ));
        }
        let mut digest = Sha256::new();
        digest.update(local_store_id.as_str().as_bytes());
        digest.update([0]);
        digest.update(canonical.as_os_str().as_encoded_bytes());
        let key: String = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let bucket = resolve_local_destination(&resolved.join("vaults").join(key))?;
        if bucket.starts_with(&canonical) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "local data bucket is inside vault",
            ));
        }
        Ok(Self {
            recovery: bucket.join("recovery.sqlite"),
            cache: bucket.join("cache.sqlite"),
        })
    }

    pub fn app_data_root() -> io::Result<PathBuf> {
        let nonempty = |name| std::env::var_os(name).filter(|value| !value.is_empty());
        let root = if let Some(root) = nonempty("ZORID_LOCAL_DATA_DIR") {
            PathBuf::from(root)
        } else if cfg!(target_os = "windows") {
            PathBuf::from(nonempty("LOCALAPPDATA").ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "local app data unavailable")
            })?)
            .join("Zorid")
        } else if cfg!(target_os = "macos") {
            PathBuf::from(
                nonempty("HOME")
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home unavailable"))?,
            )
            .join("Library/Application Support/Zorid")
        } else if let Some(root) = nonempty("XDG_DATA_HOME") {
            PathBuf::from(root).join("zorid")
        } else {
            PathBuf::from(
                nonempty("HOME")
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home unavailable"))?,
            )
            .join(".local/share/zorid")
        };
        if !root.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "local data root must be absolute",
            ));
        }
        Ok(root)
    }
}

/// Resolve symlinks in existing ancestors without creating missing directories.
fn resolve_local_destination(path: &Path) -> io::Result<PathBuf> {
    let mut ancestor = path;
    let mut missing = Vec::new();
    let mut resolved = loop {
        match std::fs::canonicalize(ancestor) {
            Ok(path) => break path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = ancestor.file_name().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid local data root")
                })?;
                missing.push(name.to_owned());
                ancestor = ancestor.parent().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "invalid local data root")
                })?;
            }
            Err(error) => return Err(error),
        }
    };
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}
