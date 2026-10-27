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

// Every allowed source comes from the last ACK or a durable pre-publication
// candidate. Similar labels or an equal filename never grant ownership.
fn known_sources(projection: &DatabaseSchemaProjection) -> Result<BTreeMap<String, Vec<String>>> {
    let mut known: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for candidate in &projection.candidates {
        known
            .entry(leaf(&candidate.path)?.into())
            .or_default()
            .push(candidate.source.clone());
    }
    match (&projection.previous_path, &projection.previous_source) {
        (Some(path), Some(source)) => known
            .entry(leaf(path)?.into())
            .or_default()
            .push(source.clone()),
        (None, None) => {}
        _ => {
            return Err(invalid(
                "Collection definition has an incomplete publication baseline",
            ))
        }
    }
    known
        .entry(leaf(&projection.path)?.into())
        .or_default()
        .push(projection.source.clone());
    Ok(known)
}

fn source_is_known(snapshot: &fs::Snapshot, sources: &[String]) -> bool {
    sources.iter().any(|source| agrees(snapshot, source))
}

/// A case/normalization alias of an exact known leaf is not another file to
/// remove. Only descriptor metadata and a proven exact known inode can authorize
/// this classification; no alias is opened or followed.
fn snapshot_known(
    dir: &File,
    name: &str,
    known: &BTreeMap<String, Vec<String>>,
) -> Result<Option<fs::Snapshot>> {
    match fs::snapshot(dir, name, MAX_DATABASE_RESPONSE_BYTES) {
        Ok(value) => Ok(value),
        Err(error @ Error::UnsafePath(_)) => {
            let stat = match sys::statat(dir, name, sys::AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat) => stat,
                Err(_) => return Err(error),
            };
            if sys::FileType::from_raw_mode(stat.st_mode) != sys::FileType::RegularFile
                || stat.st_nlink != 1
            {
                return Err(error);
            }
            let identity = format!("{}:{}", stat.st_dev, stat.st_ino);
            for (exact_name, sources) in known {
                if exact_name == name {
                    continue;
                }
                if let Ok(Some(snapshot)) =
                    fs::snapshot(dir, exact_name, MAX_DATABASE_RESPONSE_BYTES)
                {
                    if snapshot.identity == identity && source_is_known(&snapshot, sources) {
                        return Ok(None);
                    }
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Keep each exact schema version in recoverable private Trash. Repeated delete
/// and restore never overwrite an older recovery copy.
fn retain_known(dir: &File, name: &str, snapshot: &fs::Snapshot, collection: &str) -> Result<()> {
    let key = operation("schema-trash", collection, "1", &snapshot.bytes)?;
    let trash = format!(".trash-{}.yaml", key.as_str());
    if let Some(previous) = fs::snapshot(dir, &trash, MAX_DATABASE_RESPONSE_BYTES)? {
        if previous.bytes != snapshot.bytes {
            return Err(Error::Busy(
                "Collection definition recovery copy changed; source preserved",
            ));
        }
        let source = std::str::from_utf8(&snapshot.bytes)
            .map_err(|_| invalid("Generated collection definition is not UTF-8"))?;
        remove_proven(dir, name, source)?;
        return Ok(());
    }
    fs::rename_new(dir, name, dir, &trash)?;
    let displaced = fs::snapshot(dir, &trash, MAX_DATABASE_RESPONSE_BYTES)?
        .ok_or(Error::Busy("Retained collection definition disappeared"))?;
    if displaced.identity != snapshot.identity || displaced.bytes != snapshot.bytes {
        let _ = fs::rename_new(dir, &trash, dir, name);
        return Err(Error::Busy(
            "Collection definition changed during retirement; source retained",
        ));
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
        let known = known_sources(projection)?;
        verify_types(&self.paths, &dir)?;
        // Check every known target before displacing any of them. Unknown edits
        // and unrelated occupying files remain exactly where they were.
        for (candidate_name, sources) in &known {
            if let Some(snapshot) = snapshot_known(&dir, candidate_name, &known)? {
                if !source_is_known(&snapshot, sources) {
                    return Err(Error::Busy(
                        "Collection definition changed outside Zorid; source preserved",
                    ));
                }
            }
        }
        // Retire superseded targets, including a target published just before a
        // crash without its ACK. The candidate journal survives later renames.
        for candidate_name in known.keys() {
            if !projection.deleted && candidate_name == name {
                continue;
            }
            if let Some(snapshot) = snapshot_known(&dir, candidate_name, &known)? {
                let sources = &known[candidate_name];
                if !source_is_known(&snapshot, sources) {
                    return Err(Error::Busy(
                        "Collection definition changed before retirement; source preserved",
                    ));
                }
                retain_known(&dir, candidate_name, &snapshot, &projection.collection_id)?;
            }
        }
        if !projection.deleted {
            let current = snapshot_known(&dir, name, &known)?;
            if current
                .as_ref()
                .is_none_or(|snapshot| !agrees(snapshot, &projection.source))
            {
                let key = operation(
                    "schema",
                    &projection.collection_id,
                    &projection.revision,
                    &[],
                )?;
                let stage = format!(".projection-{}.yaml", key.as_str());
                if let Some(staged) = fs::snapshot(&dir, &stage, MAX_DATABASE_RESPONSE_BYTES)? {
                    if !agrees(&staged, &projection.source) {
                        return Err(Error::Busy("Collection definition staging source changed"));
                    }
                } else {
                    fs::stage(&dir, &stage, projection.source.as_bytes())?;
                }
                if let Some(snapshot) = current {
                    if !source_is_known(&snapshot, &known[name]) {
                        return Err(Error::Busy(
                            "Collection definition changed before replacement; source preserved",
                        ));
                    }
                    retain_known(&dir, name, &snapshot, &projection.collection_id)?;
                }
                verify_types(&self.paths, &dir)?;
                fs::rename_new(&dir, &stage, &dir, name)?;
            }
            let published = fs::snapshot(&dir, name, MAX_DATABASE_RESPONSE_BYTES)?
                .ok_or(Error::Busy("Published collection definition disappeared"))?;
            if !agrees(&published, &projection.source) {
                return Err(Error::Busy(
                    "Published collection definition changed before acknowledgement",
                ));
            }
        }
        // Deterministic staging artifacts are also associated with candidates.
        // Never clear the journal while an unfamiliar artifact needs repair.
        let all_sources: Vec<_> = known.values().flatten().cloned().collect();
        for candidate in &projection.candidates {
            let key = operation(
                "schema",
                &projection.collection_id,
                &candidate.revision,
                &[],
            )?;
            let stage = format!(".projection-{}.yaml", key.as_str());
            remove_proven(&dir, &stage, &candidate.source)?;
            let previous = format!(".previous-{}.yaml", key.as_str());
            if let Some(snapshot) = fs::snapshot(&dir, &previous, MAX_DATABASE_RESPONSE_BYTES)? {
                if !source_is_known(&snapshot, &all_sources) {
                    return Err(Error::Busy(
                        "Retained collection definition has unknown source; preserved for repair",
                    ));
                }
                retain_known(&dir, &previous, &snapshot, &projection.collection_id)?;
            }
        }
        verify_types(&self.paths, &dir)?;
        self.point("database_schema_projected");
        self.store
            .database_schema_projection_ack(&projection.collection_id, &projection.revision)?;
        Ok(())
    }
}
