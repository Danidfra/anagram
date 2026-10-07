import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ChatGroupEpochKey } from '#src/types/chat.ts';

export function normalizeChatGroupEpochKeysValue(value: unknown): ChatGroupEpochKey[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entriesByEpoch = new Map<string, ChatGroupEpochKey>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const epochNumber = Number('epoch_number' in entry ? entry.epoch_number : Number.NaN);
    const epochPublicKey = inputSanitizerService.normalizeHexKey(
      'epoch_public_key' in entry && typeof entry.epoch_public_key === 'string'
        ? entry.epoch_public_key
        : '',
    );
    const epochPrivateKeyEncrypted =
      'epoch_private_key_encrypted' in entry &&
      typeof entry.epoch_private_key_encrypted === 'string'
        ? entry.epoch_private_key_encrypted.trim()
        : '';

    if (
      !Number.isInteger(epochNumber) ||
      epochNumber < 0 ||
      !epochPublicKey ||
      !epochPrivateKeyEncrypted
    ) {
      continue;
    }

    entriesByEpoch.set(`${epochNumber}:${epochPublicKey}`, {
      epoch_number: Math.floor(epochNumber),
      epoch_public_key: epochPublicKey,
      epoch_private_key_encrypted: epochPrivateKeyEncrypted,
      ...('invitation_created_at' in entry &&
      typeof entry.invitation_created_at === 'string' &&
      entry.invitation_created_at.trim()
        ? { invitation_created_at: entry.invitation_created_at.trim() }
        : {}),
    });
  }

  return Array.from(entriesByEpoch.values()).sort(
    (first, second) => second.epoch_number - first.epoch_number,
  );
}

// Tickets establish durable epoch keys. A profile, roster, or older ticket may
// have read an earlier chat snapshot; merge keys inside the database transaction
// so these independent writes cannot erase history or roll back the current key.
export function mergeGroupEpochMetadata(
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const epochs = new Map(
    normalizeChatGroupEpochKeysValue(stored.group_epoch_keys).map((entry) => [
      `${entry.epoch_number}:${entry.epoch_public_key}`,
      entry,
    ]),
  );
  for (const entry of normalizeChatGroupEpochKeysValue(next.group_epoch_keys)) {
    const previous = epochs.get(`${entry.epoch_number}:${entry.epoch_public_key}`);
    if (!previous) epochs.set(`${entry.epoch_number}:${entry.epoch_public_key}`, entry);
    else if (
      previous.epoch_public_key === entry.epoch_public_key &&
      Date.parse(entry.invitation_created_at ?? '') >
        (Date.parse(previous.invitation_created_at ?? '') || 0)
    ) {
      epochs.set(`${entry.epoch_number}:${entry.epoch_public_key}`, {
        ...previous,
        invitation_created_at: entry.invitation_created_at,
      });
    }
  }
  const keys = [...epochs.values()].sort((a, b) => b.epoch_number - a.epoch_number);
  const current = keys[0];
  if (!current) return next;
  const conflict = keys.filter((entry) => entry.epoch_number === current.epoch_number).length > 1 ||
    Number(stored.group_conflicting_epoch ?? -1) >= current.epoch_number || Number(next.group_conflicting_epoch ?? -1) >= current.epoch_number;
  return {
    ...next,
    group_conflicting_epoch: conflict ? current.epoch_number : -1,
    group_epoch_keys: keys,
    current_epoch_public_key: current.epoch_public_key,
    current_epoch_private_key_encrypted: current.epoch_private_key_encrypted,
    epoch_public_key: current.epoch_public_key,
  };
}
