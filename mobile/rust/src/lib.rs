//! Small owned C ABI over the shared native host. Swift/Kotlin never implement
//! storage, Markdown or sync semantics. Each session is used on one serial queue.
use std::{ffi::{c_char, CStr}, panic::{catch_unwind, AssertUnwindSafe}, ptr};
use zorid_desktop_host::EmbeddedHost;

#[repr(C)]
pub struct ZoridBuffer { pub data: *mut u8, pub len: usize }
impl ZoridBuffer {
    fn empty() -> Self { Self { data: ptr::null_mut(), len: 0 } }
    fn owned(bytes: Vec<u8>) -> Self {
        let boxed = bytes.into_boxed_slice();
        let len = boxed.len();
        Self { data: Box::into_raw(boxed) as *mut u8, len }
    }
}
pub struct MobileSession { host: Option<EmbeddedHost> }
/// Path is a trusted native-selected UTF-8 app-local directory. Never web input.
/// The returned session is exclusive; do not call/drop it concurrently.
/// On failure a sanitized JSON error is returned in error_out, freed with buffer_free.
/// # Safety
/// root must be NUL-terminated; error_out must point to writable storage.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_open(root: *const c_char, error_out: *mut ZoridBuffer) -> *mut MobileSession {
    if root.is_null() || error_out.is_null() { return ptr::null_mut(); }
    *error_out = ZoridBuffer::empty();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let path = CStr::from_ptr(root).to_str().map_err(|_| serde_json::json!({"code":"invalid_root"}))?;
        EmbeddedHost::open_local(std::path::Path::new(path))
    }));
    match result {
        Ok(Ok(host)) => Box::into_raw(Box::new(MobileSession { host: Some(host) })),
        other => {
            let error = match other { Ok(Err(error)) => error, _ => serde_json::json!({"code":"native_panic"}) };
            *error_out = ZoridBuffer::owned(serde_json::to_vec(&error).unwrap());
            ptr::null_mut()
        }
    }
}
/// One complete bounded stdio-compatible frame. Empty response means transport
/// failure; caller preserves every in-flight operation/checkpoint identity.
/// # Safety
/// session is live/exclusive, bytes points to len readable bytes.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_request(session: *mut MobileSession, bytes: *const u8, len: usize) -> ZoridBuffer {
    if session.is_null() || bytes.is_null() || len > 34 * 1024 * 1024 { return ZoridBuffer::empty(); }
    let state = &mut *session;
    if state.host.is_none() { return ZoridBuffer::empty(); }
    let result = catch_unwind(AssertUnwindSafe(|| {
        state.host.as_mut().unwrap().dispatch(std::slice::from_raw_parts(bytes, len))
    }));
    match result {
        Ok(Ok(bytes)) => ZoridBuffer::owned(bytes),
        _ => {
            // Fence this generation on terminal framing error or panic. Drop all
            // live leases; reopen with the same persisted client/op identities.
            state.host.take();
            ZoridBuffer::empty()
        }
    }
}
/// # Safety
/// buffer was returned by this ABI and has not previously been freed.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_buffer_free(buffer: ZoridBuffer) {
    if !buffer.data.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(buffer.data, buffer.len)));
    }
}
/// Drop releases SQLite and consumer kernel leases; retained drafts/intents stay.
/// # Safety
/// session was returned by open, no calls remain and it was not already closed.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_close(session: *mut MobileSession) {
    if !session.is_null() { drop(Box::from_raw(session)); }
}

/// Sanitized startup diagnostics; no selected root or file content.
/// # Safety
/// session is a live exclusive pointer returned by open.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_startup(session: *mut MobileSession) -> ZoridBuffer {
    if session.is_null() { return ZoridBuffer::empty(); }
    let Some(host) = (*session).host.as_ref() else { return ZoridBuffer::empty(); };
    ZoridBuffer::owned(serde_json::to_vec(&serde_json::json!({"reconciliation":host.reconciliation()})).unwrap())
}
/// Trusted shell-triggered bounded local refresh, never arbitrary root selection.
/// # Safety
/// session is a live exclusive pointer returned by open.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_refresh(session: *mut MobileSession) -> ZoridBuffer {
    if session.is_null() { return ZoridBuffer::empty(); }
    let state = &mut *session;
    let Some(host) = state.host.as_mut() else { return ZoridBuffer::empty(); };
    match catch_unwind(AssertUnwindSafe(|| host.refresh_local())) {
        Ok(Ok(status)) => ZoridBuffer::owned(serde_json::to_vec(&serde_json::json!({"reconciliation":status})).unwrap()),
        Ok(Err(_)) => ZoridBuffer::empty(),
        Err(_) => { state.host.take(); ZoridBuffer::empty() }
    }
}
