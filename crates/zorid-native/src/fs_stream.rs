//! Bounded physical capture and private-stage writing. These helpers do not
//! grant logical authority: callers must verify vault/parent reachability and
//! compare the returned evidence with their durable observation immediately
//! before importing. A retained descriptor alone cannot prove its current path.
use crate::{fs, Error, Result};
use rustix::fs::{Mode, OFlags};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, Write},
    os::unix::fs::MetadataExt,
};

pub(super) const STREAM_CHUNK_BYTES: usize = 128 * 1024;
pub(super) const MAX_STREAM_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StreamSnapshot {
    pub identity: String,
    pub parent_identity: String,
    pub length: u64,
    pub digest: [u8; 32],
    pub valid_utf8: bool,
    pub has_nul: bool,
}

fn leaf(name: &str) -> Result<()> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        return Err(Error::UnsafePath(
            "stream capture requires an exact leaf name".into(),
        ));
    }
    Ok(())
}
fn parent_identity(parent: &File) -> Result<String> {
    let metadata = parent.metadata()?;
    if !metadata.is_dir() || metadata.nlink() == 0 {
        return Err(Error::UnsafePath(
            "stream parent is not a live directory".into(),
        ));
    }
    Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
}
type Stamp = (u64, u64, u64, u64, i64, i64, i64, i64);
fn stamp(metadata: &std::fs::Metadata) -> Result<Stamp> {
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(Error::UnsafePath(
            "stream source is not a single-link regular file".into(),
        ));
    }
    Ok((
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.nlink(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    ))
}
fn verify_path(
    parent: &File,
    name: &str,
    expected_parent: &str,
    opened: &File,
    expected: Stamp,
) -> Result<()> {
    if parent_identity(parent)? != expected_parent || stamp(&opened.metadata()?)? != expected {
        return Err(Error::Busy("stream source or parent changed"));
    }
    let current = fs::regular(parent, name)?.ok_or(Error::Busy("stream source disappeared"))?;
    if stamp(&current.metadata()?)? != expected
        || fs::identity(&current)? != fs::identity(opened)?
        || stamp(&opened.metadata()?)? != expected
        || parent_identity(parent)? != expected_parent
    {
        return Err(Error::Busy("stream source pathname or metadata changed"));
    }
    Ok(())
}

fn read_filled(reader: &mut impl Read, buffer: &mut [u8]) -> Result<usize> {
    let mut count = 0;
    while count < buffer.len() {
        match reader.read(&mut buffer[count..]) {
            Ok(0) => break,
            Ok(read) => count += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(count)
}

/// Strict UTF-8 validation without decoding or changing the bytes. Only an
/// incomplete final scalar (at most three bytes) is carried between chunks.
#[derive(Default)]
struct Utf8 {
    invalid: bool,
    carry: [u8; 4],
    pending: usize,
}
impl Utf8 {
    fn update(&mut self, mut bytes: &[u8]) {
        if self.invalid {
            return;
        }
        if self.pending != 0 {
            let width = match self.carry[0] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => {
                    self.invalid = true;
                    return;
                }
            };
            let count = (width - self.pending).min(bytes.len());
            self.carry[self.pending..self.pending + count].copy_from_slice(&bytes[..count]);
            self.pending += count;
            bytes = &bytes[count..];
            if self.pending < width {
                return;
            }
            if std::str::from_utf8(&self.carry[..width]).is_err() {
                self.invalid = true;
                return;
            }
            self.pending = 0;
        }
        if let Err(error) = std::str::from_utf8(bytes) {
            if error.error_len().is_some() {
                self.invalid = true;
            } else {
                let tail = &bytes[error.valid_up_to()..];
                self.carry[..tail.len()].copy_from_slice(tail);
                self.pending = tail.len();
            }
        }
    }
    fn valid(&self) -> bool {
        !self.invalid && self.pending == 0
    }
}

/// Stream one exact, single-link source file. Callback chunks never exceed
/// 128 KiB. A callback may write a private stage; errors retain its partial work
/// and no completed snapshot is returned. The 64 MiB cap cannot be raised by a
/// caller. Soft scheduling limits are the caller's responsibility.
pub(super) fn stream_snapshot(
    parent: &File,
    name: &str,
    limit: u64,
    mut callback: impl FnMut(&[u8]) -> Result<()>,
) -> Result<Option<StreamSnapshot>> {
    leaf(name)?;
    let original_parent = parent_identity(parent)?;
    let Some(mut file) = fs::regular(parent, name)? else {
        return Ok(None);
    };
    let before = stamp(&file.metadata()?)?;
    let limit = limit.min(MAX_STREAM_BYTES);
    if before.2 > limit {
        return Err(Error::Unsupported("stream source exceeds configured limit"));
    }
    let identity = fs::identity(&file)?;
    let mut buffer = [0u8; STREAM_CHUNK_BYTES];
    let mut length = 0u64;
    let mut digest = Sha256::new();
    let mut utf8 = Utf8::default();
    let mut has_nul = false;
    loop {
        let count = read_filled(&mut file, &mut buffer)?;
        if count == 0 {
            break;
        }
        length = length
            .checked_add(count as u64)
            .ok_or(Error::Unsupported("stream source length overflow"))?;
        if length > limit {
            return Err(Error::Unsupported("stream source exceeds configured limit"));
        }
        if length > before.2 {
            return Err(Error::Busy("stream source grew while reading"));
        }
        let chunk = &buffer[..count];
        callback(chunk)?;
        digest.update(chunk);
        utf8.update(chunk);
        has_nul |= chunk.contains(&0);
    }
    if length != before.2 {
        return Err(Error::Busy("stream source shortened while reading"));
    }
    verify_path(parent, name, &original_parent, &file, before)?;
    Ok(Some(StreamSnapshot {
        identity,
        parent_identity: original_parent,
        length,
        digest: digest.finalize().into(),
        valid_utf8: utf8.valid(),
        has_nul,
    }))
}

/// Write a fresh owner-only private stage from offset-addressed chunks. The
/// reader must return at most `max` bytes and an empty Vec only at EOF. A final
/// one-byte request at expected_length proves exact EOF. Every failure retains
/// the exclusive-created file for recovery; callers must not treat it as done.
/// Read-back verification checks the actual staged bytes, including mutations
/// made by the callback, before file and directory durability are acknowledged.
pub(super) fn stage_from_source(
    directory: &File,
    name: &str,
    expected_length: u64,
    expected_digest: [u8; 32],
    mut reader: impl FnMut(u64, usize) -> Result<Vec<u8>>,
) -> Result<String> {
    leaf(name)?;
    if expected_length > MAX_STREAM_BYTES {
        return Err(Error::Unsupported("private stream stage exceeds 64 MiB"));
    }
    let original_parent = parent_identity(directory)?;
    fs::exact(directory, name)?;
    let mut file: File = rustix::fs::openat(
        directory,
        name,
        OFlags::RDWR
            | OFlags::CREATE
            | OFlags::EXCL
            | OFlags::NOFOLLOW
            | OFlags::CLOEXEC
            | OFlags::NONBLOCK,
        Mode::from_raw_mode(0o600),
    )?
    .into();
    let identity = fs::identity(&file)?;
    if file.metadata()?.mode() & 0o077 != 0 {
        return Err(Error::UnsafePath(
            "private stream stage is not owner-only".into(),
        ));
    }
    let mut offset = 0u64;
    let mut digest = Sha256::new();
    while offset < expected_length {
        let max = usize::try_from((expected_length - offset).min(STREAM_CHUNK_BYTES as u64))
            .map_err(|_| Error::Unsupported("private stream stage chunk overflow"))?;
        let chunk = reader(offset, max)?;
        if chunk.is_empty() {
            return Err(Error::Busy("private stream source ended early"));
        }
        if chunk.len() > max {
            return Err(Error::Unsupported(
                "private stream reader exceeded requested chunk",
            ));
        }
        file.write_all(&chunk)?;
        digest.update(&chunk);
        offset += chunk.len() as u64;
    }
    if !reader(offset, 1)?.is_empty() {
        return Err(Error::Busy("private stream source has excess bytes"));
    }
    if <[u8; 32]>::from(digest.finalize()) != expected_digest {
        return Err(Error::Busy("private stream source digest differs"));
    }
    file.sync_all()?;
    let metadata = file.metadata()?;
    if metadata.mode() & 0o077 != 0 {
        return Err(Error::UnsafePath(
            "private stream stage is no longer owner-only".into(),
        ));
    }
    let before = stamp(&metadata)?;
    if before.2 != expected_length {
        return Err(Error::Busy("private stream stage length changed"));
    }
    file.rewind()?;
    let mut buffer = [0u8; STREAM_CHUNK_BYTES];
    let mut checked = 0u64;
    let mut digest = Sha256::new();
    loop {
        let count = read_filled(&mut file, &mut buffer)?;
        if count == 0 {
            break;
        }
        checked += count as u64;
        if checked > expected_length {
            return Err(Error::Busy("private stream stage grew during verification"));
        }
        digest.update(&buffer[..count]);
    }
    if checked != expected_length || <[u8; 32]>::from(digest.finalize()) != expected_digest {
        return Err(Error::Busy("private stream stage bytes differ"));
    }
    verify_path(directory, name, &original_parent, &file, before)?;
    directory.sync_all()?;
    verify_path(directory, name, &original_parent, &file, before)?;
    Ok(identity)
}

#[cfg(test)]
#[path = "fs_stream_tests.rs"]
mod tests;
