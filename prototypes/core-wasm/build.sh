#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cargo_bin=${CARGO:-cargo}
wasm_bindgen_bin=${WASM_BINDGEN:-wasm-bindgen}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$project_root/target/core-wasm"}
case "$("$wasm_bindgen_bin" --version)" in
  'wasm-bindgen 0.2.129') ;;
  *) echo 'This fixture requires wasm-bindgen-cli 0.2.129 matching the crate.' >&2; exit 1 ;;
esac
"$cargo_bin" build --manifest-path "$project_root/crates/zorid-wasm/Cargo.toml" --target wasm32-unknown-unknown --release -j 1
"$wasm_bindgen_bin" --target web --out-name zorid_wasm --out-dir "$project_root/prototypes/core-wasm/pkg" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/zorid_wasm.wasm"
