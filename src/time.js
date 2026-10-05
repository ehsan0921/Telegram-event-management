import { Temporal } from '@js-temporal/polyfill';
export class InputError extends Error {}

export function timezone(value) {
  if (typeof value !== 'string' || value.length > 80 || /^[+-]/.test(value)) throw new InputError('Choose a valid timezone.');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new InputError('Choose a valid timezone.'); }
}

export function schedule(input) {
  const zone = timezone(input.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || '') || !/^\d{2}:\d{2}$/.test(input.time || '')) throw new InputError('Choose a date and time.');
  const [year, month, day] = input.date.split('-').map(Number);
  const [hour, minute] = input.time.split(':').map(Number);
  if (year < 2020 || year > 2100) throw new InputError('Choose a year between 2020 and 2100.');
  // Reject both missing and repeated clock times instead of silently shifting them.
  let local;
  try { local = Temporal.ZonedDateTime.from({ timeZone: zone, year, month, day, hour, minute }, { overflow: 'reject', disambiguation: 'reject' }); }
  catch { throw new InputError('This date or time is invalid, or the clock changes make it missing or repeated. Please choose another time.'); }
  const startsAt = local.toInstant().toString();
  return { startsAt, timezone: zone, localDate: input.date, localTime: input.time, when: formatInstant(startsAt, zone) };
}

export function formatInstant(instant, zone) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone(zone), weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(instant)) + ` (${zone})`;
}

export function eventTime(event, preference) {
  if (!event.startsAt || !event.timezone) return event.when;
  const zone = preference || event.timezone;
  const local = formatInstant(event.startsAt, zone);
  return zone === event.timezone ? local : `${local}\nOrganiser time: ${formatInstant(event.startsAt, event.timezone)}`;
}
