use zorid_proto::{
    zorid::stream::v1::{self as stream, binary_command},
    Message,
};

// These vectors are encoded by protobuf-es and decoded/re-encoded by Prost.
// They prove codec interoperability, NOT canonical encoding or domain validity.
fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../proto/fixtures")
        .join(format!("{name}.bin"));
    std::fs::read(path).unwrap()
}

#[test]
fn raw_bytes_and_uint64_above_js_safe_integer_interoperate() {
    let bytes = fixture("append");
    let command = stream::BinaryCommand::decode(bytes.as_slice()).unwrap();
    assert_eq!(command.schema_version, 1);
    assert_eq!(command.required_features, ["binary-stream-v1"]);
    let Some(binary_command::Command::Append(append)) = &command.command else {
        panic!("append missing")
    };
    assert_eq!(append.offset, 9_007_199_254_740_993);
    assert_eq!(append.sequence, 2);
    assert_eq!(append.data, [0, 255, 128, 1]);
    assert_eq!(append.stage.as_ref().unwrap().operation_id, "operation");
    assert_eq!(command.encode_to_vec(), bytes);
}

#[test]
fn oneof_and_optional_zero_presence_interoperate() {
    let bytes = fixture("begin-empty");
    let command = stream::BinaryCommand::decode(bytes.as_slice()).unwrap();
    let Some(binary_command::Command::Begin(begin)) = &command.command else {
        panic!("begin missing")
    };
    assert_eq!(begin.expected_length, Some(0));
    assert!(matches!(
        begin.target.as_ref().unwrap().target,
        Some(stream::binary_target::Target::Create(_))
    ));
    assert_eq!(command.encode_to_vec(), bytes);
    let absent = stream::BeginStage::default();
    assert_eq!(absent.expected_length, None);
    assert!(absent.target.is_none());
    assert!(stream::StageStatus::default().state.is_none());
}

#[test]
fn unknown_required_features_remain_visible_for_validation() {
    let bytes = fixture("required-future");
    let command = stream::BinaryCommand::decode(bytes.as_slice()).unwrap();
    assert_eq!(command.required_features, ["future-critical-behavior"]);
    // Successful raw decoding is deliberately NOT successful feature validation.
    assert!(command.command.is_none());
    assert_eq!(command.encode_to_vec(), bytes);
}

#[test]
fn truncated_length_delimited_data_is_rejected() {
    let mut bytes = fixture("append");
    bytes.pop();
    assert!(stream::BinaryCommand::decode(bytes.as_slice()).is_err());
}

#[test]
fn rpc_fixtures_preserve_u64_presence_and_exact_wire() {
    use zorid_proto::zorid::sync::rpc::v1 as rpc;
    let bytes = fixture("rpc-accepted");
    let accepted = rpc::AcceptedReply::decode(bytes.as_slice()).unwrap();
    assert_eq!(accepted.sequence, Some(9_007_199_254_740_993));
    assert!(accepted.control.is_some());
    assert_eq!(accepted.encode_to_vec(), bytes);
    let bytes = fixture("rpc-empty-page");
    let empty = rpc::PullReply::decode(bytes.as_slice()).unwrap();
    assert_eq!(empty.through, Some(0));
    assert_eq!(empty.next.as_ref().unwrap().after, Some(0));
    assert_eq!(empty.complete, Some(true));
    assert_eq!(empty.encode_to_vec(), bytes);
    let bytes = fixture("rpc-incomplete-page");
    let page = rpc::PullReply::decode(bytes.as_slice()).unwrap();
    assert_eq!(page.complete, Some(false));
    assert_eq!(page.items[0].exact_wire, [0, 255, 128, 1]);
    assert_eq!(page.encode_to_vec(), bytes);
}

#[test]
fn stream_read_open_retains_the_preallocated_lookup_identity() {
    let bytes = fixture("read-open");
    let command = stream::BinaryCommand::decode(bytes.as_slice()).unwrap();
    let Some(binary_command::Command::OpenRead(read)) = &command.command else {
        panic!("read missing")
    };
    assert_eq!(read.read_id, "read-operation");
    assert_eq!(command.encode_to_vec(), bytes);
    // Empty is only a raw protobuf default; store/adapter validation must reject it.
    assert!(stream::OpenRead::default().read_id.is_empty());
}
