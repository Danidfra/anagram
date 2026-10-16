import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { generateNip46Secret } from '#src/stores/nostr/nip46AuthRuntime.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Check the entropy source and fail-closed behavior, not statistical properties
// of a small sample (which cannot establish cryptographic unpredictability).
describe('secret generation', () => {
  const generators = [
    { name: 'account key', generate: generateSecretKey, entropyBytes: 48 },
    {
      name: 'adapter key',
      generate: () => NostrPrivateKeySigner.generate().secretKey,
      entropyBytes: 48,
    },
    { name: 'pairing secret', generate: generateNip46Secret, entropyBytes: 32 },
  ];

  for (const { name, generate, entropyBytes } of generators) {
    it(`${name} draws fresh entropy from Web Crypto on every invocation`, () => {
      const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
      const weakRandom = vi.spyOn(Math, 'random');
      for (let i = 0; i < 2; i++) {
        const secret = generate();
        if (typeof secret === 'string') {
          expect(secret).toMatch(/^[0-9a-f]{64}$/);
        } else {
          expect(secret).toHaveLength(32);
          expect(getPublicKey(secret)).toMatch(/^[0-9a-f]{64}$/);
          expect(nip19.decode(nip19.nsecEncode(secret)).data).toEqual(secret);
        }
      }
      expect(random).toHaveBeenCalledTimes(2);
      for (const [buffer] of random.mock.calls) {
        expect(buffer).toBeInstanceOf(Uint8Array);
        expect(buffer?.byteLength).toBe(entropyBytes);
      }
      expect(random.mock.calls[0][0]).not.toBe(random.mock.calls[1][0]);
      expect(weakRandom).not.toHaveBeenCalled();
    });

    it.each([undefined, {}])(`${name} refuses to generate without Web Crypto (%s)`, (crypto) => {
      const weakRandom = vi.spyOn(Math, 'random');
      vi.stubGlobal('crypto', crypto);
      expect(() => generate()).toThrow();
      expect(weakRandom).not.toHaveBeenCalled();
    });

    it(`${name} propagates entropy source failures without a fallback`, () => {
      const failure = new Error('Entropy source failed');
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
        throw failure;
      });
      const weakRandom = vi.spyOn(Math, 'random');
      expect(() => generate()).toThrow(failure);
      expect(weakRandom).not.toHaveBeenCalled();
    });
  }
});
