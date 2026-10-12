import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatDate, chatTime } from '#src/utils/chatDate.ts';

afterEach(() => vi.useRealTimers());
describe('cached chat formatters', () => {
  it('preserves localized date and time output across locale changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
    for (const locale of ['en-GB', 'de-DE', 'ar', 'en-US', 'en-GB']) {
      for (const value of ['2026-02-01T10:23:00Z', '2025-12-31T23:45:00Z']) {
        const date = new Date(value);
        expect(chatDate(value, locale)).toBe(
          date.toLocaleDateString(locale, {
            day: '2-digit',
            month: 'long',
            ...(date.getFullYear() === 2026 ? {} : { year: 'numeric' }),
          }),
        );
        expect(chatTime(value, locale)).toBe(
          date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
        );
      }
    }
  });
  it('handles the year changing and invalid dates without stale labels or exceptions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
    const value = '2026-05-01T12:00:00Z';
    expect(chatDate(value, 'en-GB')).toBe('01 May');
    vi.setSystemTime(new Date('2027-06-01T12:00:00Z'));
    expect(chatDate(value, 'en-GB')).toBe('01 May 2026');
    expect(chatDate('invalid', 'en-GB')).toBe('Invalid Date');
    expect(chatTime('invalid', 'en-GB')).toBe('Invalid Date');
  });
});
