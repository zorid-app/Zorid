//! Explicitly typed first enrollment of externally created files and folders.
//! Caller holds the vault lock and enrolls missing parents before entering here.
use super::*;
use zorid_store::FamilyCreateMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalFileMode {
    Auto,
    Text,
    Binary,
}

/// Classify once at first enrollment. This never changes source bytes and is not
/// consulted again for an existing entry's immutable text/binary identity.
pub fn select_external_file_mode(
    path: &VaultPath,
    bytes: &[u8],
    policy: ExternalFileMode,
) -> Result<FamilyCreateMode> {
    select_external_file_mode_from_facts(
        path,
        std::str::from_utf8(bytes).is_ok(),
        bytes.contains(&0),
        policy,
    )
}

/// Content classification facts may come from an inline body or a completed
/// strict streaming validator. They grant no physical or import authority.
pub(super) fn select_external_file_mode_from_facts(
    path: &VaultPath,
    valid_utf8: bool,
    has_nul: bool,
    policy: ExternalFileMode,
) -> Result<FamilyCreateMode> {
    if policy == ExternalFileMode::Binary {
        return Ok(FamilyCreateMode::Binary);
    }
    if policy == ExternalFileMode::Text {
        return if valid_utf8 {
            Ok(FamilyCreateMode::Text)
        } else {
            Err(Error::Unsupported(
                "explicit text import requires valid UTF-8",
            ))
        };
    }
    let name = path.as_str().rsplit('/').next().unwrap_or_default();
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    let binary_extension = extension.as_deref().is_some_and(|extension| {
        matches!(
            extension,
            "bin"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "avif"
                | "bmp"
                | "tif"
                | "tiff"
                | "ico"
                | "heic"
                | "heif"
                | "svg"
                | "mp3"
                | "wav"
                | "flac"
                | "m4a"
                | "aac"
                | "ogg"
                | "opus"
                | "aif"
                | "aiff"
                | "mp4"
                | "mov"
                | "mkv"
                | "webm"
                | "avi"
                | "m4v"
                | "ogv"
                | "mpeg"
                | "mpg"
                | "pdf"
                | "zip"
                | "7z"
                | "rar"
                | "gz"
                | "bz2"
                | "xz"
                | "zst"
                | "tar"
                | "tgz"
                | "docx"
                | "xlsx"
                | "pptx"
        )
    });
    Ok(if binary_extension || !valid_utf8 || has_nul {
        FamilyCreateMode::Binary
    } else {
        FamilyCreateMode::Text
    })
}

impl NativeVault {
    pub(super) fn observe_new_family_file(
        &mut self,
        path: &VaultPath,
        parent: &File,
        disk: &fs::Snapshot,
        mode: FamilyCreateMode,
    ) -> Result<CommitResult> {
        self.paths.verify_parent(path, parent)?;
        let streamed = content_stream::file_snapshot(parent, path.file_name())?
            .ok_or(Error::Busy("external file disappeared"))?;
        if streamed.identity != disk.identity
            || streamed.length != disk.bytes.len() as u64
            || streamed.digest != zorid_store::Sha256Digest::of(&disk.bytes).0
        {
            return Err(Error::Busy("external file differs from supplied snapshot"));
        }
        self.observe_new_family_stream(
            path,
            parent,
            &streamed,
            mode,
            &OperationId::new("native_external_create")?,
        )
    }

    pub(super) fn observe_new_family_stream(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &crate::fs_stream::StreamSnapshot,
        mode: FamilyCreateMode,
        origin: &OperationId,
    ) -> Result<CommitResult> {
        self.observe_new_family_stream_with_scan(path, parent, expected, mode, origin, None)
    }

    pub(super) fn observe_new_family_stream_with_scan(
        &mut self,
        path: &VaultPath,
        parent: &File,
        expected: &crate::fs_stream::StreamSnapshot,
        mode: FamilyCreateMode,
        origin: &OperationId,
        scan: Option<&external_namespace::EnrolledScan<'_>>,
    ) -> Result<CommitResult> {
        if let Some(scan) = scan { scan.check(self)?; }
        self.paths.verify_parent(path, parent)?;
        self.namespace_clear(path)?;
        if self.store.physical_owner_at(path)?.is_some()
            || self.store.read_path_metadata(path)?.is_some()
            || self
                .store
                .physical_owner_by_inode(&expected.identity)?
                .is_some()
        {
            return Err(Error::Busy("new external file path already has an owner"));
        }
        let physical = PhysicalIdentity {
            inode: expected.identity.clone(),
            parent_inode: expected.parent_identity.clone(),
        };
        let proof = ObservationPhysical {
            physical: physical.clone(),
            expected_binding: None,
        };
        let client = content_stream::core_client()?;
        let matched = self.store.find_matching_external_observation(
            &client,
            path,
            None,
            Some(&proof),
            expected.length,
            &zorid_store::Sha256Digest(expected.digest),
        )?;
        let reused = matched.is_some();
        let observation = match matched {
            Some(observation) => {
                self.verify_observed_content(path, parent, &physical, &observation.content)?;
                observation
            }
            None => {
                let content = self.capture_observed_file_with_scan(
                    path,
                    parent,
                    path.file_name(),
                    origin,
                    None,
                    Some(&proof),
                    expected,
                    mode == FamilyCreateMode::Text,
                    scan,
                )?;
                self.verify_observed_content(path, parent, &physical, &content)?;
                self.retain_observed_content(path, None, &content, Some(&proof))?
            }
        };
        let unsupported_text =
            mode == FamilyCreateMode::Text && observation.content.inline_bytes().is_none();
        // Fresh rejected Text captures carry no accepted Create intent. They
        // remain inert, so a later explicit Binary enrollment is still allowed.
        if unsupported_text && !reused {
            return Err(Error::Unsupported(
                "external text exceeds supported inline limit",
            ));
        }
        // On a retry, validate the original accepted mode before the generic
        // Text limit. Store rejects a fresh unsupported Text source before
        // persisting an intent, and checks a saved Binary intent's mode first.
        self.store.prepare_family_external_create_content(
            &client,
            &observation.observation_id,
            EntryKind::File,
            Some(mode),
        )?;
        if unsupported_text {
            return Err(Error::Unsupported(
                "external text exceeds supported inline limit",
            ));
        }
        self.point("external_create_prepared");
        self.verify_observed_content(path, parent, &physical, &observation.content)?;
        self.paths.verify_parent(path, parent)?;
        Ok(self
            .store
            .import_family_external_create_content(&client, &observation.observation_id)?)
    }
    pub(super) fn observe_new_family_directory(
        &mut self,
        path: &VaultPath,
        parent: &File,
        physical: &PhysicalIdentity,
    ) -> Result<CommitResult> {
        self.paths.verify_parent(path, parent)?;
        self.namespace_clear(path)?;
        if self.store.physical_owner_at(path)?.is_some()
            || self.store.read_path_metadata(path)?.is_some()
            || self
                .store
                .physical_owner_by_inode(&physical.inode)?
                .is_some()
        {
            return Err(Error::Busy(
                "new external directory path already has an owner",
            ));
        }
        let name = path
            .as_str()
            .rsplit('/')
            .next()
            .ok_or(Error::Busy("directory name missing"))?;
        self.paths.verify_parent(path, parent)?;
        let directory = fs::optional_directory(parent, name)?
            .ok_or(Error::Busy("external directory disappeared"))?;
        if fs::identity(&directory)? != physical.inode
            || fs::identity(parent)? != physical.parent_inode
        {
            return Err(Error::Busy("external directory identity changed"));
        }
        let observation = self.retain_observed_content(
            path,
            None,
            &StoredContent::InlineBytes(Vec::new()),
            Some(&ObservationPhysical {
                physical: physical.clone(),
                expected_binding: None,
            }),
        )?;
        let client = content_stream::core_client()?;
        self.store.prepare_family_external_create_content(
            &client,
            &observation.observation_id,
            EntryKind::Folder,
            None,
        )?;
        self.point("external_create_prepared");
        self.paths.verify_parent(path, parent)?;
        let current = fs::optional_directory(parent, name)?
            .ok_or(Error::Busy("external directory disappeared before import"))?;
        if fs::identity(&current)? != physical.inode {
            return Err(Error::Busy("external directory replaced before import"));
        }
        self.paths.verify_parent(path, parent)?;
        Ok(self
            .store
            .import_family_external_create_content(&client, &observation.observation_id)?)
    }
}
