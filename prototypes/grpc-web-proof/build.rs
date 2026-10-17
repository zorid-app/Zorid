fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "proto/zorid/prototype/grpcproof/v1/proof.proto";
    let mut config = tonic_prost_build::Config::new();
    config.protoc_executable(protoc_bin_vendored::protoc_bin_path()?);
    tonic_prost_build::configure().compile_with_config(config, &[proto], &["proto"])?;
    println!("cargo:rerun-if-changed={proto}");
    Ok(())
}
