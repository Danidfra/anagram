fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_private_key",
            "write_private_key",
            "remove_private_key",
        ]),
    ))
    .expect("failed to build Anagram permissions");
}
