# Anagram

Anagram is a SvelteKit 3 / Svelte 5 frontend and Tauri 2 desktop app. It uses nostr-tools and IndexedDB; no application backend is required.

## Run

Use Node 22.17+ (Node 24 recommended) and npm.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Browser login supports private keys, NIP-07 extensions, and NIP-46 remote signers.

For desktop development, install Rust and the Tauri platform prerequisites, then run:

```sh
npm run dev:desktop
```

On this NixOS machine, the supplied development shell includes GTK, WebKitGTK, D-Bus, OpenSSL, and the native compiler tools:

```sh
nix-shell shell.nix --run 'npm run dev:desktop'
nix-shell shell.nix --run 'npm run build:desktop -- --no-bundle'
```

`npm run build` produces the static web application in `build/`. Configure web hosting to serve `index.html` for unknown paths. Desktop bundles are produced by `npm run build:desktop` on the target operating system.

## Runtime

- The interface is Svelte. The original protocol, persistence, and call state machines have been retained and adapted. The standalone `@vue/reactivity` package supports their internal state; Vue components, Pinia, Quasar, Electron and NDK are not runtime dependencies.
- `src/lib/nostr/client.ts` uses nostr-tools for relay transport, signatures, NIP-04/NIP-44 encryption, NIP-59 gift wraps, NIP-05 resolution, and NIP-46 signers. No NDK package is used.
- `src/stores/nostr/` preserves Anagram's message, contact, group epoch, membership, relay coverage, retries, edits, reactions, deletion and call-signalling semantics. Protocol notes are in `nips/`.
- IndexedDB stores messages, summaries, contacts, event delivery state, image cache, diagnostics and pending encrypted ingestion. Tauri private-key login uses the operating system credential store. Browser private-key login retains the original browser-local key storage behavior.
- Calls retain the original Iroh WebAssembly transport, direct audio/video calls and group rooms. Camera/microphone/output selection, screen sharing, room links and call history are connected to the Svelte interface. Media support depends on the target webview's codecs and capture APIs.

## Large histories

The chat list opens from saved conversation summaries. It does not scan message history. Initial thread hydration loads a bounded page; author grouping cannot expand that page into an entire conversation. Language catalogs load on demand. At most 300 messages per thread and six recently loaded threads remain hydrated.

Incoming encrypted events first enter an account-scoped IndexedDB inbox. Verified DMs enter reactive UI state before their message writes. Verification runs ahead of ordered background commits, with at most eight uncommitted messages; foreground work has priority and the main thread yields between events. Failed writes retain the encrypted inbox records for retry. Local-key decryption and signature checks run in a worker. Interrupted queues resume after session initialization. Logout terminates the worker and clears stored queues.

Pagination uses the chat/timestamp index with primary-key tie breaking. Search yields between batches. Selecting a search result reads a small window around its indexed position. Read-state reconciliation uses batches, and edit/reaction references have dedicated indexes. Schema version 3 upgrades existing rows without loading the whole history into JavaScript memory.

Startup discovers both kind-10002 general relays and kind-10050 DM inbox relays. Diagnostics are opt-in, omit decrypted event payloads, and redact keys; upgrading the diagnostics database clears legacy traces. Browser key storage remains the original plaintext localStorage behavior, so browser-profile access grants access to that key.

Historical relay coverage advances only after a relay's actual EOSE and successful ingestion. A timeout is not evidence that a relay's history is complete.

## Verify

```sh
npm run quality:all
npm run test:unit
npx playwright install chromium
npm run test:e2e:local
npm run build
```

On NixOS, use the installed system browser:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome npm run test:e2e:local
```

To include real Iroh audio/video and room transport using synthetic media devices:

```sh
ANAGRAM_LIVE_CALL_TEST=1 npm run test:e2e:local -- e2e/parity/calls.spec.ts e2e/calls.spec.ts
```

These optional tests require a real Iroh relay on `127.0.0.1:7003` and `openssl` on PATH (or the `OPENSSL` environment variable pointing to its executable). Playwright starts its own TLS proxy on port 7004 and an isolated application on port 5187. On NixOS, also set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` as above. They verify direct audio/video, screen streams, presentation mirroring, room mute propagation, active-speaker selection, invitation privacy, and mobile layout between isolated browser accounts. They do not access your physical camera or microphone.

The migration map in [e2e/parity/coverage.json](e2e/parity/coverage.json) maps every original E2E spec to its replacement. Restricted history controls are replaced by unlimited background history checks; relay authentication, recovery, UI-before-storage, and bounded database paging remain covered. The port adds real NIP-07 and NIP-46 signing exchanges, DM and group lifecycle, read-state, repair, relay traffic, and session isolation checks. Live call tests remain opt-in and must pass separately.

Browser tests use generated test accounts and a local signature-verifying relay. They exercise encrypted DMs between two accounts, reactions, edits, reload, group invitations/messages, responsive navigation, language preferences, and a 20,000-message cached account with bounded rendering and indexed search jumps. Unit tests cover the preserved protocol behavior plus gift-wrap interoperability, durable ingestion and database migration.

Actual microphone/camera/screen capture, end-to-end Iroh media across machines, OS credential-store prompts, external signers and platform installers require target-device acceptance testing. The rebuilt screens follow the original assets, colors, typography and split/mobile layouts; exhaustive pixel-by-pixel parity across every source dialog has not been certified.

To measure NIP-17 hydration against a generated 20,000-message account:

```sh
ANAGRAM_PERF_TEST=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/google-chrome npm run test:e2e:local -- e2e/dm-performance.spec.ts
```

The benchmark reports read-cursor cost, time to the first reactive chat preview, durable throughput for 128 independently wrapped DMs, database transactions, cursor steps, and event-loop heartbeat delays. It exercises the production ingestion path with generated ciphertext; relay latency is excluded. Timings are machine-dependent diagnostics, not a cross-client ranking. The test attaches its JSON report without keys or message contents.

Hydration uses worker decryption, a durable encrypted inbox with writes batched up to 64, and at most eight staged messages awaiting ordered commits. Live traffic preempts historical pages. Indexed reply, author, date and reaction lookups avoid unrelated history during normal ingestion and read-state reconciliation. IndexedDB upgrades add indexes atomically and may take extra time on the first launch of an existing account.

## Installable web app (PWA)

```sh
npm ci
npm run build
npm run preview
```

PWA installation and offline caching are enabled in production builds, not `npm run dev` or native Tauri windows. Open the preview URL on localhost to test. Deploy the contents of `build/` at the **root of an HTTPS origin**; configure unknown frontend routes (such as `/chats/<key>`) to serve `index.html`. Serve JavaScript with a JavaScript MIME type and `.wasm` as `application/wasm`. Serve `/service-worker.js`, `/index.html`, `/manifest.webmanifest`, and `/build-info.json` with `Cache-Control: no-cache`; hashed `/_app/immutable/` files can be cached immutably. Keep the previous deployment's hashed files available during a rollout.

Chrome/Edge offer an install control (including Anagram's install prompt when supported). On iPhone/iPad use Safari → Share → Add to Home Screen. After the first successful load/cache installation, the application shell and already saved history can reopen offline. Unfetched messages, relay synchronization and calls still require connectivity. This does not add push delivery while the app is closed.

Only the deployment's public scripts, styles, fonts, icons and call runtime are precached. Messages, keys, remote pictures and attachments are not put into the service worker cache. Existing account storage behavior remains unchanged. Updates wait for open Anagram windows to close, avoiding unexpected reloads during calls or while composing. Settings → Force refresh can explicitly reload the web app when online while preserving message storage.

If an older deployment shows `ERR_FAILED` on normal visits but works after a hard refresh, deploy the updated worker, hard-refresh once, and wait for the update-ready notice. Close all Anagram tabs/windows, then reopen to activate it. There is no need to clear site data or IndexedDB. The worker supports hosts that redirect `/index.html` to `/index` (such as `serve`): it removes cached redirect metadata when serving navigation responses and falls back to the network if Cache Storage is unavailable.

Production PWA checks:

```sh
npm run build
npm run test:e2e:pwa
```

The implementation follows [SvelteKit's service worker lifecycle](https://svelte.dev/docs/kit/service-workers).

## Tagged desktop releases

Commit the source and push a version tag, for example `v0.9.1` (or `v0.9.1-beta.1`). `.github/workflows/release.yml` runs checks, then builds:

| Runner/target | Release asset |
| --- | --- |
| Windows x64 | NSIS setup `.exe` |
| macOS Apple Silicon | ARM64 `.dmg` |
| macOS Intel | x64 `.dmg` |
| Linux x64 (Ubuntu 22.04 build base) | `.AppImage` |
| Static web app | `anagram-web.zip` |

The release is published only after every desktop job succeeds, with `SHA256SUMS.txt`. Prerelease tags produce GitHub prereleases. Failed jobs leave workflow artifacts for inspection; rerunning uploads replacements to the same release. No automatic in-app desktop updater is configured.

CI derives the application version from the tag in its disposable checkout: npm package/lock, Tauri config and the app's Cargo manifest/lock stay aligned. The Iroh library version is independent. You can align versions locally with `npm run release:version -- v0.9.1`, then review and commit those changes before tagging. The workflow uses the repository's `GITHUB_TOKEN`, so no personal access token is needed. GitHub Actions must be allowed to create releases (`contents: write` is scoped to the final publishing job).

Installers are unsigned unless signing is configured. Windows unsigned installers may show SmartScreen warnings. For signed/notarized macOS DMGs, add repository Actions secrets `APPLE_CERTIFICATE` (base64 Developer ID certificate), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), and `APPLE_TEAM_ID`. Unsigned macOS builds are suitable for testing but will face Gatekeeper restrictions. See [Tauri's GitHub build guide](https://v2.tauri.app/distribute/pipelines/github/) and [macOS signing setup](https://v2.tauri.app/distribute/sign/macos/). Signing credentials must not be committed.

Windows and macOS installers must be built/validated on their respective runners. Passing web tests or Linux `cargo check` does not verify those installers.

## What belongs in Git

Commit the source (`src/`, `src-tauri/src/`, `iroh-calls/src/`), tests, workflows/scripts, configuration, protocol/docs/license files, `static/`, icons, `package.json` **and `package-lock.json`**, both Cargo manifests **and Cargo lockfiles**, and `.node-version`/`shell.nix`. Commit intentional removals of the old Quasar/Electron/Capacitor files as part of the migration too; Git history retains the original implementation.

Do **not** commit `node_modules/`, `.svelte-kit/`, `build/`, `dist/`, any Rust `target/`, `src-tauri/gen/`, test reports, coverage, logs, local `.env` files, or signing certificates/keys. `.gitignore` excludes these. `npm ci` recreates Node dependencies; `npm run build` regenerates the web output; Tauri/Cargo regenerate native build output and schemas. Installers belong in release assets, not Git.

One deliberate exception: keep the small generated `static/iroh/` JS/Wasm bindings, type declarations, hash manifest and license notices committed alongside their Rust source. This lets a normal web checkout run with Node alone, without compiling the Iroh Rust transport. `npm run verify:iroh` checks their hashes and runs in CI. Transport changes must update the generated bindings and manifest together.

After pulling, use `npm ci` then `npm run dev` for web development. Desktop development additionally needs Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Generated files do not need to be copied from another developer's machine.

## Security review (2026-10-06)

This was a source review and automated regression audit of the `brutal` rebuild, using generated test identities. It does not establish whether an older deployment or a user's device has ever been compromised. No real account keys were read or exported for the audit.

The fixes restrict native keychain commands to the trusted main webview, reject external navigation in that window, serialize keychain operations and discard stale completions after logout. Signer encryption/decryption/signing failures and malformed decrypted JSON no longer expose third-party exception payloads. Incidental signer JSON serialization contains only public identity; explicit NIP-46 session persistence remains supported. Diagnostics redact entire hex/nsec keys, credential-bearing field names, URL credentials/query strings and parser snippets before storage/export; upgrading clears the old diagnostic store only. Public profile search rejects nsec/pairing strings and the current locally held hex private key. Arbitrary hex strings cannot generally be distinguished as public or private keys, so use npub/nprofile for public searches.

Production static HTML includes a hash-based Content Security Policy that blocks injected inline scripts, remote scripts, objects and base-URL changes, while permitting the app's own scripts, WebAssembly, workers and encrypted relay connections. The document uses `no-referrer`. Browser tests serve the actual `build/` output, verify these protections, and check generated nsec/hex keys and decrypted DM text are absent from captured HTTP requests and WebSocket frames. Test hooks are not installed in production. Deployment hosts should additionally send `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors 'none'` headers; frame restrictions cannot be enforced by a CSP meta tag.

Remaining privacy boundaries:

- Browser/PWA private-key login deliberately retains the original plaintext localStorage behavior previously requested. IndexedDB also contains decrypted chat history. Device/profile access or a compromised same-origin script can read that data. Use a dedicated origin and NIP-07/NIP-46 if you do not want the account nsec held by the web app. NIP-46 still stores a sensitive local connection credential; the remote signer controls its permissions and revocation.
- Tauri stores the account key in the OS keychain, but an unlocked session uses it in frontend memory. This review does not certify OS keychain prompts or installer security across platforms.
- Account creation's explicit secret download intentionally creates a plaintext backup file. It is not a network upload.
- Blossom media uploads are **not encrypted by this client**: the selected media host receives the file, while its link travels in an encrypted DM. Relays receive encrypted DM envelopes and public routing metadata. Remote image hosts can observe requests/IP addresses. No background telemetry service was found in the reviewed application source.
- The VPS operator controls the JavaScript delivered to browsers. HTTPS and CSP do not protect against a compromised deployment that replaces the application itself. Legacy `?bunker=...` login links also send the connection token to the web host in the initial request, where access logs may retain it; removing the query after startup cannot undo that. Paste the connection string into the signer form to avoid putting it in the page URL.

`npm audit` reported zero advisories at review time. Cargo audit reported no entries in its vulnerability category, but it did report the upstream [GLib iterator unsoundness advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) in Tauri's GTK dependency tree, plus unmaintained [proc-macro-error](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) and [paste](https://rustsec.org/advisories/RUSTSEC-2024-0436.html) dependencies. GLib's published fix is in 0.20+, while this Tauri/GTK tree requires 0.18; it cannot be fixed by a compatible lockfile-only update. Anagram does not directly call the affected iterator. This remains an upstream dependency risk, not a clean security certificate. The checked-in Iroh Wasm hash manifest was verified; auditing its Cargo lockfile does not prove binary/source reproducibility.

CI and release checks now run `npm audit --audit-level=high`. Repeat the native dependency checks with `cargo audit --file src-tauri/Cargo.lock` and `cargo audit --file iroh-calls/Cargo.lock`. Keep the operating system, browser/WebView, dependencies and hosted build updated.
