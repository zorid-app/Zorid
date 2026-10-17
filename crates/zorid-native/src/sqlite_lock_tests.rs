//! A live NativeVault must coexist with independently opened SQLite/CLI peers.
//! All databases here are fresh, isolated temporary fixtures.
use crate::*;
use std::{
    os::unix::fs::MetadataExt,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use zorid_core::{EntryKind, Mutation, OperationId};

fn request(op: &str, mutation: Mutation) -> MutationRequest {
    MutationRequest {
        operation_id: OperationId::new(op).unwrap(),
        mutation,
    }
}
fn file_id() -> EntryId {
    EntryId::new("file").unwrap()
}

#[test]
fn sqlite_peer_worker() {
    let Some(root) = std::env::var_os("ZORID_LOCK_TEST_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    // Probe from ANOTHER process before opening SQLite: a whole-file POSIX
    // exclusive lock must conflict with the live owner's DB/SHM locks. This
    // catches lock loss even if a newer SQLite peer defends against WAL unlink.
    for name in ["vault.sqlite", "vault.sqlite-shm"] {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(".zorid").join(name))
            .unwrap();
        let result =
            rustix::fs::fcntl_lock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive);
        assert!(
            matches!(
                result,
                Err(rustix::io::Errno::AGAIN | rustix::io::Errno::ACCESS)
            ),
            "live owner lost POSIX lock on {name}: {result:?}"
        );
    }
    let expected = std::env::var("ZORID_LOCK_TEST_EXPECTED")
        .unwrap()
        .into_bytes();
    if std::env::var_os("ZORID_LOCK_TEST_NATIVE").is_some() {
        let mut peer = NativeVault::open_existing(&root).unwrap();
        let state = peer.read(&file_id()).unwrap().unwrap();
        assert_eq!(state.content.unwrap(), expected);
        peer.apply(&request(
            "peer-write",
            Mutation::Write {
                id: file_id(),
                expected: state.state.revision,
                content: b"peer".to_vec(),
            },
        ))
        .unwrap();
    } else {
        // Match the external mode=ro/query_only observer that exposed this bug.
        let peer = rusqlite::Connection::open_with_flags(
            root.join(".zorid/vault.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        peer.pragma_update(None, "query_only", true).unwrap();
        let bytes: Vec<u8> = peer
            .query_row("SELECT content FROM entries WHERE id='file'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(bytes, expected);
        drop(peer);
    }
}
fn peer(root: &std::path::Path, expected: &str, native: bool) {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        "sqlite_lock_tests::sqlite_peer_worker",
        "--nocapture",
    ])
    .env("ZORID_LOCK_TEST_ROOT", root)
    .env("ZORID_LOCK_TEST_EXPECTED", expected)
    .stdout(Stdio::null());
    if native {
        cmd.env("ZORID_LOCK_TEST_NATIVE", "1");
    }
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "peer failed: {status}");
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("peer timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn sqlite_locks_survive_native_verification_and_independent_peer_close() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut owner = NativeVault::open(root).unwrap();
    owner
        .apply(&request(
            "create",
            Mutation::Create {
                id: file_id(),
                path: VaultPath::new("note.bin").unwrap(),
                kind: EntryKind::File,
                content: Some(b"owner".to_vec()),
            },
        ))
        .unwrap();
    let wal = root.join(".zorid/vault.sqlite-wal");
    let shm = root.join(".zorid/vault.sqlite-shm");
    let identities = (
        std::fs::symlink_metadata(&wal).unwrap().ino(),
        std::fs::symlink_metadata(&shm).unwrap().ino(),
    );
    for _ in 0..3 {
        owner.identity().unwrap();
        owner.list().unwrap();
        owner.status().unwrap();
        peer(root, "owner", false);
        assert_eq!(
            std::fs::symlink_metadata(&wal).unwrap().ino(),
            identities.0,
            "peer close unlinked/replaced the live owner's WAL"
        );
        assert_eq!(
            std::fs::symlink_metadata(&shm).unwrap().ino(),
            identities.1,
            "peer close unlinked/replaced the live owner's SHM"
        );
    }
    peer(root, "owner", true);
    assert_eq!(
        owner.read(&file_id()).unwrap().unwrap().content.unwrap(),
        b"peer"
    );
    let revision = owner.read(&file_id()).unwrap().unwrap().state.revision;
    owner
        .apply(&request(
            "owner-again",
            Mutation::Write {
                id: file_id(),
                expected: revision,
                content: b"owner-again".to_vec(),
            },
        ))
        .unwrap();
    peer(root, "owner-again", false);
    drop(owner);
    let reopened = NativeVault::open_existing(root).unwrap();
    assert_eq!(
        reopened.read(&file_id()).unwrap().unwrap().content.unwrap(),
        b"owner-again"
    );
}
