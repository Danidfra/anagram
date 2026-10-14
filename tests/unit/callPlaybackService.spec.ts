import { followCallLive } from '#src/services/callPlaybackService.ts';
import { describe, expect, it, vi } from 'vitest';

function media(currentTime: number, ranges: number[][], seeking = false) {
  const seek = vi.fn((time: number) => {
    currentTime = time;
  });
  const element = {
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1],
    },
    seeking,
    get currentTime() {
      return currentTime;
    },
    set currentTime(time: number) {
      seek(time);
    },
  } as HTMLMediaElement;
  return { element, seek };
}

describe('live call playback recovery', () => {
  it('waits for buffered media, including streams that have not started', () => {
    const { element, seek } = media(0, []);
    followCallLive(null);
    followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('allows normal chunk jitter without repeatedly seeking', () => {
    const { element, seek } = media(9.5, [[0, 10]]);
    for (let i = 0; i < 10; i++) followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('recovers a sub-second backlog once and retains a playback cushion', () => {
    const { element, seek } = media(9, [[0, 10]]);
    followCallLive(element);
    expect(element.currentTime).toBeCloseTo(9.65);
    for (let i = 0; i < 10; i++) followCallLive(element);
    expect(seek).toHaveBeenCalledTimes(1);
  });

  it('lets an in-flight seek finish before correcting further drift', () => {
    const { element, seek } = media(8, [[0, 10]], true);
    followCallLive(element);
    expect(seek).not.toHaveBeenCalled();
  });

  it('seeks into the latest playable range rather than a gap', () => {
    const { element, seek } = media(5, [
      [0, 6],
      [9.9, 10],
    ]);
    followCallLive(element);
    expect(seek).toHaveBeenCalledWith(9.9);
  });
});
