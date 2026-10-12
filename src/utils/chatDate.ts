let formatterLocale: string;
let formatters: Partial<Record<'day' | 'year' | 'time', Intl.DateTimeFormat>> = {};
function format(date: Date, locale: string, kind: 'day' | 'year' | 'time'): string {
  if (Number.isNaN(date.getTime())) return date.toString();
  if (formatterLocale !== locale) {
    formatterLocale = locale;
    formatters = {};
  }
  // Keep just three formatters for the active locale, never a message-history cache.
  const formatter = (formatters[kind] ??= new Intl.DateTimeFormat(
    locale,
    kind === 'time'
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'long', ...(kind === 'year' ? { year: 'numeric' } : {}) },
  ));
  return formatter.format(date);
}

export function chatDate(value: string, locale: string): string {
  const date = new Date(value);
  return format(date, locale, date.getFullYear() === new Date().getFullYear() ? 'day' : 'year');
}

export function chatTime(value: string, locale: string): string {
  return format(new Date(value), locale, 'time');
}
