const tg = window.Telegram?.WebApp;
const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const picker = query.get('mode') === 'picker';
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let state = { events: [], preference: {} }, activeEvent = null, createdEvent = null, previewSequence = 0;
let requestId = crypto.randomUUID();
const initData = tg?.initData || '';
let zones = [...new Set(['UTC', deviceZone, ...(Intl.supportedValuesOf?.('timeZone') || ['Australia/Sydney', 'Europe/London', 'America/New_York', 'Asia/Tehran'])])].sort();
tg?.ready(); tg?.expand();
function theme() { document.body.classList.toggle('dark', tg?.colorScheme === 'dark'); }
theme(); tg?.onEvent('themeChanged', theme);
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function selectedZone() { return state.preference.timezone || deviceZone; }
function options(id, zone, filter = '') {
  if (zone && !zones.includes(zone)) zones = [...zones, zone].sort();
  const select = $(id); select.replaceChildren();
  for (const value of zones.filter(z => z === zone || z.toLowerCase().replaceAll('_', ' ').includes(filter.toLowerCase().trim().replaceAll('_', ' ')))) {
    const option = document.createElement('option'); option.value = value; option.textContent = value.replaceAll('_', ' ').replaceAll('/', ' / '); select.append(option);
  }
  select.value = zone;
}
async function api(path, body) {
  const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'tma ' + initData, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data;
  try { data = await response.json(); } catch { throw new Error('Could not connect. Please try again.'); }
  if (!response.ok) throw new Error(data.error || 'Could not save. Please try again.');
  return data;
}
function go(tab) {
  for (const name of ['events', 'create', 'settings']) $(name + '-view').hidden = name !== tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}
function dateInZone(instant, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function format(e, zone = selectedZone()) {
  if (!e.startsAt) return e.when + '\nTimezone not set — shown as entered by the organiser.';
  return new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(e.startsAt)) + ` (${zone})`;
}
function openTelegram(url) { if (tg?.initData) tg.openTelegramLink(url); else window.open(url, '_blank', 'noopener'); }
function share(e) { openTelegram(`https://t.me/share/url?url=${encodeURIComponent(e.inviteUrl)}&text=${encodeURIComponent(`You're invited to ${e.title}!`)}`); }
function element(tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function action(text, fn, className = 'secondary') { const b = element('button', text, className); b.type = 'button'; b.onclick = fn; return b; }
function renderEvents() {
  $('zone-note').textContent = `Your local time · ${selectedZone().replaceAll('_', ' ')}`;
  const list = $('event-list'); list.replaceChildren();
  const events = [...state.events].sort((a, b) => Number(a.cancelled) - Number(b.cancelled) || (a.startsAt || '').localeCompare(b.startsAt || ''));
  if (!events.length) { const empty = element('div', '', 'empty'); empty.append(element('strong', 'A calendar full of possibilities.'), element('span', 'Create your first event, or open an invitation in the bot to join one.')); list.append(empty); }
  for (const e of events) {
    const card = element('article', '', 'event-card');
    const meta = element('div', '', 'event-meta'); meta.append(element('span', e.cancelled ? 'CANCELLED' : e.isOwner ? 'YOU’RE HOSTING' : 'INVITED', e.cancelled ? 'tag cancelled' : 'tag'));
    if (e.status) meta.append(element('span', { yes: 'Coming', no: 'Not coming', maybe: 'Tentative', later: 'Respond later' }[e.status], 'tag'));
    card.append(meta, element('h3', e.title), element('p', '🗓 ' + format(e)), element('p', '📍 ' + e.location, 'muted'));
    if (e.startsAt && selectedZone() !== e.timezone) card.append(element('p', 'Organiser time: ' + format(e, e.timezone), 'small muted'));
    card.append(element('div', `${e.counts.yes} coming · ${e.counts.maybe} tentative · ${e.counts.no} declined · ${e.counts.later} later`, 'counts'));
    const actions = element('div', '', 'event-actions'); actions.append(action('Open event in chat ↗', () => openTelegram(e.inviteUrl), 'primary'));
    if (!e.cancelled) actions.append(action('Invite', () => share(e)));
    if (e.isOwner && !e.cancelled) actions.append(action('Edit date & time', () => setupForm(e)));
    card.append(actions); list.append(card);
  }
}
function setupForm(event = null) {
  activeEvent = event; createdEvent = null; requestId = crypto.randomUUID();
  $('event-form').reset(); $('event-form').hidden = false; $('success').hidden = true; $('form-error').hidden = true;
  const scheduleOnly = picker || !!event;
  $('event-details').hidden = scheduleOnly; $('optional-details').hidden = scheduleOnly;
  $('title').required = !scheduleOnly; $('location').required = !scheduleOnly;
  $('form-title').textContent = picker ? 'Pick your moment.' : event ? 'A change of plans.' : 'Make a plan.';
  $('form-description').textContent = picker ? 'Choose a date and time, then continue in the chat.' : event ? `Update the start time for ${event.title}. Guests will be notified.` : 'Pick a date. Share an invite. Let the good times follow.';
  $('save-event').textContent = picker ? 'Use this time & continue' : event ? 'Save date & time' : 'Create event & get invite';
  $('cancel-edit').hidden = !event;
  const zone = event?.timezone || selectedZone(); options('event-zone', zone);
  const tomorrow = new Date(dateInZone(Date.now(), zone) + 'T12:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  $('date').value = event?.localDate || tomorrow.toISOString().slice(0, 10); $('time').value = event?.localTime || '18:00';
  go('create'); preview();
}
let timer;
async function preview() {
  const seq = ++previewSequence;
  if (!initData) { $('time-preview').textContent = 'Open inside Telegram to preview and save your event time.'; return; }
  try {
    const result = await api('preview', { date: $('date').value, time: $('time').value, timezone: $('event-zone').value });
    if (seq !== previewSequence) return;
    $('time-preview').textContent = '🗓 ' + result.when; $('time-preview').classList.remove('error');
  } catch (e) {
    if (seq !== previewSequence) return;
    $('time-preview').textContent = e.message; $('time-preview').classList.add('error');
  }
}
async function refresh() {
  const data = await api('bootstrap'); state = data;
  $('greeting').textContent = `LET’S MAKE PLANS, ${data.user.firstName.toUpperCase()}`;
  options('local-zone', selectedZone()); $('device-zone').textContent = `Detected on this device: ${deviceZone}`;
  renderEvents(); return data;
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => { notice(''); b.dataset.tab === 'create' ? setupForm() : go(b.dataset.tab); };
$('hero-create').onclick = () => setupForm();
$('cancel-edit').onclick = () => go('events');
$('refresh').onclick = async () => { $('refresh').disabled = true; try { await refresh(); notice(''); } catch (e) { notice(e.message); } finally { $('refresh').disabled = false; } };
for (const id of ['date', 'time', 'event-zone']) $(id).addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(preview, 180); });
for (const [search, select] of [['event-zone-search', 'event-zone'], ['local-zone-search', 'local-zone']]) $(search).oninput = () => options(select, $(select).value, $(search).value);
$('detect-zone').onclick = () => { $('local-zone-search').value = ''; options('local-zone', deviceZone); };
$('timezone-form').onsubmit = async event => {
  event.preventDefault(); $('save-zone').disabled = true;
  try { const result = await api('preferences', { timezone: $('local-zone').value }); state.preference = result.preference; renderEvents(); notice('✓ Your timezone is saved. Event times now show in your local time.'); tg?.HapticFeedback?.notificationOccurred('success'); }
  catch (e) { notice(e.message); } finally { $('save-zone').disabled = false; }
};
$('event-form').onsubmit = async event => {
  event.preventDefault(); $('save-event').disabled = true; $('form-error').hidden = true;
  const payload = { date: $('date').value, time: $('time').value, timezone: $('event-zone').value };
  try {
    if (picker) {
      await api('picker', { ...payload, sessionToken: query.get('session') });
      $('event-form').hidden = true; notice('✓ Time saved. Continue with the next step in your bot chat.');
      $('success').hidden = false; $('success-title').textContent = 'Your time is saved.'; $('success-time').textContent = 'Go back to the chat to continue.'; $('share-event').hidden = true; $('another-event').hidden = true;
      $('open-chat').textContent = 'Continue in Telegram'; $('open-chat').onclick = () => tg?.close();
    } else {
      const path = activeEvent ? `events/${activeEvent.id}/schedule` : 'events';
      const result = await api(path, { ...payload, title: $('title').value, location: $('location').value, description: $('description').value, questions: $('questions').value, requestId });
      createdEvent = result.event; await refresh();
      $('event-form').hidden = true; $('success').hidden = false; $('share-event').hidden = false; $('another-event').hidden = false;
      $('success-title').textContent = activeEvent ? 'The new time is set.' : 'Your event is ready.'; $('success-time').textContent = format(createdEvent);
      $('open-chat').textContent = 'Open event in chat'; $('open-chat').onclick = () => openTelegram(createdEvent.inviteUrl);
    }
    tg?.HapticFeedback?.notificationOccurred('success');
  } catch (e) { $('form-error').textContent = e.message; $('form-error').hidden = false; tg?.HapticFeedback?.notificationOccurred('error'); }
  finally { $('save-event').disabled = false; }
};
$('share-event').onclick = () => createdEvent && share(createdEvent);
$('another-event').onclick = () => go('events');
if (!initData) {
  notice('This is the XEvents Telegram planner. Open @XEvents_bot and tap Open planner to create events and save your timezone.');
  $('event-list').replaceChildren(element('div', 'Your events are private. Open this planner inside Telegram to see them.', 'empty'));
  $('save-event').disabled = true; $('save-zone').disabled = true; $('refresh').disabled = true;
  options('local-zone', deviceZone); options('event-zone', deviceZone); $('device-zone').textContent = `Detected on this device: ${deviceZone}`;
} else {
  try {
    const data = await refresh();
    if (!state.preference.timezone) { const saved = await api('preferences', { timezone: deviceZone }); state.preference = saved.preference; options('local-zone', selectedZone()); renderEvents(); }
    if (picker) { setupForm(state.events.find(e => e.id === data.session?.event) || null); document.querySelector('.bottom-nav').hidden = true; if (data.session?.token !== query.get('session')) { notice('This picker has expired. Open a new picker from the current chat step.'); $('save-event').disabled = true; } }
    else if (query.get('event')) { const event = state.events.find(e => e.id === query.get('event')); if (event?.isOwner && !event.cancelled) setupForm(event); }
  } catch (e) { notice(e.message); $('event-list').replaceChildren(element('div', 'Could not load your events. Tap Refresh to try again.', 'empty')); }
}
