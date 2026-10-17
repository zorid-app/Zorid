//! Private desktop stdio transport; shared implementation also embeds in mobile.
fn main() -> std::process::ExitCode {
    match zorid_desktop_host::run_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("Native host transport terminated; retry mutations only with identical operation ID and request");
            std::process::ExitCode::FAILURE
        }
    }
}
