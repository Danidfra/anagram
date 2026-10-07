# Android notifications

In the APK, enable **Settings → Notifications → Android notifications**, allow the Android permission and select relays. The foreground listener keeps a persistent status notification and supports optional restart after reboot. Android battery restrictions and force-stop can prevent background delivery.

This ports the `iroh_call` relay listener to Tauri: verified NIP-59 envelopes, conversation mute/block rules, private-group epoch subscriptions, notification taps and bounded recovery into the normal message-ingestion path. It does not subscribe to public rooms.

Local identity/epoch keys used for detailed notifications stay encrypted with Android Keystore. Logout stops the listener and clears its keys and pending envelopes. External signers without local decryption keys receive generic notifications. Avatar requests require public HTTPS destinations, reject redirects/private addresses and have download limits.

Native sources live in `src-tauri/mobile/android`; `scripts/prepare-android.mjs` copies them and their manifest declarations into the generated Android project. The release workflow also runs their crypto/policy tests. Live delivery, lock-screen behaviour and reboot recovery still require an Android device test.
