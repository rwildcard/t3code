fn main() {
    // lib.rs embeds the bridge with include_str!; fail with a pointer to the
    // fix instead of a bare "file not found".
    let bridge = std::path::Path::new("../dist/bridge.iife.js");
    println!("cargo:rerun-if-changed=../dist/bridge.iife.js");
    if !bridge.exists() {
        panic!("apps/desktop-tauri/dist/bridge.iife.js is missing. Run `vp run build:bridge` in apps/desktop-tauri first.");
    }
    tauri_build::build()
}
