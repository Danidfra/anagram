import { invoke, isTauri } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
import { isIosNative } from '#src/lib/platform/ios.ts';

export function hasMobileCallAudio(): boolean {
  return isTauri() && (isIosNative() || /Android/i.test(navigator.userAgent));
}

// One route per whole call, not per participant/player. Serialize native writes
// so a late hangup cannot undo the route of a newly started call.
export function createMobileCallAudio(
  write: (active: boolean, speaker: boolean) => Promise<unknown>,
  changed: (speaker: boolean) => void = () => {},
) {
  const owners = new Set<symbol>();
  let speaker = false;
  let queue: Promise<unknown> = Promise.resolve();
  const sync = () => {
    const task = queue.then(async () => {
      await write(owners.size > 0, speaker);
      changed(speaker);
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    async acquire(): Promise<() => void> {
      const owner = Symbol();
      if (!owners.size) speaker = false;
      owners.add(owner);
      const release = () => {
        if (!owners.delete(owner) || owners.size) return;
        speaker = false;
        void sync().catch(() => console.warn('Could not release mobile call audio'));
      };
      try {
        await sync();
      } catch (error) {
        release();
        throw error;
      }
      return release;
    },
    async selectSpeaker(value: boolean) {
      if (!owners.size) return;
      const previous = speaker;
      speaker = value;
      try {
        await sync();
      } catch (error) {
        speaker = previous;
        throw error;
      }
    },
  };
}

export const mobileCallSpeaker = writable(false);
const audio = createMobileCallAudio(
  (active, speaker) => invoke('set_mobile_call_audio', { active, speaker }),
  mobileCallSpeaker.set,
);
export function acquireMobileCallAudio(): Promise<() => void> {
  return hasMobileCallAudio() ? audio.acquire() : Promise.resolve(() => {});
}
export const selectMobileCallSpeaker = (speaker: boolean) => audio.selectSpeaker(speaker);
