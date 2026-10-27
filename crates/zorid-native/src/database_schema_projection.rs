//! Explicit internal readable-schema publication. VaultPath remains closed to
//! `.zorid`; descriptor-relative no-follow access is confined to this service.
use super::*;
use rustix::fs::{self as sys, Mode, OFlags};
use std::fs::File;
use std::os::unix::fs::MetadataExt;

fn leaf(path: &str) -> Result<&str> {
    let name = path
        .strip_prefix(".zorid/types/")
        .ok_or_else(|| invalid("Invalid collection definition projection path"))?;
    if name.is_empty()
        || !name.ends_with(".yaml")
        || name.contains(['/', '\\', '\0'])
        || name.chars().any(char::is_control)
        || matches!(name, "." | "..")
    {
        return Err(invalid("Invalid collection definition filename"));
    }
    Ok(name)
}
fn open_types(paths: &Paths) -> Result<File> {
    fs::exact(&paths.private, "types")?;
    match sys::mkdirat(&paths.private, "types", Mode::from_raw_mode(0o700)) {
        Ok(()) => paths.private.sync_all()?,
        Err(rustix::io::Errno::EXIST) => {}
        Err(error) => return Err(error.into()),
    }
    let dir: File = sys::openat(
        &paths.private,
        "types",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    )?
    .into();
    let metadata = dir.metadata()?;
    if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
        return Err(Error::UnsafePath(
            "managed types directory must be private and owned by current user".into(),
        ));
    }
    Ok(dir)
}
fn verify_types(paths: &Paths, expected: &File) -> Result<()> {
    paths.verify()?;
    let current = open_types(paths)?;
    if fs::identity(&current)? != fs::identity(expected)? {
        return Err(Error::UnsafePath(
            "managed types directory identity changed".into(),
        ));
    }
    Ok(())
}
fn agrees(snapshot: &fs::Snapshot, source: &str) -> bool {
    snapshot.bytes == source.as_bytes()
}
fn remove_proven(dir: &File, name: &str, source: &str) -> Result<()> {
    if let Some(snapshot) = fs::snapshot(dir, name, MAX_DATABASE_RESPONSE_BYTES)? {
        if !agrees(&snapshot, source) {
            return Err(Error::Busy(
                "Collection definition changed outside Zorid; its source was preserved",
            ));
        }
        fs::unlink_regular_identity(dir, name, &snapshot.identity)?;
    }
    Ok(())
}

impl NativeVault {
    pub(super) fn database_publish_schema_locked(
        &mut self,
        projection: &DatabaseSchemaProjection,
    ) -> Result<()> {
        let dir = open_types(&self.paths)?;
        let name = leaf(&projection.path)?;
        let previous_name = projection.previous_path.as_deref().map(leaf).transpose()?;
        let previous_source = projection.previous_source.as_deref();
        let trash = format!(".trash-{}.yaml", projection.collection_id);
        let stage = format!(
            ".projection-{}-{}.yaml",
            projection.collection_id, projection.revision
        );
        let retained = format!(
            ".previous-{}-{}.yaml",
            projection.collection_id, projection.revision
        );
        // Every deterministic private artifact remains associated with this
        // durable queue item until publication and acknowledgement complete.
        verify_types(&self.paths, &dir)?;
        if projection.deleted {
            if let Some(old_name) = previous_name {
                if let Some(existing) = fs::snapshot(&dir, old_name, MAX_DATABASE_RESPONSE_BYTES)? {
                    let expected = previous_source.ok_or_else(|| {
                        invalid("Deleted collection definition has no publication baseline")
                    })?;
                    if !agrees(&existing, expected) {
                        return Err(Error::Busy(
                            "Collection definition changed outside Zorid; deletion is pending",
                        ));
                    }
                    if let Some(saved) = fs::snapshot(&dir, &trash, MAX_DATABASE_RESPONSE_BYTES)? {
                        if !agrees(&saved, expected) {
                            return Err(Error::Busy(
                                "Collection definition Trash already contains different source",
                            ));
                        }
                        remove_proven(&dir, old_name, expected)?;
                    } else {
                        fs::rename_new(&dir, old_name, &dir, &trash)?;
                        let saved = fs::snapshot(&dir, &trash, MAX_DATABASE_RESPONSE_BYTES)?
                            .ok_or(Error::Busy("Trashed collection definition disappeared"))?;
                        if !agrees(&saved, expected) {
                            return Err(Error::Busy("Collection definition changed during deletion; source retained in Trash"));
                        }
                    }
                }
            }
            verify_types(&self.paths, &dir)?;
            self.store
                .database_schema_projection_ack(&projection.collection_id, &projection.revision)?;
            return Ok(());
        }
        // Target already equal is an exact retry after a crash before ACK.
        let current_target = match fs::snapshot(&dir, name, MAX_DATABASE_RESPONSE_BYTES) {
            Ok(value) => value,
            Err(Error::UnsafePath(_))
                if previous_name.is_some_and(|previous| {
                    previous != name && previous.to_lowercase() == name.to_lowercase()
                }) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        if current_target
            .as_ref()
            .is_some_and(|snapshot| agrees(snapshot, &projection.source))
        {
            if let Some(previous) = previous_name.filter(|previous| *previous != name) {
                if let Some(expected) = previous_source {
                    remove_proven(&dir, previous, expected)?;
                }
            }
            verify_types(&self.paths, &dir)?;
            self.store
                .database_schema_projection_ack(&projection.collection_id, &projection.revision)?;
            remove_proven(&dir, &stage, &projection.source)?;
            if let Some(expected) = previous_source {
                remove_proven(&dir, &retained, expected)?;
            }
            return Ok(());
        }
        if let Some(target) = current_target.as_ref() {
            if previous_name != Some(name)
                || previous_source.is_none_or(|expected| !agrees(target, expected))
            {
                return Err(Error::Busy("Collection definition filename is occupied or externally edited; source preserved"));
            }
        }
        if let Some(staged) = fs::snapshot(&dir, &stage, MAX_DATABASE_RESPONSE_BYTES)? {
            if !agrees(&staged, &projection.source) {
                return Err(Error::Busy("Collection definition staging source changed"));
            }
        } else {
            fs::stage(&dir, &stage, projection.source.as_bytes())?;
        }
        // Displace only the proven baseline into a retained private location.
        // Recheck after moving; a concurrent external edit is kept and restored
        // before any target is published. No replace operation touches user data.
        if let Some(previous) = previous_name {
            if let Some(existing) = fs::snapshot(&dir, previous, MAX_DATABASE_RESPONSE_BYTES)? {
                let expected = previous_source
                    .ok_or_else(|| invalid("Collection definition has no publication baseline"))?;
                if !agrees(&existing, expected) {
                    return Err(Error::Busy(
                        "Collection definition changed outside Zorid; source preserved",
                    ));
                }
                if fs::snapshot(&dir, &retained, MAX_DATABASE_RESPONSE_BYTES)?.is_some() {
                    return Err(Error::Busy("Collection definition has both old and retained sources; recovery is pending"));
                }
                fs::rename_new(&dir, previous, &dir, &retained)?;
                let displaced = fs::snapshot(&dir, &retained, MAX_DATABASE_RESPONSE_BYTES)?
                    .ok_or(Error::Busy("Retained definition disappeared"))?;
                if !agrees(&displaced, expected) || displaced.identity != existing.identity {
                    let _ = fs::rename_new(&dir, &retained, &dir, previous);
                    return Err(Error::Busy(
                        "Collection definition changed during publication; source retained",
                    ));
                }
            }
        }
        verify_types(&self.paths, &dir)?;
        fs::rename_new(&dir, &stage, &dir, name)?;
        let published = fs::snapshot(&dir, name, MAX_DATABASE_RESPONSE_BYTES)?
            .ok_or(Error::Busy("Published definition disappeared"))?;
        if !agrees(&published, &projection.source) {
            return Err(Error::Busy(
                "Published collection definition changed before acknowledgement",
            ));
        }
        verify_types(&self.paths, &dir)?;
        self.point("database_schema_projected");
        self.store
            .database_schema_projection_ack(&projection.collection_id, &projection.revision)?;
        if let Some(expected) = previous_source {
            remove_proven(&dir, &retained, expected)?;
        }
        // A restored schema can leave its old recovery copy behind; only retire
        // exactly equal generated source, never unknown external content.
        if let Some(snapshot) = fs::snapshot(&dir, &trash, MAX_DATABASE_RESPONSE_BYTES)? {
            if agrees(&snapshot, &projection.source) {
                fs::unlink_regular_identity(&dir, &trash, &snapshot.identity)?;
            }
        }
        Ok(())
    }
}
