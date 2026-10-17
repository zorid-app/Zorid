//! Opt-in, one-case-per-process decoder measurements; not a production limit.
//! Requires the RPC foundation. Build/run only under the coordinator's build slot.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    mem::size_of,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    time::Instant,
};
use zorid_proto::Message;
use zorid_sync_protocol::{
    rpc::{self, pb},
    Cursor, LogPosition, RealmId, ServerEpoch,
};

struct TrackingAllocator;
static ENABLED: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
fn add(bytes: usize) {
    ALLOCATED.fetch_add(bytes, SeqCst);
    CALLS.fetch_add(1, SeqCst);
    let live = LIVE.fetch_add(bytes, SeqCst) + bytes;
    PEAK.fetch_max(live, SeqCst);
}
unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() && ENABLED.load(SeqCst) {
            add(layout.size());
        }
        ptr
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() && ENABLED.load(SeqCst) {
            add(layout.size());
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        if ENABLED.load(SeqCst) {
            LIVE.fetch_sub(layout.size(), SeqCst);
        }
    }
    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, new_size: usize) -> *mut u8 {
        let enabled = ENABLED.load(SeqCst);
        // Conservative: count old + new concurrently even for in-place realloc.
        if enabled {
            add(new_size);
        }
        let result = System.realloc(ptr, old, new_size);
        if enabled {
            LIVE.fetch_sub(
                if result.is_null() {
                    new_size
                } else {
                    old.size()
                },
                SeqCst,
            );
        }
        result
    }
}
#[global_allocator]
static ALLOCATOR: TrackingAllocator = TrackingAllocator;

const CASES: &[&str] = &[
    "pull-items",
    "append-extensions",
    "pull-extensions",
    "append-features",
    "pull-features",
    "hello-packed",
    "reply-packed",
    "pull-truncated",
    "pull-unknown",
];
fn control() -> pb::Control {
    pb::Control::default()
}
fn base_pull() -> pb::PullReply {
    pb::PullReply {
        transport_major: Some(2),
        control: Some(control()),
        next: Some(pb::Cursor {
            server_epoch: "epoch".into(),
            after: Some(0),
            control: Some(control()),
        }),
        through: Some(0),
        complete: Some(true),
        ..Default::default()
    }
}
fn base_append(control: pb::Control) -> pb::AppendRequest {
    pb::AppendRequest {
        context: Some(pb::RequestContext {
            transport_major: Some(2),
            control: Some(control),
        }),
        vault_id: "vault".into(),
        update_id: "update".into(),
        exact_wire: vec![0],
    }
}
fn fit<T: Message>(cap: usize, unit: usize, make: impl Fn(usize) -> T) -> (Vec<u8>, usize) {
    let mut count = cap / unit;
    loop {
        let value = make(count);
        let len = value.encoded_len();
        if len <= cap {
            return (value.encode_to_vec(), count);
        }
        count = count
            .checked_sub((len - cap).div_ceil(unit))
            .expect("fixture overhead exceeds cap");
    }
}
fn fixture(case: &str) -> (Vec<u8>, usize, usize) {
    let pull_cap = rpc::MAX_PULL_MESSAGE;
    let append_cap = rpc::MAX_APPEND_MESSAGE;
    let (mut bytes, count, cap) = match case {
        "pull-items" | "pull-truncated" => {
            let (b, n) = fit(pull_cap, 2, |n| {
                let mut v = base_pull();
                v.items = vec![pb::PullItem::default(); n];
                v
            });
            (b, n, pull_cap)
        }
        "append-extensions" | "append-features" => {
            let (b, n) = fit(append_cap, 2, |n| {
                let mut c = control();
                if case.ends_with("extensions") {
                    c.optional_extensions = vec![pb::InformationalExtension::default(); n];
                } else {
                    c.required_features = vec![String::new(); n];
                }
                base_append(c)
            });
            (b, n, append_cap)
        }
        "pull-extensions" | "pull-features" => {
            let (b, n) = fit(pull_cap, 2, |n| {
                let mut v = base_pull();
                let c = v.control.as_mut().unwrap();
                if case.ends_with("extensions") {
                    c.optional_extensions = vec![pb::InformationalExtension::default(); n];
                } else {
                    c.required_features = vec![String::new(); n];
                }
                v
            });
            (b, n, pull_cap)
        }
        "hello-packed" => {
            let (b, n) = fit(rpc::MAX_CONTROL_BYTES, 1, |n| pb::HelloRequest {
                offered_transport_majors: vec![0; n],
                control: Some(control()),
            });
            (b, n, rpc::MAX_CONTROL_BYTES)
        }
        "reply-packed" => {
            let (b, n) = fit(rpc::MAX_CONTROL_BYTES, 1, |n| {
                let mut v = rpc::hello_reply(
                    &RealmId::new("realm").unwrap(),
                    &ServerEpoch::new("epoch").unwrap(),
                );
                v.envelope_versions = vec![0; n];
                v
            });
            (b, n, rpc::MAX_CONTROL_BYTES)
        }
        "pull-unknown" => {
            // Field 9 is standard-encoded HelloReply.control but unknown to PullReply.
            // Concatenation uses protobuf's standard merge semantics, not a custom codec.
            let part = pb::HelloReply {
                control: Some(control()),
                ..Default::default()
            }
            .encode_to_vec();
            let n = pull_cap / part.len();
            (part.repeat(n), n, pull_cap)
        }
        _ => unreachable!(),
    };
    if case == "pull-truncated" {
        // Final Control is an empty length-delimited message; remove its length.
        bytes.pop();
    }
    (bytes, count, cap)
}
// Numeric inspection only: no JSON allocations or fixture construction while tracking.
fn pull_counts(v: &pb::PullReply) -> [usize; 4] {
    [
        v.items.len(),
        v.items.capacity(),
        v.control
            .as_ref()
            .map_or(0, |c| c.optional_extensions.len()),
        v.control.as_ref().map_or(0, |c| c.required_features.len()),
    ]
}
fn append_counts(v: &pb::AppendRequest) -> [usize; 4] {
    v.context
        .as_ref()
        .and_then(|v| v.control.as_ref())
        .map_or([0; 4], |c| {
            [
                c.optional_extensions.len(),
                c.optional_extensions.capacity(),
                c.required_features.len(),
                c.required_features.capacity(),
            ]
        })
}
fn measure<T: Message + Default>(
    case: &str,
    bytes: &[u8],
    count: usize,
    cap: usize,
    summarize: impl Fn(&T) -> [usize; 4],
    validate: impl FnOnce(T) -> bool,
) {
    assert!(
        bytes.len() <= cap,
        "fixture must reach decoder within approved frame cap"
    );
    LIVE.store(0, SeqCst);
    PEAK.store(0, SeqCst);
    ALLOCATED.store(0, SeqCst);
    CALLS.store(0, SeqCst);
    ENABLED.store(true, SeqCst);
    let started = Instant::now();
    let decoded = T::decode(bytes);
    let decode_ns = started.elapsed().as_nanos();
    let decoded_ok = decoded.is_ok();
    let live_after_decode = LIVE.load(SeqCst);
    let counts = decoded.as_ref().map_or([0; 4], &summarize);
    let validation_started = Instant::now();
    let accepted = match decoded {
        Ok(value) => validate(value),
        Err(error) => {
            drop(error);
            false
        }
    };
    let validation_drop_ns = validation_started.elapsed().as_nanos();
    let live_after_drop = LIVE.load(SeqCst);
    let peak = PEAK.load(SeqCst);
    let allocated = ALLOCATED.load(SeqCst);
    let calls = CALLS.load(SeqCst);
    ENABLED.store(false, SeqCst);
    println!(
        "{}",
        serde_json::json!({
            "case":case,"runtime":"prost","wire_bytes":bytes.len(),"frame_cap":cap,"fixture_elements":count,
            "decoded":decoded_ok,"domain_accepted":accepted,"decode_ns":decode_ns,"validation_and_drop_ns":validation_drop_ns,
            "counts":counts,"live_after_decode":live_after_decode,"live_after_drop":live_after_drop,
            "conservative_peak_allocated_bytes":peak,"total_allocated_bytes":allocated,"allocation_calls":calls,
            "sizes":{"pull_item":size_of::<pb::PullItem>(),"extension":size_of::<pb::InformationalExtension>(),"string":size_of::<String>()},
            "scope":"single decode+validation; excludes fixture/input and allocator metadata; no approved resource bound"
        })
    );
    assert!(
        !accepted,
        "adversarial fixture unexpectedly passed production domain validation"
    );
    assert_eq!(
        decoded_ok,
        case != "pull-truncated",
        "unexpected wire decode outcome"
    );
    assert_eq!(
        live_after_drop, 0,
        "measured allocations remain live after result drop"
    );
}
fn main() {
    let mut args = std::env::args().skip(1);
    let arg = args.next().unwrap_or_else(|| "--list".into());
    if arg == "--list" {
        for case in CASES {
            println!("{case}");
        }
        return;
    }
    assert!(
        args.next().is_none() && CASES.contains(&arg.as_str()),
        "usage: rpc_decode_budget [--list|CASE]; one case per process"
    );
    let (bytes, count, cap) = fixture(&arg); // Builder values are dropped before resetting the measurement.
    let epoch = ServerEpoch::new("epoch").unwrap();
    let cursor = Cursor::new(epoch.clone(), LogPosition::new(0));
    if arg.starts_with("append-") {
        measure::<pb::AppendRequest>(&arg, &bytes, count, cap, append_counts, |v| {
            rpc::validate_append_request(v).is_ok()
        });
    } else if arg == "hello-packed" {
        measure::<pb::HelloRequest>(
            &arg,
            &bytes,
            count,
            cap,
            |v| {
                [
                    v.offered_transport_majors.len(),
                    v.offered_transport_majors.capacity(),
                    0,
                    0,
                ]
            },
            |v| rpc::validate_hello_request(&v).is_ok(),
        );
    } else if arg == "reply-packed" {
        let realm = RealmId::new("realm").unwrap();
        measure::<pb::HelloReply>(
            &arg,
            &bytes,
            count,
            cap,
            |v| {
                [
                    v.envelope_versions.len(),
                    v.envelope_versions.capacity(),
                    0,
                    0,
                ]
            },
            |v| rpc::validate_hello_reply(&v, &realm, &epoch).is_ok(),
        );
    } else {
        measure::<pb::PullReply>(&arg, &bytes, count, cap, pull_counts, |v| {
            rpc::validate_pull_reply(v, &cursor, None).is_ok()
        });
    }
}
