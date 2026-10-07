NIP-171
=======

Epoch-Ticketed Private Groups
-----------

`draft` `optional` `client`

This NIP defines a private group messaging scheme built on top of NIP-17 in which members prove posting rights for the current epoch by presenting an epoch ticket. A ticketed group is represented by a stable group identity keypair and a rotating epoch keypair shared by the current members.

Ticketed groups are designed for conversations in which posting requires a valid epoch ticket and holders of a group recovery master control membership.

## Terms

- **group identity**: a dedicated keypair that represents the group as a Nostr account.
- **group owner**: a holder of the group recovery master. Several accounts may share ownership.
- **epoch number**: a monotonically increasing non-negative integer that identifies a group epoch.
- **group epoch**: the current membership version of the group, identified by an epoch number and an epoch keypair.
- **epoch keypair**: a keypair shared by the current members of a group epoch. Its public key is the recipient of NIP-17 gift wraps for that epoch.
- **epoch ticket**: a `kind:1014` invitation that conveys the current epoch number and epoch private key to one member.
- **current epoch ticket**: the valid `kind:1014` invitation a client uses for itself for a given group identity, selected according to the rules below.

Control of the recovery master grants group identity signing authority and derivation of every recorded epoch key. How the owner proves a relationship between the group identity and any other Nostr account is out of scope.

## Group Identity

Each ticketed group has exactly one group identity and exactly one current group epoch.

The group identity:

- MAY publish `kind:0` metadata like any other account.
- MAY publish `kind:10050` to advertise preferred relays for receiving group messages.
- MUST be kept secret by the group owner.

This NIP suggests that NIP-24 could define a `group` boolean metadata field for `kind:0` profiles, analogous to the existing `bot` field, so a group identity can explicitly declare itself to be a group.

The epoch keypair:

- MUST be derived by a group owner using the recovery scheme below.
- MUST be distributed only to current members.
- MUST NOT be used as an author identity.
- MUST be rotated whenever a member is removed.
- SHOULD be rotated whenever a member is added if the owner wants to prevent that new member from reading earlier messages still stored for the old epoch.

Clients MUST ignore any message whose effective sender pubkey is equal to a known epoch public key.

## Kind `1014`: Epoch Ticket

`kind:1014` is a regular event signed by the group identity key. Each epoch ticket targets exactly one member and conveys the current epoch number and epoch private key.

The event has the following form:

```jsonc
{
  "id": "<computed according to NIP-01>",
  "pubkey": "<group-pubkey>",
  "created_at": "<unix timestamp>",
  "kind": 1014,
  "tags": [
    ["p", "<member-pubkey>"],
    ["epoch", "<non-negative decimal integer>"]
  ],
  "content": "<32-byte lowercase hex epoch-private-key>",
  "sig": "<signature by the group private key>"
}
```

The `kind:1014` event:

- MUST contain exactly one `p` tag naming the invited member.
- MUST contain exactly one `epoch` tag whose value is a non-negative decimal integer.
- MUST contain the current epoch private key in `content`, encoded as 32-byte lowercase hex.
- MUST be signed by the group identity private key.
- MUST be delivered to the invited member inside a NIP-59 gift wrap.
- All valid `kind:1014` tickets for the same group epoch MUST use the same `epoch` tag value and the same epoch private key.
- When creating a new epoch keypair, the group owner MUST use an epoch number greater than any previously used epoch number for that group identity.
- The initial epoch number SHOULD be `0`.

Clients SHOULD treat the `pubkey` of a valid `kind:1014` event as the stable identity of the group and MAY display the group as a regular chat thread.

For a given group identity, the current epoch ticket for the local user is the valid `kind:1014` addressed to that user with the highest epoch number. If multiple tickets share that highest epoch number and the same epoch private key, clients SHOULD prefer the one with the greatest `created_at`. If they still tie, clients SHOULD prefer the lexicographically lowest event `id`.

If two valid tickets for the same group identity and epoch number contain different epoch private keys, clients MUST treat that epoch as inconsistent and MUST NOT use it for sending new messages. Clients MAY retain the independently verified keys for historical recovery. An owner must reconcile the conflicting management revisions and issue tickets for a higher epoch before sending resumes.

## Sending Group Messages

A current member MAY send messages to the group using NIP-17.

By convention, `kind:14`, `kind:15`, and `kind:7` rumors may be used, following NIP-17. The message MUST be addressed to the current epoch public key, not to the group identity public key.

The inner rumor event:

- MUST be unsigned, as required by NIP-59.
- MUST contain exactly one `p` tag naming the current epoch public key.
- MUST contain exactly one `h` tag whose value is the group identity public key.
- MUST contain exactly one `epoch` tag whose value is the sender's current epoch number.
- MUST contain exactly one `invited_at` tag whose value is the `created_at` of the authors's latest epoch ticket.
- MUST contain exactly one `invitation_proof` tag whose value is the `sig` of the authors's latest epoch ticket.

Example rumor tags:

```jsonc
[
  ["p", "<epoch-pubkey>"],
  ["h", "<group-pubkey>"],
  ["epoch", "<epoch from sender kind:1014>"],
  ["invited_at", "<created_at from sender kind:1014>"],
  ["invitation_proof", "<sig from sender kind:1014>"]
]
```

The wrapping rules are the same as in NIP-17 and NIP-59, with these constraints:

- the `kind:13` seal MUST keep `tags` empty.
- the `kind:1059` gift wrap MUST have a `p` tag naming the current epoch public key.
- clients SHOULD publish the gift wrap to relays advertised by the group identity's `kind:10050` event, when available.

## Receiving Group Messages

To receive messages for a group, clients MUST listen for NIP-59 gift wraps addressed to the epoch public key from the highest valid current epoch ticket they have for that group.

After unwrapping a message, clients MUST:

1. verify the NIP-17 sender binding by checking that the `pubkey` on the `kind:13` seal matches the `pubkey` on the inner rumor.
2. if the sender pubkey equals the group identity public key, validate and interpret the message according to the Announcements section.
3. otherwise, verify that the rumor contains exactly one `p`, `h`, `epoch`, `invited_at`, and `invitation_proof` tag as defined above.
4. verify that the rumor `p` tag equals the current epoch public key for the group.
5. verify that the rumor `h` tag equals the group identity public key for that group.
6. verify that the rumor `epoch` tag equals the current epoch number for the group.
7. rebuild the sender's epoch ticket using the current epoch number and epoch private key known locally:

```jsonc
{
  "id": "<computed according to NIP-01>",
  "pubkey": "<group-pubkey>",
  "created_at": "<invited_at>",
  "kind": 1014,
  "tags": [
    ["p", "<sender-pubkey>"],
    ["epoch", "<current epoch number>"]
  ],
  "content": "<current epoch-private-key hex>",
  "sig": "<invitation_proof>"
}
```

8. verify the rebuilt `kind:1014` signature against the group identity public key.

If that signature is valid, the sender has possession of a valid epoch ticket for the current epoch and is therefore a current member of the group. If validation fails, the event MUST be dropped.

Messages from the group identity public key that do not match the Announcements section SHOULD be ignored.

Clients MUST use only the epoch public key from the highest valid epoch number for receiving new messages. Messages addressed to older epoch public keys SHOULD be treated as historical data from earlier epochs and SHOULD NOT be mixed into the current writable epoch.

## Announcements

The group identity MAY send a NIP-17 `kind:14` message to announce joins or leaves.

An announcement message MUST:

- contain exactly one `p` tag naming the current epoch public key.
- contain one or more `member` tags naming affected member public keys.
- contain exactly one `h` tag whose value is the group identity public key.
- contain exactly one `epoch` tag whose value is the current epoch number.
- use content exactly equal to `+` or `-`.
- SHOULD NOT contain `invited_at` or `invitation_proof` tags.

Content `+` means the `member` pubkeys joined the group. Content `-` means the `member` pubkeys left the group.

Announcements are non-authoritative. They do not grant membership, revoke membership, or prove current access by themselves. Membership is determined by the current epoch ticket and epoch rotation rules.

Clients MAY display these announcements however they see fit.

## Group Management

The group owner creates a group by generating a recovery master and deriving the group identity and initial epoch keypair as specified below, then issuing `kind:1014` epoch tickets for the initial epoch to the initial members.

When removing a member, the owner:

1. MUST derive a fresh epoch keypair using a new epoch revision and the recovery master.
2. MUST choose an epoch number greater than any previously used epoch number for that group identity.
3. MUST issue a new `kind:1014` epoch ticket to each remaining member.
4. MUST stop using the previous epoch public key for new messages.

Removing a member does not revoke messages already delivered to that member, nor does it prevent that member from revealing them later.

If compromise of the current epoch key is suspected, the owner SHOULD immediately create a new epoch and redistribute epoch tickets to the intended members.

## Membership Requests

Users MAY send NIP-17 direct messages to the group identity public key to request membership changes.

A join request:

- MUST be sent to the group identity public key, not to the epoch public key.
- MUST use NIP-17.
- MUST use content exactly equal to `+`.

A leave request:

- MUST be sent to the group identity public key, not to the epoch public key.
- MUST use NIP-17.
- MUST use content exactly equal to `-`.

These requests are advisory only:

- a join request does not grant membership by itself.
- a leave request does not remove the sender by itself.
- only the group owner changes membership, by issuing or withholding a `kind:1014` epoch ticket and by rotating the epoch when removing a member.

Clients MAY present these requests as explicit join or leave actions instead of ordinary chat messages.

## Recovery master and deterministic keys

This revision replaces independent random group identity and epoch keys. It does not
change the `kind:1014` ticket, NIP-17 message, or invitation-proof formats above.

One group uses one independent 128-bit entropy value, generated by a cryptographically
secure random generator. Encode it as a 12-word English BIP-39 mnemonic, including
its checksum. Normalize mnemonic input using NFKD and whitespace normalization.
Reject invalid checksums and word counts. Do not reuse a personal account or wallet
recovery phrase. This version uses an empty BIP-39 passphrase; an additional hidden
passphrase is not supported.

Compute the 64-byte BIP-39 seed using PBKDF2-HMAC-SHA512 (2048 rounds), then derive
32-byte scalars with HKDF-SHA256:

- IKM: the BIP-39 seed bytes.
- Salt: UTF-8 `nip171/group-recovery/v1`.
- Identity info: UTF-8 `identity/<counter>`.
- Epoch info: UTF-8 `epoch/<epoch-number>/<epoch-revision>/<counter>`.
- Counter starts at decimal `0`; increment and rederive only if the output is not
  a valid secp256k1 private scalar. Do not reduce outputs modulo the curve order.
- Epoch numbers and counters use unsigned decimal with no leading zeroes except
  `0`. Epoch numbers MUST be safe integers in the range 0 through 2^53 - 1.
- Revisions are 32-byte lowercase hex. The initial epoch revision is 64 zeroes.
  Each rotation generates a fresh cryptographically random epoch revision.

Identity and epoch derivations are independent. Never distribute the master,
BIP-39 seed, or an extended parent key in a member ticket. A member receives only
the epoch scalar, and cannot derive sibling keys or the master from it. Ordinary
additions retain the current epoch as before; removals and explicit rotations
advance its number and choose a fresh epoch revision.

The revision input prevents two concurrent owners rotating the same epoch number
from distributing the same key to different membership sets. It is recoverable
metadata, not an additional backup secret. A seed alone can recreate the identity;
recorded epoch descriptors are required to identify all used epoch keys.

### Test vector

Entropy: `00000000000000000000000000000000`.
Mnemonic: `abandon` eleven times followed by `about`.
Empty passphrase. Counter zero for each output:

- Identity private key: `13d184e4bcb80ec9e3e9e474783e5c33708154e48c3e75fca524a79966211111`.
- Epoch 0, revision of 64 zeroes: `15bb3fbeafd0839896fe006fee52cc18e69fbc9054fa7c29e3c8033f1cda3b34`.
- Epoch 1, revision of 64 `b` characters: `72c9245b9ab372a58354804295a5b6b5a5ab366ba37787de056294f468902a29`.

## Encrypted recovery journal

Publish each management revision as a group-signed NIP-78 `kind:30078` event:

```jsonc
{
  "pubkey": "<group-pubkey>",
  "kind": 30078,
  "tags": [
    ["d", "anagram-group-recovery-v1:<management-revision>"],
    ["t", "anagram-group-recovery-v1"]
  ],
  "content": "<NIP-44 encrypted state, group identity encrypted to itself>"
}
```

The decrypted state contains:

```jsonc
{
  "version": 1,
  "revision": "<unique 32-byte management revision hex>",
  "epoch_revision": "<32-byte epoch derivation revision hex>",
  "epoch": 0,
  "parents": ["<preceding signed recovery-event id>"],
  "members": ["<current member pubkey>"],
  "owners": ["<known master-holder account pubkey>"],
  "relays": ["wss://group-relay.example/"],
  "name": "Group name",
  "about": "Group description"
}
```

The genesis management revision and epoch revision are both 64 zeroes, its epoch
is zero, and it has no parents. Every later management change has a fresh random
management revision and references its preceding state. A membership addition
may keep the same epoch and epoch revision. An epoch change MUST increase the
number and choose a fresh epoch revision. Never rewrite an existing management
revision or delete its recovery record. Despite the replaceable event kind,
each distinct revision has its own `d` tag and is treated as write-once.

Owners MUST verify signatures, group authorship, the `d` tag binding, complete
parent references, and epoch ordering. Recovery readers MUST preserve every
branch, not choose a state only by event timestamp. Unknown versions and invalid
records fail recovery. Fetch records in bounded pages and use actual EOSE as
coverage evidence; a timeout is not an empty successful response.

The master itself never appears in this journal, including inside its ciphertext.
Publishing the master encrypted under one of its own derived keys is forbidden.
Group membership, known owners, and relay hints are inside encrypted content.

### Initial relay selection

Before a new group has a recovery journal, treat account relays as candidates rather
than mandatory group relays. Check for an existing journal on responding candidates;
if one exists, use restoration instead of overwriting it. Select only relays that
complete real EOSE reads, acknowledge a group-signed NIP-78 capability record, and
return that exact record in a subsequent read. The capability record uses a separate
`d` and `t` from journal revisions and contains no master or epoch keys. Publish the
genesis journal with the selected relay set and use that set for group relay lists,
backups, and invitations. Do not install a group when no suitable relay is available.
Once the journal exists, availability failures MUST NOT silently shrink its relay
set; use the management and relay-migration rules below.

### Concurrent owners and publication failures

Before editing membership, fetch the full recovery graph from each configured
recovery relay. Refuse the operation if coverage is incomplete or the observed
head differs from the state the owner reviewed. Serialize writes per account and
group, including across tabs. Publish and obtain acknowledgements for the new
record on every recovery relay before sending its epoch tickets. Recheck the graph
before ticket delivery. Partial publication is a pending update, not permission
to distribute its key; refresh recovery to resume.

A head is a record not referenced as a parent by another known record. Multiple
heads indicate a conflict. Do not silently select a winner. Reconciliation is an
explicit owner action that references all known heads, uses an epoch number above
all of them, chooses a fresh epoch revision, and initially retains only members
present in every head. The owner may then explicitly re-add intended members.
This prevents an unrelated stale addition from automatically undoing a removal.

When moving group relays, copy the original signed journal records to every new
relay before publishing a new management revision. Publish that revision on both
the previous and new relay sets, so older backup files can discover the move.
Refresh/repair must also replicate partially published records before resuming
management. Do not regenerate old events with new IDs while copying history.

Nostr relays do not provide global consensus or atomic compare-and-swap. These
rules detect observed conflicts and prevent reuse of a key across independent
rotations; they cannot prove that an unavailable, dishonest, or partitioned relay
has no unseen update. Revocation is effective once clients observe the new epoch.
Do not claim instantaneous global revocation or protection against malicious
holders of the master. Applications requiring those guarantees need a different
coordination and authority protocol.

The `owners` list records known holders for UI and accidental-removal protection;
it is not an access-control list. An unrecorded holder of the master has the same
cryptographic authority. Importing ownership does not implicitly add the account
to message membership. Joining with the current account is explicit.

### Master replacement

An owner cannot be revoked while the old master and identity remain authoritative.
To remove a master holder, create a new group identity from fresh entropy, verify
its new backup, and invite only the intended remaining members. Keep the old thread
for historical reading. Share the new master separately with the owners who should
retain authority. A normal member-removal operation MUST NOT claim to revoke a
master holder. A replacement group is a new identity; do not silently redirect
members based on an old-group signature that the removed owner could also produce.

## Backup and restore

Before initial creation or master replacement, display the 12 numbered words,
provide a private recovery-file download, and verify randomly selected words from
the saved backup. A downloaded file is plaintext secret material and MUST be
clearly labelled private. Do not log phrases or include them in diagnostics,
public metadata, URLs, or service-worker caches.

An Anagram recovery file has `format: "anagram-group-recovery"`, `version: 1`,
`phrase`, `recovery_key` (the 16-byte entropy in lowercase hex), `group_pubkey`, and
`relays`. On import, verify the checksum and that both key representations and the
derived public key agree. The relay URLs are hints, not authority.

Restore derives the identity, discovers group relay lists where available, verifies
and decrypts the journal, derives every recorded epoch, and feeds existing bounded
message-history hydration. Never reset a missing journal to epoch zero. Explain
missing relays and incomplete state separately from an invalid phrase. Relays or
an independent message backup must still hold the messages: key recovery cannot
recreate deleted ciphertext.

A client MAY additionally save the master under the signed-in user's NIP-44
self-encryption in its existing NIP-78 account backup, with `d` equal to the group
public key and `t` equal to `group`. Version 2 encrypted account payloads contain
`group_pubkey`, derived `group_privkey`, `recovery_entropy`, `recovery_state_id`,
`recovery_state`, and the current `epoch_number` / derived `epoch_privkey`.
Verify every derived value before accepting it. Store only encrypted secrets in
IndexedDB. This account backup is a convenience; seed recovery must not require
the original account private key.

Master compromise exposes all recorded past epochs and future epochs under that
master. Ordinary epoch rotation cannot repair it. This recovery scheme deliberately
provides no forward secrecy against compromise of the recovery master.

## Relay Behavior

This NIP does not require new relay-side semantics beyond NIP-17 and NIP-59.

Relays that already protect access to `kind:1059` events SHOULD apply the same protections to gift wraps addressed to epoch public keys.

## Security and Limitations

- Ticketed groups trust every holder of the recovery master.
- Any current member can delegate live read access to outsiders by leaking their current epoch ticket. An outsider with that ticket can decrypt group messages until the epoch is rotated.
- Any member can reveal messages they were able to decrypt while they were a member.
- Membership changes only affect future epochs after rotation.
- If the owner adds a member without rotating the epoch, that member may be able to read older messages still available on relays for that epoch.
- Sharing the master gives permanent co-owner authority; a member removal cannot revoke it. See Master replacement above.
