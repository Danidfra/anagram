import { expect, it } from 'vitest';
import { mediaDeviceChoices } from '#src/utils/mediaDeviceChoices.ts';

it('removes the extra default and repeated IDs while retaining distinct inputs and routes', () => {
  const device = (deviceId: string, kind: MediaDeviceKind = 'audioinput') =>
    ({ deviceId, kind, label: 'Microphone', groupId: 'same-group' }) as MediaDeviceInfo;
  const mic = device('built-in'),
    external = device('external'),
    route = device('communications');
  const camera = device('built-in', 'videoinput');
  expect(
    mediaDeviceChoices([
      device(''),
      device('default'),
      mic,
      device('built-in'),
      external,
      route,
      camera,
    ]),
  ).toEqual([mic, external, route, camera]);
});
