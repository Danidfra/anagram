# Anagram inline keyboards (version 1)

This is an Anagram extension, not an assigned NIP or the Telegram Bot API. It uses Telegram's `InlineKeyboardMarkup` shape for **callback and HTTPS URL buttons**. Existing Nostr message kinds, encryption, signatures and group membership rules stay unchanged.

## Send a card

Send an ordinary readable message with this extra event tag (inside the encrypted rumor for DMs/private groups):

```js
['anagram-inline-keyboard', '1', JSON.stringify({
  inline_keyboard: [
    [{ text: 'Vote Tea', callback_data: 'vote:tea' },
     { text: 'Vote Coffee', callback_data: 'vote:coffee' }],
    [{ text: 'Website', url: 'https://example.org' }]
  ]
})]
```

Put the question/options or other useful fallback in `content`. Clients unaware of the extension see ordinary text, without keyboard JSON in the message body. Public cards use the normal kind 9 group messages; only the group's owner/trusted authors get interactive keyboards. Private cards use the normal authenticated kind 14 envelopes. Bots must already be admitted to private groups.

Each button needs `text` and exactly one of `callback_data` or `url`. Limits: 1–64 UTF-8 bytes of callback data, 128 bytes of button text, 8 rows, 4 buttons per row, 32 buttons total and 4 KiB of markup. URL buttons allow HTTPS only, without credentials; they open on an explicit click. Empty `inline_keyboard: []` removes buttons. Unsupported fields or malformed markup invalidate the keyboard, leaving the message text visible. Telegram login, payments, Web Apps, inline-query buttons and arbitrary HTML are not supported.

### Button layout

The bot controls the rows, using the same structure as Telegram: **each inner array is one row**, in display order. Buttons in that array appear side by side. Separate arrays stack vertically, and a keyboard can mix both layouts. This applies to cards and personal follow-up keyboards in all chat types.

Two buttons on one row:

```json
{"inline_keyboard": [[
  {"text": "Yes", "callback_data": "yes"},
  {"text": "No", "callback_data": "no"}
]]}
```

One button per row:

```json
{"inline_keyboard": [
  [{"text": "Yes", "callback_data": "yes"}],
  [{"text": "No", "callback_data": "no"}]
]}
```

Rows are limited to four buttons; the keyboard is limited to eight rows and 32 buttons total. Use short labels for narrow phone screens.

## Receive a callback

Clicks send an **encrypted personal** gift wrap to the card's author, even for public/private group cards. The authenticated inner rumor uses application kind `21118`, empty `content`, one `p` tag for the bot, and:

```js
['anagram-bot', '1', JSON.stringify({
  op: 'request',
  id: '32-lowercase-hex-characters', // random operation ID
  target: {
    type: 'public', // dm | private | public
    chat: '34550:<owner-public-key>:<identifier>',
    root: '<original-card-event-id>',
    version: '<current-card-event-id>',
    bot: '<card-author-public-key>'
  },
  data: 'vote:tea',
  expires: 1790000300
})]
```

For DMs, `chat` is the bot's public key; for private groups it is the stable group public key. `root` and `version` are equal for an unedited card. A replacement must use Anagram's existing message-edit conventions; the new event ID becomes `version`. Clicking a personal follow-up keyboard also sends `view`, the bot answer's rumor ID.

Private-group requests **and answers** additionally include:

```js
membership: { epoch: 3, invited_at: 1790000000, invitation_proof: '<128-hex-signature>' }
```

This is the sender's existing group invitation signature. Verify it against the current epoch using the existing group authorization rules. Do **not** include an epoch key, identity secret or `nsec` in any callback. The proof is carried inside the personal encrypted envelope. Group members can verify it with their existing group credentials.

Authenticate the outer wrap and seal, bind the rumor author to the seal signer, and require exactly one recipient. Never trust an identity supplied in callback data. Check the source author, conversation, current version, expiry and that the button actually exists on the specified card/personal view. Reject blocked users and revoked/conflicted group membership. Public-group policy must still authorize the bot. Requests expire after five minutes.

## Collapsing a handled command

A successful bot card may include `["anagram-bot-command", "1", "<command event ID>"]`. Do not add it to format help or failure replies. Anagram collapses the command only when both messages are loaded in the same chat, the card has a validated callback keyboard, and its timestamp is within five minutes after the command. Group commands must begin with a Nostr mention of the responding bot; display names, incidental mentions and `p` tags alone are insufficient. DMs must be in that bot's conversation. Edited, deleted, reply, attachment and reacted-to commands stay visible.

This is reversible presentation only: neither message is deleted or rewritten, and no history is fetched. The card's menu offers **Show original command** and **Hide original command**. Missing/deleted cards restore the command. Reveal state is local to the open thread; collapse is derived again on reload. A bot cannot use this tag to collapse arbitrary messages or other bot cards.

## Answer privately

Send another authenticated personal gift wrap back to the requesting public key. Its inner kind is `21118`, with one `p` tag for that user. Use the same control tag with `op: 'answer'`, the same `id`, `target` and `expires`, plus the bot's current membership proof for private groups. Put escaped/plain response text in `content` (up to 8,000 characters), and optionally add a keyboard tag for the next menu.

Anagram displays this answer in place of the original card body for the requesting user only. It does not create a timeline message, unread badge or notification. Without a keyboard tag the original buttons remain available; an empty keyboard removes them. A later menu request references this answer via `view`; bots should provide any navigation buttons themselves. Use ordinary messages/edits when a result should be shared with the whole chat.

Persist operation IDs before processing side effects. Deduplicate by authenticated sender + operation ID, reject reused IDs with different request contents, and resend the exact stored response on a retry. Store the effect and reply queue atomically. The poll example demonstrates this: a vote is keyed by public key and repeat votes return results. This is not one-person-one-vote or anonymous voting: the bot operator can read votes.

## Client lifecycle and privacy

Anagram stores up to 500 recent interactions per account in IndexedDB, uses targeted lookups and has no per-card relay subscriptions. Pending requests retain the exact encrypted envelope for explicit **Retry**; a relay acknowledgment is not a bot answer. After expiry, retry creates a new operation, so bots must enforce business-level idempotency too. Answers must match a locally pending request and the current card version. Account switches, blocks, removals and edits invalidate authorization. Late answers cannot overwrite a newer interaction.

Personal results survive reload on the same device. They are not synchronized as personal menus to other devices; clicking there requests fresh results from the bot. Like the existing message cache, locally displayed results are readable in the user's browser storage. On the wire, callbacks/results are encrypted user-to-bot; public card text remains public. Inviting a bot to a private group gives that bot access to the group's messages.

The canonical validators and tag builders are in `src/stores/nostr/botKeyboardProtocol.ts`. Standalone bots must bundle a copy inside their own folder rather than import from the app source; the Node 24 poll example uses `bot-example/poll/vendor/botKeyboardProtocol.ts`. See the [bot example requirements](../bot-example/README.md#building-a-bot-including-ai-agents) and `bot-example/poll` for a working example across all three chat types.
