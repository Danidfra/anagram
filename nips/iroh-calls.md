# Nostr + Iroh calls

Nostr authenticates peers and exchanges connection details. Iroh carries encrypted audio, video and screen streams. These are Anagram extensions, not assigned Nostr standards.

## Signalling

- Direct call controls attempt delivery to configured app relays and any known recipient inboxes. Known delivery routes are used immediately while inbox metadata refreshes in the background. If delivery fails or no route is known, discovery has a bounded 1.5-second fallback wait. Missing inbox metadata does not prevent a call. A single relay acknowledgement is sufficient; other publish attempts continue without delaying negotiation.
- An unsigned `kind:21117` rumor travels inside a NIP-44 `kind:13` seal and NIP-59 `kind:1059` gift wrap, with one intended `p` recipient. The rumor author must match the seal signer.
- JSON uses `protocol: "anagram/iroh-call/1"`, UUID `callId`, `action` (`invite`, `ringing`, `accept`, `end`), `mode` (`audio`, `video`) and ISO `expiresAt`.
- Invites and accepts include `address: { id, relayUrl }` and `mimeType`. End controls include a reason. Signals expire within 60 seconds; future timestamps beyond 10 seconds are rejected.
- Each call creates fresh Iroh endpoints. Peers accept only the endpoint authenticated by the other's Nostr signal, exchange the call UUID over ALPN `anagram/call/1`, then exchange ready frames before sending media.

## Media

- QUIC/TLS protects transport, including through Iroh relays. Frames have a big-endian 32-bit length prefix and a 1 MiB maximum.
- Frame types: `0` audio, `1` heartbeat, `2` ready, `3` video, `4` audio reset, `5` camera off/on, `6` screen video, `7` screen off/on, `8` microphone mute state. State frames carry one byte (`0` or `1`).
- Both peers negotiate `mediaVersion: 2` for separate WebM Opus audio and VP8 video. Screen and mute-state frames additionally require mutual `screenSupported` and `muteStateSupported`. Version 1 uses combined WebM media.
- Heartbeats run every 3 seconds; 15 seconds without a frame ends the connection. Media never travels through Nostr relays.
- Peers advertising `transportVersion: 2` use ALPN `anagram/call/2` with four separately ordered bidirectional streams: control, audio (types `0`, `4`), camera (`3`, `5`) and screen (`6`, `7`). Each stream confirms the call UUID before use. Control and audio have higher send priorities; receivers retain at most one pending frame per stream and deliver ready before media. Otherwise the original single-stream transport is used.
- Video send queues older than 1.5 seconds stop that video stream rather than discard dependent WebM chunks. Camera encoder/capture failures and video decoder failures leave audio connected. A failed decoder discards further chunks until the sender explicitly starts a fresh stream.

## Connection recovery

- Both peers must advertise `reconnectSupported: true`. Existing clients retain the original failure behavior.
- After an established connection fails, the original caller coordinates recovery using authenticated `reconnect` controls with `reconnectAttempt` (a monotonically increasing positive safe integer). The callee can send the same action to request recovery; it cannot initiate a new call this way.
- Each attempt creates fresh endpoints. The caller sends its new address; the callee starts accepting and returns `accept` with the matching attempt and its new address. Controls retain the original peer, call UUID, mode and group-session bindings. Duplicate/stale attempts do not restart a healthy connection.
- Recovery retries controls every two seconds, permits a second attempt after ten seconds, and ends after twenty seconds without recovery. There are at most two attempts per interruption; a later interruption gets a new bounded recovery window while attempt numbers continue increasing. Hangup, decline and other deliberate remote endings remain final.
- Capture, mute state and original start time survive recovery. Decoders and recorders restart together on the new connection; callbacks from a previous connection cannot affect its replacement.

## Group calls

- Links contain a room UUID, host pubkey, random 256-bit admission secret, inbox relay hints and expiry. The capability stays in the URL fragment; it contains no Iroh keys.
- Recipient-only controls use `anagram/iroh-room/1`: `join`, `roster`, `signal`, `leave`, `closed`, `rejected`. The host admits members and signs monotonically increasing roster revisions through the same encrypted envelopes.
- Each participant chooses their own display name before creating or joining and can edit it during the call. Names travel in the member `name` field of join and roster controls. In-call edits increment an optional nonnegative `nameRevision` (missing means zero). Guests resend their own authenticated join with the same session; the host accepts only a newer name revision for that member, then broadcasts a new roster revision. Name changes preserve existing media connections. Older hosts ignore guest name edits until everyone updates. Custom CSS is a local rendering preference and never enters signalling.
- Each join has a fresh session UUID. Pair signals bind both sessions; the lower pubkey initiates. Current members form a full mesh of separately authenticated Iroh connections.
- At four or more participants, camera targets become 300 kbps at 15 fps and screen targets become 750 kbps at 5 fps per peer; smaller rooms retain 600 kbps/24 fps and 1.5 Mbps/15 fps. Existing streams restart with fresh headers when the preset changes.
- Reconnecting peers stay in the roster until recovery succeeds or its deadline expires.
- Rooms allow six participants, expire within eight hours and end when the host leaves. Possession of the link grants admission, subject to host checks.

## Call history

Optional encrypted `kind:14` summaries carry `anagram-call`, version `1`, call UUID, mode, end reason, duration in seconds and an active flag (`0` or `1`). They contain no media or endpoint addresses and never initiate a call.
