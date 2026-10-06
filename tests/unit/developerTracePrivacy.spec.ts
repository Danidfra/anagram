import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { ref } from '#src/lib/state/reactivity.ts';
import {
  createDeveloperTraceRuntime,
  readDeveloperDiagnosticsEnabledFromStorage,
} from '#src/stores/nostr/developerTrace.ts';
const append = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('#src/services/developerTraceDataService.ts', () => ({
  developerTraceDataService: { appendEntry: append },
}));

function runtime(enabled: boolean) {
  return createDeveloperTraceRuntime({
    developerDiagnosticsEnabled: ref(enabled),
    developerDiagnosticsVersion: ref(0),
    developerTraceState: { developerTraceCounter: 0 },
    developerTraceVersion: ref(0),
    developerDiagnosticsStorageKey: 'diagnostics',
    getLoggedInPublicKeyHex: () => 'a'.repeat(64),
  });
}
describe('private diagnostic data', () => {
  it('redacts nested keys, decrypted content, binary keys and secrets inside errors', () => {
    const key = generateSecretKey(),
      nsec = nip19.nsecEncode(key);
    const hex = Buffer.from(key).toString('hex');
    const result = JSON.stringify(
      runtime(true).normalizeDeveloperTraceDetails({
        rumor: { content: 'private conversation', tags: [['secret', hex]] },
        privateKey: hex,
        binary: key,
        error: new Error(`failed ${nsec} ${hex}`),
        count: 12,
      }),
    );
    expect([nsec, hex, 'private conversation'].some((value) => result.includes(value))).toBe(false);
    expect(JSON.parse(result).count).toBe(12);
  });
  it('does not echo or persist diagnostics when disabled', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    append.mockClear();
    runtime(false).logDeveloperTrace('info', 'inbound', 'private-message-received', {
      content: 'private',
    });
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    consoleInfo.mockRestore();
  });
  it('requires opt-in without browser storage', () => {
    expect(readDeveloperDiagnosticsEnabledFromStorage('diagnostics')).toBe(false);
  });
});
