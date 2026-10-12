// Use GTK's asynchronous image request: WebKitGTK can omit images from paste
// events even though they are available on the system clipboard.
#[cfg(target_os = "linux")]
pub async fn read_image(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    use gtk::gio::{self, prelude::*};
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).request_image(move |_, image| {
                match image {
                    // Bound encoding and IPC memory for unusually large clipboard images.
                    Some(image)
                        if i64::from(image.width()) * i64::from(image.height()) <= 16_777_216 =>
                    {
                        let stream = gio::MemoryOutputStream::new_resizable();
                        let output = stream.clone();
                        // Encode off the UI thread as well as requesting the clipboard
                        // asynchronously, so large screenshots do not freeze the chat.
                        image.save_to_streamv_async(
                            &stream,
                            "png",
                            &[],
                            None::<&gio::Cancellable>,
                            move |result| {
                                let result = result
                                    .and_then(|_| output.close(None::<&gio::Cancellable>))
                                    .map(|_| output.steal_as_bytes().to_vec())
                                    .map_err(|_| "Could not read clipboard image".into());
                                let _ = sender.try_send(result);
                            },
                        );
                    }
                    Some(_) => {
                        let _ = sender.try_send(Err(
                            "Clipboard image is too large; attach it as a file instead".into(),
                        ));
                    }
                    None => {
                        let _ = sender.try_send(Ok(Vec::new()));
                    }
                }
            });
        })
        .map_err(|_| "Clipboard is unavailable".to_string())?;
    receiver.recv().await.ok_or("Clipboard is unavailable")?
}
