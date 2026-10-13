import { nip19 } from 'nostr-tools';
import { HEX, single, valid } from './runtime.js';

export function roomLink(value) {
  try {
    const match = value.match(/naddr1[023456789acdefghjklmnpqrstuvwxyz]+/i);
    const decoded = nip19.decode(match?.[0] ?? value.replace(/^nostr:/, ''));
    if (
      decoded.type !== 'naddr' ||
      decoded.data.kind !== 34550 ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(decoded.data.identifier)
    )
      return null;
    return {
      owner: decoded.data.pubkey,
      slug: decoded.data.identifier,
      relays: decoded.data.relays.slice(0, 8),
    };
  } catch {
    return null;
  }
}
export function parseRoom(event) {
  if (
    event.kind !== 34550 ||
    !valid(event) ||
    single(event, 'anagram-room') !== '1' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(single(event, 'd') ?? '') ||
    !single(event, 'name')?.trim()
  )
    return null;
  const relays = event.tags.filter((t) => t[0] === 'relay').map((t) => t[1]);
  if (!relays.length || relays.length > 8) return null;
  const keys = (name) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const trusted = keys('trusted'),
    blocked = keys('blocked');
  if (
    [...trusted, ...blocked].some((key) => !HEX.test(key)) ||
    trusted.length > 1024 ||
    blocked.length > 1024
  )
    return null;
  return {
    event,
    address: `34550:${event.pubkey}:${single(event, 'd')}`,
    relays,
    trusted,
    blocked,
  };
}
