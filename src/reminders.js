import { InputError } from './time.js';
export function upcoming(e, now = Date.now()) { return !e.cancelled && Number.isFinite(Date.parse(e.startsAt)) && Date.parse(e.startsAt) > now; }
export function eventGroup(e, now = Date.now()) { return e.cancelled ? 'Cancelled events' : !Number.isFinite(Date.parse(e.startsAt)) ? 'Date not set' : upcoming(e, now) ? 'Upcoming events' : 'Past events'; }
export function setReminder(e, id, minutes, now = Date.now()) {
  if (![0, 15, 60, 1440].includes(minutes)) throw new InputError('Choose a reminder option.');
  e.reminders ||= {};
  if (!minutes) { delete e.reminders[id]; return; }
  if (!upcoming(e, now) || Date.parse(e.startsAt) - minutes * 60000 <= now) throw new InputError('That reminder time has already passed. Choose a shorter reminder.');
  e.reminders[id] = { minutes, sentFor: null };
}
export async function sendDueReminders(data, bot, now = Date.now()) {
  for (const e of Object.values(data.events)) {
    if (!upcoming(e, now)) continue;
    for (const [uid, reminder] of Object.entries(e.reminders || {})) {
      const id = Number(uid);
      if (!bot.allowed(e, id) || e.guests[id]?.status === 'no' || reminder.sentFor === e.startsAt || now < Date.parse(e.startsAt) - reminder.minutes * 60000) continue;
      reminder.sentFor = e.startsAt;
      await bot.send(id, `🔔 Reminder: ${e.title}\n${bot.time(e, id)}\nOpen My events for the latest invitation details.`, { inline_keyboard: [[{ text: 'Open event', callback_data: `v:${e.id}` }]] });
    }
  }
}
