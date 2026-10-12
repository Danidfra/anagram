import { flushSync } from 'svelte';
import { watchRelaySettingsSubscriptions } from '#src/stores/nostr/relaySettingsSubscriptions.ts';
import { describe, expect, it, vi } from 'vitest';

describe('relay settings orchestration', () => {
  it('ignores hydration and startup changes and uses one path for real settings changes', () => {
    let signature = $state('');
    let restoring = false;
    const refresh = vi.fn();
    const stop = watchRelaySettingsSubscriptions({
      hydrate: () => {
        signature = 'hydrated';
      },
      signature: () => signature,
      isRestoring: () => restoring,
      hasSessionSubscriptions: () => true,
      refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
    restoring = true;
    signature = 'restored';
    flushSync();
    restoring = false;
    signature = 'restored';
    flushSync();
    expect(refresh).not.toHaveBeenCalled();
    signature = 'local mutation';
    flushSync();
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
