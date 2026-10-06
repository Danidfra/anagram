#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::Manager;
static PRESENTATION_ID: AtomicUsize = AtomicUsize::new(0);

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.nostr.anagram", "active-private-key").map_err(|e| e.to_string())
}
#[tauri::command]
async fn read_private_key() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| match credential()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn write_private_key(private_key_hex: String) -> Result<(), String> {
    if private_key_hex.len() != 64 || !private_key_hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid private key".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        credential()?
            .set_password(&private_key_hex)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn remove_private_key() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|e| e.to_string())?
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let dev_origin = if cfg!(debug_assertions) {
                app.config().build.dev_url.as_ref().map(|url| url.origin())
            } else {
                None
            };
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_permission_request(move |webview, kind| {
                    use tauri::webview::{PermissionKind, PermissionResponse};
                    let trusted = webview
                        .url()
                        .map(|url| {
                            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                                || (matches!(url.scheme(), "http" | "https")
                                    && url.host_str() == Some("tauri.localhost"))
                                || dev_origin
                                    .as_ref()
                                    .is_some_and(|origin| *origin == url.origin())
                        })
                        .unwrap_or(false);
                    if !trusted {
                        return PermissionResponse::Deny;
                    }
                    // Capture is requested by the call's user-gesture controls. OS
                    // permission prompts and the system display picker still apply.
                    match kind {
                        PermissionKind::Microphone
                        | PermissionKind::Camera
                        | PermissionKind::DisplayCapture => PermissionResponse::Allow,
                        _ => PermissionResponse::Default,
                    }
                })
                .on_new_window(move |url, features| {
                    // The presentation contains mirrored decoded frames only. Do not
                    // allow arbitrary sites or additional privileged app windows.
                    if url.as_str() != "about:blank" {
                        return tauri::webview::NewWindowResponse::Deny;
                    }
                    let label = format!(
                        "call-presentation-{}",
                        PRESENTATION_ID.fetch_add(1, Ordering::Relaxed)
                    );
                    let result = tauri::WebviewWindowBuilder::new(
                        &handle,
                        label,
                        tauri::WebviewUrl::External(url),
                    )
                    .window_features(features)
                    .title("Anagram · Presentation")
                    .on_navigation(|url| url.as_str() == "about:blank")
                    .build();
                    match result {
                        Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                        Err(_) => tauri::webview::NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                for (label, presentation) in window.app_handle().webview_windows() {
                    if label.starts_with("call-presentation-") {
                        let _ = presentation.close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_private_key,
            write_private_key,
            remove_private_key
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Anagram");
}
