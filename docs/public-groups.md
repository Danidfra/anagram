# Public groups

Public groups use signed, unencrypted events on ordinary Nostr relays.

## Room

- NIP-72 `kind:34550` defines the room: `d`, `name`, `description`, optional `image`, 1–8 `relay` tags and `["anagram-room", "1"]`.
- Its address is `34550:<owner>:<d>`. NIP-19 `naddr` links carry this identity and relay hints.
- Anagram's `trusted` and `blocked` tags define client-side policy. The owner is trusted; blocking wins. Untrusted posts display as text with web links removed and no message media. Author names and profile pictures load for all displayed participants, independently of posting trust. Text-only web previews are enabled for trusted public posts; DMs and private groups never fetch web previews, regardless of media trust.

## Messages

- NIP-C7 `kind:9` messages carry one `a` room address. Replies use `q`; attachments use NIP-92 `imeta`.
- NIP-25 `kind:7` reactions and NIP-09 `kind:5` deletion requests reference message IDs with `e` tags. Anagram adds an `h` room hint. Deletions never target the room address and require the original author.
- Edits delete the old version and publish a replacement with the same author, room and timestamp. Anagram's `e` tag marked `edit` links versions; an ordinary `e` preserves the original ID. This extends the NIP-17 edit flow to public messages.

## Pinned message

The owner can add one `["pinned", "<kind:9 event ID>"]` tag to the signed room definition, replace it, or remove it to unpin. Clients resolve the message in that room and apply the usual edits, deletion and trust rules. This is an Anagram extension.

## Relays and ownership

- Reads and writes use preferred room relays plus app relays. One responding relay is enough for reads, and one publish acknowledgement is enough for writes. Clients retain the newest verified room definition when a relay returns older or empty metadata; signatures prove authorship, not that a relay returned the latest policy.
- Transfers require the old owner's signed `successor` and the new owner's reciprocal `predecessor`. Historical messages keep their original addresses and authors.

Trust, blocking and transfer tags are tags used by anagram specifically. NIP-72 approval moderation and NIP-29 are not used. Anyone can read public events; client-side blocking cannot prevent publication through other clients.

## Incoming event recovery

Verified public events are journaled in the account's public-group IndexedDB before processing. Duplicate deliveries merge relay receipts, and messages and actions drain in batches of at most 64 with a yield between batches. Entries are acknowledged only after processing succeeds; a receipt arriving during processing remains pending. Reopening a room resumes its unfinished inbox without requiring the relay to resend those events. Replay does not generate live-message scroll signals.

The journal is independent of history pagination: opening a room still requests a bounded recent page, and older messages load on demand. Background connection/storage failures are indicated in the existing header rather than overlays over the thread. Disk failures still require recovery or a refresh; a committed inbox does not protect against clearing browser storage.
