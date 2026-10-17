//! Synthetic fixture consumer ownership. A kernel lock lives as long as the
//! guard; lock files are never unlinked, so release cannot create split inodes.
use crate::{Error, OperationId};
use serde::{Deserialize, Serialize};
use std::{fmt, fs::File};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientLeaseRef {
    pub local_store_id: OperationId,
    pub client_id: OperationId,
    pub token: OperationId,
}
#[derive(Debug)]
pub enum ClientAdmissionError {
    Native(Error),
    InvalidClient,
    InUse,
}
impl fmt::Display for ClientAdmissionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Native(_) => "Consumer ownership could not be verified",
            Self::InvalidClient => "Consumer identity must be a canonical UUID",
            Self::InUse => "Consumer already has an active owner",
        })
    }
}
impl std::error::Error for ClientAdmissionError {}
impl From<Error> for ClientAdmissionError {
    fn from(value: Error) -> Self {
        Self::Native(value)
    }
}
pub struct ClientLease {
    reference: ClientLeaseRef,
    file: File,
    name: String,
}
impl ClientLease {
    pub fn reference(&self) -> &ClientLeaseRef {
        &self.reference
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
fn checked(file: &File) -> crate::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(Error::UnsafePath("invalid consumer lock".into()));
    }
    Ok(())
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
pub(crate) fn claim(
    paths: &crate::fs::Paths,
    authority: OperationId,
    client: &OperationId,
) -> Result<ClientLease, ClientAdmissionError> {
    use rustix::fs::{openat, Mode, OFlags};
    if uuid::Uuid::parse_str(client.as_str())
        .ok()
        .is_none_or(|value| value.hyphenated().to_string() != client.as_str())
    {
        return Err(ClientAdmissionError::InvalidClient);
    }
    paths.verify()?;
    let name = format!("client-{}.lock", client.as_str());
    crate::fs::exact(&paths.private, &name)?;
    let file: File = openat(
        &paths.private,
        name.as_str(),
        OFlags::RDWR | OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::from_raw_mode(0o600),
    )
    .map_err(Error::from)?
    .into();
    checked(&file)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Err(ClientAdmissionError::InUse),
        Err(std::fs::TryLockError::Error(error)) => return Err(Error::from(error).into()),
    }
    // Persist the permanent lock directory entry before returning ownership.
    paths.private.sync_all().map_err(Error::from)?;
    let lease = ClientLease {
        reference: ClientLeaseRef {
            local_store_id: authority.clone(),
            client_id: client.clone(),
            token: OperationId::new(uuid::Uuid::new_v4().to_string()).map_err(Error::from)?,
        },
        file,
        name,
    };
    verify(paths, &authority, &lease)?;
    Ok(lease)
}
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios", target_os = "android"))]
pub(crate) fn verify(
    paths: &crate::fs::Paths,
    authority: &OperationId,
    lease: &ClientLease,
) -> Result<(), ClientAdmissionError> {
    paths.verify()?;
    if authority != &lease.reference.local_store_id {
        return Err(Error::UnsafePath("consumer authority changed".into()).into());
    }
    checked(&lease.file)?;
    let named = crate::fs::regular(&paths.private, &lease.name)?
        .ok_or_else(|| Error::UnsafePath("consumer lock disappeared".into()))?;
    checked(&named)?;
    if crate::fs::identity(&named)? != crate::fs::identity(&lease.file)? {
        return Err(Error::UnsafePath("consumer lock identity changed".into()).into());
    }
    Ok(())
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use crate::NativeVault;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    fn client() -> OperationId {
        OperationId::new("10000000-0000-4000-8000-000000000001").unwrap()
    }
    #[test]
    fn owner_is_exclusive_but_independent_clients_and_vault_access_remain_available() {
        let root = tempfile::tempdir().unwrap();
        let first = NativeVault::open(root.path()).unwrap();
        let second = NativeVault::open_existing(root.path()).unwrap();
        let guard = first.claim_client(&client()).unwrap();
        assert!(matches!(
            second.claim_client(&client()),
            Err(ClientAdmissionError::InUse)
        ));
        let other = OperationId::new("10000000-0000-4000-8000-000000000002").unwrap();
        let distinct = second.claim_client(&other).unwrap();
        assert_ne!(guard.reference().client_id, distinct.reference().client_id);
        assert!(second.list().unwrap().is_empty());
        let lock = root
            .path()
            .join(format!(".zorid/client-{}.lock", client().as_str()));
        let inode = std::fs::metadata(&lock).unwrap().ino();
        let old_token = guard.reference().token.clone();
        drop(guard);
        let replacement = second.claim_client(&client()).unwrap();
        assert_ne!(replacement.reference().token, old_token);
        assert_eq!(std::fs::metadata(lock).unwrap().ino(), inode);
        second.verify_client_lease(&replacement).unwrap();
    }
    #[test]
    fn changed_lock_inode_and_foreign_authority_invalidate_the_guard() {
        let root = tempfile::tempdir().unwrap();
        let vault = NativeVault::open(root.path()).unwrap();
        let guard = vault.claim_client(&client()).unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let other = NativeVault::open(other_root.path()).unwrap();
        assert!(other.verify_client_lease(&guard).is_err());
        let name = root
            .path()
            .join(format!(".zorid/client-{}.lock", client().as_str()));
        std::fs::rename(&name, root.path().join(".zorid/retained-lock")).unwrap();
        std::fs::write(&name, b"").unwrap();
        std::fs::set_permissions(&name, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(vault.verify_client_lease(&guard).is_err());
    }
    #[test]
    fn unsafe_lock_files_and_noncanonical_client_names_are_rejected() {
        for mode in ["symlink", "hardlink", "permissions"] {
            let root = tempfile::tempdir().unwrap();
            let vault = NativeVault::open(root.path()).unwrap();
            let target = root.path().join("target");
            std::fs::write(&target, b"").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
            let lock = root
                .path()
                .join(format!(".zorid/client-{}.lock", client().as_str()));
            match mode {
                "symlink" => symlink(&target, &lock).unwrap(),
                "hardlink" => std::fs::hard_link(&target, &lock).unwrap(),
                _ => {
                    std::fs::write(&lock, b"").unwrap();
                    std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o644))
                        .unwrap();
                }
            }
            assert!(vault.claim_client(&client()).is_err(), "{mode}");
        }
        let root = tempfile::tempdir().unwrap();
        let vault = NativeVault::open(root.path()).unwrap();
        assert!(matches!(
            vault.claim_client(&OperationId::new("not-a-uuid").unwrap()),
            Err(ClientAdmissionError::InvalidClient)
        ));
    }
}
