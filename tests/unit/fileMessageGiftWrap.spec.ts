import NDK, { giftUnwrap, giftWrap, NDKPrivateKeySigner, NDKUser } from '@nostr-dev-kit/ndk';
import { createMessageEventRuntime } from 'src/stores/nostr/messageEventRuntime';
import type { MessageAttachmentMetadata } from 'src/types/chat';
import {
  buildNip17FileMessageTags,
  FILE_MESSAGE_KIND,
  parseNip17FileMessageAttachment,
} from 'src/utils/messageAttachments';
import { describe, expect, it } from 'vitest';

// Exercises the real NDK seal + gift-wrap path with the app's rumor builder, so a kind 15 file
// message is proven to survive wrapping for the recipient, the sender's self-copy, and a group
// epoch key without being rewritten as kind 14 or losing its decryption tags.
describe('NIP-17 kind 15 gift wrapping', () => {
  const attachment: MessageAttachmentMetadata = {
    type: 'media',
    url: `https://blossom.example.com/${'c3'.repeat(32)}`,
    mimeType: 'image/webp',
    size: 4096,
    sha256: 'c3'.repeat(32),
    encryption: {
      algorithm: 'aes-gcm',
      key: 'a1'.repeat(32),
      nonce: 'b2'.repeat(12),
      originalSha256: 'd4'.repeat(32),
    },
  };

  function createRuntime(ndk: NDK, signer: NDKPrivateKeySigner) {
    return createMessageEventRuntime({
      decryptPrivateStringContent: async () => null,
      derivePublicKeyFromPrivateKey: () => null,
      findGroupChatEpochContextByRecipientPubkey: async () => null,
      getOrCreateSigner: async () => signer,
      ndk,
      readEpochNumberTag: () => null,
      readFirstTagValue: () => null,
    });
  }

  it.each([
    ['recipient', 'recipient'],
    ['self copy', 'sender'],
    ['group epoch key', 'epoch'],
  ])('keeps kind 15 and its file tags when wrapped for the %s', async (_label, target) => {
    const ndk = new NDK();
    const sender = NDKPrivateKeySigner.generate();
    const recipient = NDKPrivateKeySigner.generate();
    const epoch = NDKPrivateKeySigner.generate();
    const unwrapSigner = target === 'sender' ? sender : target === 'epoch' ? epoch : recipient;
    const senderUser = await sender.user();
    const unwrapUser = await unwrapSigner.user();
    const runtime = createRuntime(ndk, sender);

    const rumor = runtime.createDirectMessageRumorEvent(
      senderUser.pubkey,
      (await recipient.user()).pubkey,
      attachment.url,
      1_780_000_000,
      'e'.repeat(64),
      buildNip17FileMessageTags(attachment),
      FILE_MESSAGE_KIND
    );
    const wrapped = await giftWrap(rumor, new NDKUser({ pubkey: unwrapUser.pubkey }), sender, {
      rumorKind: FILE_MESSAGE_KIND,
    });
    wrapped.ndk = ndk;

    expect(wrapped.kind).toBe(1059);
    expect(wrapped.content).not.toContain(attachment.encryption?.key ?? 'missing');
    expect(JSON.stringify(wrapped.tags)).not.toContain('decryption-key');

    const unwrapped = await giftUnwrap(wrapped, undefined, unwrapSigner);

    expect(unwrapped.kind).toBe(FILE_MESSAGE_KIND);
    expect(unwrapped.pubkey).toBe(senderUser.pubkey);
    expect(unwrapped.content).toBe(attachment.url);
    expect(unwrapped.tags).toContainEqual(['e', 'e'.repeat(64), '', 'reply']);
    expect(parseNip17FileMessageAttachment(unwrapped.content, unwrapped.tags)).toEqual({
      type: 'media',
      url: attachment.url,
      mimeType: 'image/webp',
      size: 4096,
      sha256: attachment.sha256,
      encryption: attachment.encryption,
    });
  });

  it('documents that NDK rewrites the rumor kind to whatever rumorKind is passed', async () => {
    const ndk = new NDK();
    const sender = NDKPrivateKeySigner.generate();
    const recipient = NDKPrivateKeySigner.generate();
    const runtime = createRuntime(ndk, sender);
    const rumor = runtime.createDirectMessageRumorEvent(
      (await sender.user()).pubkey,
      (await recipient.user()).pubkey,
      attachment.url,
      1_780_000_000,
      null,
      buildNip17FileMessageTags(attachment),
      FILE_MESSAGE_KIND
    );

    const wrapped = await giftWrap(rumor, await recipient.user(), sender, { rumorKind: 14 });
    wrapped.ndk = ndk;
    const unwrapped = await giftUnwrap(wrapped, undefined, recipient);

    expect(unwrapped.kind).toBe(14);
  });
});
