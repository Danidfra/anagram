# Private groups

Private groups use Nostr NIP-171 (currently in draft) over NIP-17, NIP-44 and NIP-59.

## Identity and membership

- Owner has a master-key created by the owner from which epoch keys are derived.
- New epochs can be triggered by the owner and automatically happen on a user removal.
- The group signs a `kind:1014` ticket for each member: one `p` member tag, one `epoch` tag and the epoch private key as content. Tickets travel inside NIP-59 gift wraps.
- Use the highest valid epoch. 
- Conflicting keys for the same epoch prevent sending until an owner resolves them.
- Owners can restore groups using the master-key.
- One owner per group is recommended. Sharing the master-key grants permanent co-owner access.
- Recovery changes try all configured relays and need one relay to save the complete update. Unavailable replicas do not block a healthy one; known conflicts still require reconciliation.
- Ordinary sending uses locally verified membership and epoch keys. An unavailable relay may hold an unseen newer change.

## Messages

- Members use the direct-message envelope and actions, addressed to the epoch public key.
- Each rumor carries `p` (epoch key), `h` (group identity), `epoch`, `invited_at` and `invitation_proof` (ticket signature).
- Receivers bind the sender to the seal, reconstruct the sender's ticket and verify the group signature. Epoch keys cannot author messages.
- Group-authored `+` / `-` announcements use `member` tags; announcements alone do not grant or revoke access.

## Pinned message

Anagram adds optional `pinned` (rumor event ID) and `pinned_created_at` (Unix timestamp hint) to the group-signed `kind:0` profile. Owners replace or clear the pin. Only the reference is public; message content remains encrypted. Clients resolve it only within that group and the history they can decrypt.

Opening the pin shows a separate preview, just like public groups, without moving the conversation or replacing its loaded message window. Surrounding history is reached by scrolling up normally. Missing pins use the existing targeted encrypted-message recovery.

The full key derivation, recovery format and validation rules are defined in NIP-171.

## History paging

Group epoch keys and group messages have separate lifecycles. Verified tickets
populate the local epoch catalogue and enable current-epoch live delivery; a
newly recovered ticket does not start a message archive scan. The live epoch
listener requests at most 128 recent envelopes at subscription time, with a
two-day lookback, and continues receiving new events normally.

Opening a group requests a bounded recent page. Scrolling up or choosing More
first uses older IndexedDB messages, then requests another remote page when the
local window is exhausted. Each action permits at most six relay requests, with
up to four relays in flight and at most sixteen epoch recipients per filter.
Requests are allocated per relay before queries start, reserving message work
for each scheduled relay. Relay order and extra ticket-discovery slots rotate
between actions so faster replicas cannot starve another relay's older history.
Epoch batches are newest first. A relay finishes its current batch before moving
to older keys. A page normally requests 128 envelopes; crowded timestamp
boundaries can expand up to 4096 so tied events are not silently skipped.

Missing tickets are discovered through pages of gift wraps addressed to the
account. These envelopes also contain direct messages: the relay cannot filter
an encrypted inbox by group or ticket kind. Existing background account-inbox
restoration remains separate; it no longer downloads group epoch archives.
A requested group page rereads the verified catalogue after ticket ingestion and
retries a bounded set of pending ciphertext for those recipients. Undecipherable
envelopes remain in the account's IndexedDB inbox rather than blocking unrelated
messages or being discarded.

Each relay and recipient batch has an independent cursor. Only real EOSE and
committed ingestion advance it. Closures, timeouts and failed writes retain the
cursor for a later user request with backoff. Timestamp boundaries remain
inclusive and the initial message boundary overlaps the visible rumor timestamp
by two days to account for gift-wrap timestamp randomization. Cursors belong to
the selected thread session; reopening rechecks a bounded recent page and relies
on durable message deduplication, not permanent empty-history markers.

Passive missing replies, reactions and pins do not trigger group archive scans.
Explicitly opening a missing reference uses its own bounded history request, so
it cannot move the thread's paging cursor. Thread/account switches cancel active
queries. The UI preserves the visible message anchor while older rows arrive and
shows key recovery, message loading or retry status.
