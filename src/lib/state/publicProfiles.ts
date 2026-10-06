import { shallowReactive } from '@vue/reactivity';
import { observe } from '#src/lib/state/store.ts';

// Display-only whitelist. Contact metadata can contain encrypted group keys and
// must never be copied wholesale into the frontend profile cache.
export interface PublicProfile {
  name: string;
  picture: string;
  createdAt?: number;
  eventId?: string;
}
const profiles = shallowReactive(new Map<string, PublicProfile>());
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
export const getPublicProfile = (publicKey: string) => profiles.get(publicKey);
export const observePublicProfile = (publicKey: string) => observe(() => profiles.get(publicKey));
export const clearPublicProfiles = () => profiles.clear();

export function rememberPublicProfile(
  publicKey: string,
  metadata: {
    name?: unknown;
    display_name?: unknown;
    displayName?: unknown;
    picture?: unknown;
    image?: unknown;
  },
  createdAt?: number,
  eventId?: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(publicKey)) return;
  const previous = profiles.get(publicKey);
  if (previous?.createdAt !== undefined) {
    if (createdAt === undefined || createdAt < previous.createdAt) return;
    if (createdAt === previous.createdAt) {
      // Cached contacts lack event ids. Never replace a signed snapshot with a
      // same-age disk copy; NIP-01 selects the lowest id on a timestamp tie.
      if (previous.eventId && (!eventId || eventId >= previous.eventId)) return;
    }
  }
  const picture = text(metadata.picture) || text(metadata.image);
  const next: PublicProfile = {
    name: text(metadata.display_name) || text(metadata.displayName) || text(metadata.name),
    picture: /^https?:\/\//i.test(picture) ? picture : '',
    createdAt,
    eventId,
  };
  if (createdAt === undefined && !next.name && !next.picture) return;
  if (createdAt === undefined && previous) {
    next.name ||= previous.name;
    next.picture ||= previous.picture;
  }
  if (
    !previous ||
    Object.keys(next).some(
      (key) => next[key as keyof PublicProfile] !== previous[key as keyof PublicProfile],
    )
  )
    profiles.set(publicKey, next);
}
