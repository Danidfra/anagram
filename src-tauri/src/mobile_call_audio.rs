#[cfg(target_os = "android")]
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Wry,
};

#[cfg(target_os = "android")]
struct CallAudio(PluginHandle<Wry>);

#[cfg(target_os = "android")]
pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("mobile-call-audio")
        .setup(|app, api| {
            app.manage(CallAudio(
                api.register_android_plugin("com.nostr.anagram", "CallAudioPlugin")?,
            ));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub fn set(app: &tauri::AppHandle, active: bool, speaker: bool) -> Result<(), String> {
    let _: serde_json::Value = app
        .state::<CallAudio>()
        .0
        .run_mobile_plugin(
            "configure",
            serde_json::json!({"active": active, "speaker": speaker}),
        )
        .map_err(|_| "Call audio routing failed".to_string())?;
    Ok(())
}

#[cfg(target_os = "ios")]
pub fn set(app: &tauri::AppHandle, active: bool, speaker: bool) -> Result<(), String> {
    extern "C" {
        fn anagram_set_call_audio(active: bool, speaker: bool) -> bool;
    }
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        // The Objective-C session and observers are confined to the main thread.
        let ok = unsafe { anagram_set_call_audio(active, speaker) };
        let _ = send.send(ok);
    })
    .map_err(|_| "Call audio routing unavailable".to_string())?;
    if receive
        .recv()
        .map_err(|_| "Call audio routing unavailable".to_string())?
    {
        Ok(())
    } else {
        Err("Call audio routing failed".into())
    }
}
