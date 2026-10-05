# NIPs Used in This App

This list is based on the current app code, especially `src/stores/nostrStore.ts`, the profile/relay UI components, and the local group-chat draft docs in this repo.

## NIP-01

- Used for standard Nostr events and profile metadata.
- The app publishes and reads `kind:0` metadata for users and group identities, and it relies on normal event signing and signature verification when handling custom group tickets.

## NIP-05

- Used to resolve `name@domain` identifiers into pubkeys.
- The app accepts NIP-05 identifiers when adding contacts or group members, and stores the resolved `nip05` value in contact metadata.

## NIP-07

- Used for browser-extension login/signing.
- The app can log in through a NIP-07 extension via `NDKNip07Signer` and checks that the extension account matches the active session.

## NIP-11

- Used to inspect relay metadata.
- The relay settings/profile UI loads relay info with `fetchInfo()` and shows the returned NIP-11 details.

## NIP-17

- This is the app's main private-message transport.
- It sends and receives `kind:14` private message rumors inside gift wraps, and it also uses the same DM flow for wrapped reactions (`kind:7`) and deletions (`kind:5`).
- Group chat messages are also sent as NIP-17 DMs to the group's current epoch public key.
- Images (JPEG, PNG, GIF, WebP, AVIF) are sent as NIP-17 `kind:15` file messages. The original image bytes are encrypted on the device with AES-256-GCM (WebCrypto) using a fresh random 32-byte key and 12-byte nonce per attachment, and only the ciphertext is uploaded (as `application/octet-stream`). The rumor content is the blob URL and its tags are `file-type` (plaintext MIME type), `encryption-algorithm` (`aes-gcm`), `decryption-key` and `decryption-nonce` (lowercase hex), `x` (SHA-256 of the ciphertext), `ox` (SHA-256 of the original image bytes), and `size` (ciphertext bytes). The key and nonce only exist inside the gift-wrapped rumor. Image metadata such as EXIF is not stripped; it is encrypted with the image and visible only to recipients.
- Received `kind:15` rumors are accepted only with a valid key, nonce, algorithm, `file-type`, `x`, and an HTTPS URL; `ox` and `size` are optional. The downloaded blob must match `x` before it is decrypted, a GCM authentication failure is a hard error, and only JPEG, PNG, GIF, WebP, and AVIF are rendered (from a decrypted `blob:` URL). Nonces of 12 or 16 bytes are accepted for interoperability. Forwarding a `kind:15` attachment re-sends the same URL, key, and nonce in a new `kind:15` rumor without re-uploading.
- Video and audio still use the older plaintext upload with a `kind:14` rumor and a NIP-92 `imeta` tag, and existing `kind:14` + `imeta` media keeps rendering.
- Text edits follow NIP-17's delete-and-replace convention: the app sends a wrapped `kind:5` deletion and a replacement wrapped `kind:14` rumor with the original message timestamp. Replacement rumors also carry a private `e` tag marked `edit` so this client can reconcile either relay arrival order without displaying duplicate messages.

## NIP-19

- Used for bech32 Nostr identifiers.
- The app decodes `nsec` and `npub` inputs, and it encodes `npub` and `nprofile` values for stored/displayed contact identifiers.

## NIP-24

- Used for extra profile metadata fields on `kind:0` profiles.
- The profile editor reads and writes fields such as `display_name`, `website`, `banner`, and booleans like `bot`.
- The code also uses a `group` boolean on profiles; that part looks app-specific/draft-oriented rather than clearly standard.

## NIP-44

- Used for encryption throughout the app.
- It is used by the DM/gift-wrap pipeline, and also to self-encrypt private preferences, group identity secrets, per-contact cursor data, and the private contact-list payload.

## NIP-46

- Used for Nostr remote signing login.
- The app acts as a NIP-46 client and supports `bunker://` connection tokens and generated `nostrconnect://` pairing links.
- The NIP-46 local client key is persisted as a session token so refresh and app restart can restore the remote signer connection without storing the user's `nsec`.
- The app requests broad `sign_event`, `nip44_encrypt`, and `nip44_decrypt` permissions because private messaging, private app storage, profile updates, relay lists, and relay auth all need the active signer.

## NIP-51

- Used for private follow-set style lists.
- The app restores and publishes the user's `kind:10000` mute list with muted pubkeys stored as NIP-44-encrypted private `p` items in `content`.
- The app publishes a group-authored `kind:30000` follow set with `["d", "members"]` when a group is created and whenever the owner changes the effective group membership set.
- Group member pubkeys are stored only as NIP-44-encrypted private `p` items in `content`, and the latest event is used to restore the owner-side `group_members` snapshot for that group.

## NIP-59

- Used for gift wrapping.
- The app sends/receives `kind:1059` gift wraps and `kind:13` seals for private messaging.
- It also gift-wraps signed `kind:1014` group epoch tickets before sending them to members.

## NIP-65

- Used for relay list metadata.
- The app publishes, restores, and subscribes to relay lists using `kind:10002`.
- It uses those relay lists for the logged-in user, contacts, and groups when deciding where to read from or publish to.

## NIP-78

- Used for app-specific private storage on Nostr.
- The app uses `kind:30078` replaceable events for private preferences, group identity secrets, and per-contact cursor state.
- Those payloads are encrypted with NIP-44 before publication.
- The user's configured Blossom upload server is stored in the encrypted private-preferences payload and restored with the account.

## NIP-B7

- Used for Blossom media uploads.
- The app uploads blobs through the configured HTTPS Blossom server and signs server-scoped `kind:24242` upload authorization events.
- Encrypted image uploads send ciphertext only, in a single PUT that is not retried automatically, and the server's returned hash must match the ciphertext hash. Servers must accept `application/octet-stream`; several public servers (including the default) currently reject it.
- The plaintext upload path (video and audio) refuses files whose type or leading bytes identify them as images.
- The server choice remains private in the app's NIP-78 preferences; the app does not currently publish a public `kind:10063` Blossom server list.

## NIP-171

- This appears to be a repo-local draft/private-group scheme layered on top of NIP-17.
- The app implements `kind:1014` epoch tickets, verifies them on receipt, rotates epoch keys, stores epoch history, and routes group DMs through the current epoch public key.
