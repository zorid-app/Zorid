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
impl MobileSession {
    fn guarded_request(&mut self, action: impl FnOnce(&mut EmbeddedHost) -> std::io::Result<Vec<u8>>) -> ZoridBuffer {
        let Some(host) = self.host.as_mut() else { return ZoridBuffer::empty(); };
        match catch_unwind(AssertUnwindSafe(|| action(host))) {
            Ok(Ok(bytes)) => ZoridBuffer::owned(bytes),
            _ => {
                // A terminal frame failure/panic fences this generation and drops
                // leases. Reopen with the same persisted consumer/operation IDs.
                self.host.take();
                ZoridBuffer::empty()
            }
        }
    }
}
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
    let frame = std::slice::from_raw_parts(bytes, len);
    (*session).guarded_request(|host| host.dispatch(frame))
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

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(command: serde_json::Value) -> Vec<u8> {
        let header=serde_json::to_vec(&serde_json::json!({"version":1,"request_id":"1","command":command})).unwrap();
        let mut bytes=Vec::new();bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());bytes.extend_from_slice(&0u32.to_be_bytes());bytes.extend(header);bytes
    }
    fn claim() -> Vec<u8> { frame(serde_json::json!({"method":"claim_client","client_id":"abcdefab-0000-4000-8000-000000000001"})) }
    #[test]
    fn panic_after_claim_fences_session_and_drops_invisible_lease() {
        let root=std::env::temp_dir().join(format!("zorid-mobile-ffi-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let mut session=MobileSession{host:Some(EmbeddedHost::open_local(&root).unwrap())};
        let response=session.guarded_request(|host| {host.dispatch(&claim())?;panic!("injected after claim");});
        assert!(response.data.is_null());assert!(session.host.is_none());
        let refused=session.guarded_request(|_| panic!("poisoned session must not dispatch"));assert!(refused.data.is_null());
        let mut reopened=EmbeddedHost::open_local(&root).unwrap();let reply=reopened.dispatch(&claim()).unwrap();
        let n=u32::from_be_bytes(reply[..4].try_into().unwrap()) as usize;
        let header:serde_json::Value=serde_json::from_slice(&reply[8..8+n]).unwrap();assert_eq!(header["ok"],true);
        drop(reopened);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn buffer_round_trip_uses_owned_exact_slice() {
        let data=vec![0,255,1,0,42];let buffer=ZoridBuffer::owned(data.clone());
        assert_eq!(unsafe{std::slice::from_raw_parts(buffer.data,buffer.len)},data);
        unsafe{zorid_mobile_buffer_free(buffer);zorid_mobile_buffer_free(ZoridBuffer::empty());}
    }
}
