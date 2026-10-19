# Anagram bots

- [Dad jokes](dad-jokes/README.md): basic DMs, private groups and public groups.
- [Poll bot](poll/README.md): Telegram-compatible inline buttons, private votes and personal results.
- [Telegram bridge](telegram-bridge/README.md): bridge Telegram and Anagram conversations.

Bots run under their own Nostr identity. Invite them to private groups or share a public-group link; interactive public bots must be trusted by the group owner.

For your own buttons, see the [inline keyboard protocol](../docs/bot-keyboards.md). Keep bot keys and data directories private.

## Building a bot (including AI agents)

**Every bot must be standalone:** copying its folder outside this repository must be enough to install and run it. Include its own dependencies and lockfile, `.env.example`, concise setup instructions and any required assets. Node bots must support `npm ci` and `npm start` from their own folder.

Do not import from Anagram's `src/`, sibling bots or parent folders, or rely on the repository's `node_modules`. Bundle needed helpers inside the bot (for example, in `vendor/`, retaining license notices). Verify installation and startup from an isolated copy. Keep changes within the requested bot; do not modify another example to support it. See [agent instructions](AGENTS.md).

## Button rows

The bot chooses the layout: each inner array in `inline_keyboard` is one row. Put buttons in the same array to show them side by side, or separate arrays to stack them. Mixed layouts work too; the limits are 8 rows, 4 buttons per row and 32 buttons total. See [layout examples](../docs/bot-keyboards.md#button-layout).
