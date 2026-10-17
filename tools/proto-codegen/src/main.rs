use std::{env, error::Error, fs, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let rust_out = output.join("crates/zorid-proto/src/generated");
    let ts_out = output.join("src/generated");
    let service_out = output.join("crates/zorid-sync-rpc/src/generated");
    fs::create_dir_all(&rust_out)?;
    fs::create_dir_all(&ts_out)?;
    fs::create_dir_all(&service_out)?;
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let schemas = [
        "zorid/common/v1/common.proto",
        "zorid/stream/v1/binary.proto",
        "zorid/sync/rpc/v1/relay.proto",
    ];
    let mut config = prost_build::Config::new();
    config.protoc_executable(&protoc).out_dir(&rust_out);
    let paths: Vec<_> = schemas.iter().map(|p| root.join("proto").join(p)).collect();
    config.compile_protos(&paths, &[root.join("proto")])?;
    // Generate services separately, referencing the same portable message types.
    let mut services = prost_build::Config::new();
    services.protoc_executable(&protoc);
    tonic_prost_build::configure()
        .out_dir(&service_out)
        .extern_path(".zorid.sync.rpc.v1", "::zorid_proto::zorid::sync::rpc::v1")
        .emit_rerun_if_changed(false)
        .compile_with_config(
            services,
            &[root.join("proto/zorid/sync/rpc/v1/relay.proto")],
            &[root.join("proto")],
        )?;
    let plugin = root.join(if cfg!(windows) {
        "node_modules/.bin/protoc-gen-es.cmd"
    } else {
        "node_modules/.bin/protoc-gen-es"
    });
    let status = Command::new(&protoc)
        .current_dir(&root)
        .arg("-Iproto")
        .arg(format!("--plugin=protoc-gen-es={}", plugin.display()))
        .arg(format!("--es_out={}", ts_out.display()))
        .arg("--es_opt=target=ts,import_extension=ts,erasable_syntax=true")
        .args(schemas.iter().map(|p| format!("proto/{p}")))
        .status()?;
    if !status.success() {
        return Err("protoc-gen-es failed".into());
    }
    Ok(())
}
