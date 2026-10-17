use super::*;
use std::{
    fs as stdfs,
    io::{SeekFrom, Write},
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
};

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn parent(root: &std::path::Path) -> File {
    File::open(root).unwrap()
}
fn chunk_reader<'a>(bytes: &'a [u8]) -> impl FnMut(u64, usize) -> Result<Vec<u8>> + 'a {
    move |offset, max| {
        let offset = offset as usize;
        if offset >= bytes.len() {
            return Ok(Vec::new());
        }
        Ok(bytes[offset..bytes.len().min(offset + max)].to_vec())
    }
}

#[test]
fn preserves_boundary_utf8_bom_nul_and_exact_bytes_in_bounded_chunks() {
    let root = tempfile::tempdir().unwrap();
    let mut bytes = b"\xef\xbb\xbf".to_vec();
    bytes.resize(STREAM_CHUNK_BYTES - 1, b'a');
    bytes.extend_from_slice("\u{1f642}\r\n\0end".as_bytes());
    stdfs::write(root.path().join("source"), &bytes).unwrap();
    let mut seen = Vec::new();
    let snapshot = stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |chunk| {
        assert!(chunk.len() <= STREAM_CHUNK_BYTES);
        seen.extend_from_slice(chunk);
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(seen, bytes);
    assert_eq!(snapshot.length, bytes.len() as u64);
    assert_eq!(snapshot.digest, digest(&bytes));
    assert!(snapshot.valid_utf8);
    assert!(snapshot.has_nul);
    assert_eq!(
        snapshot.parent_identity,
        fs::identity(&parent(root.path())).unwrap()
    );
}

#[test]
fn strict_utf8_rejects_invalid_and_incomplete_sequences_without_changing_bytes() {
    let root = tempfile::tempdir().unwrap();
    for (index, bytes) in [
        b"\xff".as_slice(),
        b"\xf0\x9f".as_slice(),
        b"\xed\xa0\x80".as_slice(),
        b"\xc0\x80".as_slice(),
    ]
    .iter()
    .enumerate()
    {
        let name = format!("invalid{index}");
        stdfs::write(root.path().join(&name), bytes).unwrap();
        let snapshot = stream_snapshot(&parent(root.path()), &name, MAX_STREAM_BYTES, |_| Ok(()))
            .unwrap()
            .unwrap();
        assert!(!snapshot.valid_utf8);
        assert!(!snapshot.has_nul);
        assert_eq!(snapshot.digest, digest(bytes));
    }
    let mut bytes = vec![b'a'; STREAM_CHUNK_BYTES - 1];
    bytes.extend_from_slice(b"\xe2X\xac");
    stdfs::write(root.path().join("split-invalid"), &bytes).unwrap();
    assert!(
        !stream_snapshot(
            &parent(root.path()),
            "split-invalid",
            MAX_STREAM_BYTES,
            |_| Ok(())
        )
        .unwrap()
        .unwrap()
        .valid_utf8
    );
    stdfs::write(root.path().join("empty"), []).unwrap();
    let empty = stream_snapshot(&parent(root.path()), "empty", 0, |_| {
        panic!("empty file callback")
    })
    .unwrap()
    .unwrap();
    assert!(empty.valid_utf8);
    assert!(!empty.has_nul);
    assert_eq!(empty.digest, digest(&[]));
}

#[test]
fn callback_errors_and_late_open_descriptor_writes_never_return_evidence() {
    let root = tempfile::tempdir().unwrap();
    stdfs::write(root.path().join("source"), b"original").unwrap();
    assert!(
        stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |_| Err(
            Error::Busy("callback failed")
        ))
        .is_err()
    );
    let mut late = stdfs::OpenOptions::new()
        .append(true)
        .open(root.path().join("source"))
        .unwrap();
    let mut changed = false;
    let outcome = stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |_| {
        if !changed {
            late.write_all(b"late").unwrap();
            late.sync_all().unwrap();
            changed = true;
        }
        Ok(())
    });
    assert!(outcome.is_err());
    assert_eq!(
        stdfs::read(root.path().join("source")).unwrap(),
        b"originallate"
    );
}

#[test]
fn replacements_links_and_limits_preserve_source_without_success() {
    let root = tempfile::tempdir().unwrap();
    stdfs::write(root.path().join("source"), b"same").unwrap();
    let outcome = stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |_| {
        stdfs::rename(root.path().join("source"), root.path().join("old")).unwrap();
        stdfs::write(root.path().join("source"), b"same").unwrap();
        Ok(())
    });
    assert!(outcome.is_err());
    assert_eq!(stdfs::read(root.path().join("old")).unwrap(), b"same");
    stdfs::hard_link(root.path().join("source"), root.path().join("hard")).unwrap();
    assert!(stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |_| Ok(())).is_err());
    symlink("old", root.path().join("link")).unwrap();
    assert!(stream_snapshot(&parent(root.path()), "link", MAX_STREAM_BYTES, |_| Ok(())).is_err());
    assert!(stream_snapshot(&parent(root.path()), "old", 3, |_| panic!(
        "over-limit callback"
    ))
    .is_err());
    assert!(
        stream_snapshot(&parent(root.path()), "../escape", MAX_STREAM_BYTES, |_| Ok(
            ()
        ))
        .is_err()
    );
}

#[test]
fn a_link_added_by_callback_invalidates_the_original_open_file() {
    let root = tempfile::tempdir().unwrap();
    stdfs::write(root.path().join("source"), b"original").unwrap();
    let result = stream_snapshot(&parent(root.path()), "source", MAX_STREAM_BYTES, |_| {
        stdfs::hard_link(root.path().join("source"), root.path().join("added-link")).unwrap();
        Ok(())
    });
    assert!(result.is_err());
}

#[test]
fn exact_stages_are_exclusive_owner_only_and_use_bounded_requests() {
    let root = tempfile::tempdir().unwrap();
    let bytes = vec![0x5a; STREAM_CHUNK_BYTES + 17];
    let mut read = chunk_reader(&bytes);
    let mut requests = Vec::new();
    let inode = stage_from_source(
        &parent(root.path()),
        "stage",
        bytes.len() as u64,
        digest(&bytes),
        |offset, max| {
            assert!(max <= STREAM_CHUNK_BYTES);
            requests.push((offset, max));
            read(offset, max)
        },
    )
    .unwrap();
    assert_eq!(stdfs::read(root.path().join("stage")).unwrap(), bytes);
    assert_eq!(
        inode,
        fs::identity(&File::open(root.path().join("stage")).unwrap()).unwrap()
    );
    assert_eq!(
        stdfs::metadata(root.path().join("stage")).unwrap().mode() & 0o777,
        0o600
    );
    assert_eq!(requests.last(), Some(&(bytes.len() as u64, 1)));
    assert!(stage_from_source(
        &parent(root.path()),
        "stage",
        0,
        digest(&[]),
        |_, _| panic!("existing stage callback")
    )
    .is_err());
    assert_eq!(stdfs::read(root.path().join("stage")).unwrap(), bytes);
    assert!(stage_from_source(
        &parent(root.path()),
        "too-large",
        MAX_STREAM_BYTES + 1,
        digest(&[]),
        |_, _| panic!("over-limit stage callback")
    )
    .is_err());
    assert!(!root.path().join("too-large").exists());
}

#[test]
fn callback_failure_retains_the_partial_stage() {
    let root = tempfile::tempdir().unwrap();
    let result = stage_from_source(
        &parent(root.path()),
        "partial",
        6,
        digest(b"abcdef"),
        |offset, _| {
            if offset == 0 {
                Ok(b"abc".to_vec())
            } else {
                Err(Error::Busy("reader failed"))
            }
        },
    );
    assert!(result.is_err());
    assert_eq!(stdfs::read(root.path().join("partial")).unwrap(), b"abc");
}

#[test]
fn short_excess_wrong_digest_and_oversized_chunks_never_finish_a_stage() {
    let root = tempfile::tempdir().unwrap();
    for (name, source, expected_digest) in [
        ("short", b"abc".as_slice(), digest(b"abcde")),
        ("excess", b"abcdef".as_slice(), digest(b"abcde")),
        ("wrong-digest", b"abcde".as_slice(), digest(b"xxxxx")),
    ] {
        assert!(stage_from_source(
            &parent(root.path()),
            name,
            5,
            expected_digest,
            chunk_reader(source)
        )
        .is_err());
        assert!(root.path().join(name).is_file());
    }
    assert!(stage_from_source(
        &parent(root.path()),
        "oversized-chunk",
        5,
        digest(b"abcde"),
        |_, max| Ok(vec![0; max + 1])
    )
    .is_err());
    assert_eq!(
        stdfs::read(root.path().join("oversized-chunk")).unwrap(),
        b""
    );
}

#[test]
fn staged_bytes_are_rechecked_after_the_last_reader_callback() {
    let root = tempfile::tempdir().unwrap();
    for (name, make_public) in [("mutated", false), ("permissions", true)] {
        let mut read = chunk_reader(b"abcde");
        let result = stage_from_source(
            &parent(root.path()),
            name,
            5,
            digest(b"abcde"),
            |offset, max| {
                if offset == 5 {
                    if make_public {
                        stdfs::set_permissions(
                            root.path().join(name),
                            stdfs::Permissions::from_mode(0o644),
                        )
                        .unwrap();
                    } else {
                        let mut file = stdfs::OpenOptions::new()
                            .write(true)
                            .open(root.path().join(name))
                            .unwrap();
                        file.seek(SeekFrom::Start(0)).unwrap();
                        file.write_all(b"X").unwrap();
                        file.sync_all().unwrap();
                    }
                }
                read(offset, max)
            },
        );
        assert!(result.is_err());
        assert_eq!(
            stdfs::read(root.path().join(name)).unwrap(),
            if make_public { b"abcde" } else { b"Xbcde" }
        );
    }
}

#[test]
fn short_reads_and_interruptions_fill_one_canonical_callback_chunk() {
    struct ShortReader {
        data: std::io::Cursor<Vec<u8>>,
        interrupt: bool,
    }
    impl Read for ShortReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.interrupt {
                self.interrupt = false;
                return Err(std::io::ErrorKind::Interrupted.into());
            }
            let count = buffer.len().min(3);
            self.data.read(&mut buffer[..count])
        }
    }
    let mut source = ShortReader {
        data: std::io::Cursor::new(b"abcdefghij".to_vec()),
        interrupt: true,
    };
    let mut buffer = [0; 8];
    assert_eq!(read_filled(&mut source, &mut buffer).unwrap(), 8);
    assert_eq!(&buffer, b"abcdefgh");
    assert_eq!(read_filled(&mut source, &mut buffer).unwrap(), 2);
    assert_eq!(&buffer[..2], b"ij");
    assert_eq!(read_filled(&mut source, &mut buffer).unwrap(), 0);
}
