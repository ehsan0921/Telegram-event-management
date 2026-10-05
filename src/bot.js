import { randomBytes } from 'node:crypto';

const labels = { yes: '✅ Coming', no: '❌ Not coming', maybe: '🤔 Tentative', later: '⏳ Respond later' };
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = (...rows) => ({ inline_keyboard: rows });
const name = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Guest';
const clean = (s, max = 1000) => typeof s === 'string' ? s.trim().slice(0, max) : '';

export class Bot {
  constructor(store, api, username) { this.store = store; this.api = api; this.username = username; }
  get db() { return this.store.data; }
  send(id, text, reply_markup) { return this.api('sendMessage', { chat_id: id, text, ...(reply_markup ? { reply_markup } : {}) }); }
  async long(id, text) {
    for (let i = 0; i < text.length; i += 3900) await this.send(id, text.slice(i, i + 3900));
  }
  session(id, value) { if (value) this.db.sessions[id] = value; else delete this.db.sessions[id]; }
  link(e) { return `https://t.me/${this.username}?start=e_${e.id}`; }
  allowed(e, id) { return e && (e.owner === id || !!e.guests[id]); }
  async card(id, e) {
    const counts = Object.keys(labels).map(s => `${labels[s]}: ${Object.values(e.guests).filter(g => g.status === s).length}`).join('\n');
    const rows = e.cancelled ? [] : [
      [button('✅ Accept', `r:${e.id}:yes`), button('❌ Decline', `r:${e.id}:no`)],
      [button('🤔 Tentative', `r:${e.id}:maybe`), button('⏳ Later', `r:${e.id}:later`)],
      [button('👥 Guest list', `g:${e.id}`), button('💬 Comment', `c:${e.id}`)],
      [button('📎 Add media', `u:${e.id}`), button('🗂 Shared media', `m:${e.id}:0`)]
    ];
    if (e.owner === id && !e.cancelled) rows.push([button('⚙️ Manage', `h:${e.id}`)]);
    const text = `🎉 ${e.title}${e.cancelled ? ' — CANCELLED' : ''}\n\n🗓 ${e.when}\n📍 ${e.location}\n\n${e.description}\n\n${counts}\n\nInvite people:\n${this.link(e)}\n\nNames and RSVP comments are visible to guests. Phone numbers and question answers are shared only with the organiser.`;
    for (let i = 0; i < text.length; i += 3900) await this.send(id, text.slice(i, i + 3900), i + 3900 >= text.length ? keyboard(...rows) : undefined);
  }
  async handle(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    const m = update.message;
    if (!m || !m.from || m.from.is_bot) return;
    const id = m.from.id;
    if (m.chat.type !== 'private') return this.send(m.chat.id, `Please use me in a private chat: https://t.me/${this.username}`);
    const text = clean(m.text, 3000);
    const command = text.split(/\s/)[0].split('@')[0];
    if (command === '/cancel') { this.session(id); return this.send(id, 'Current input cancelled. Use /events to open an event.', { remove_keyboard: true }); }
    if (command === '/start') {
      this.session(id);
      const match = text.match(/^\/start(?:@\w+)? e_([a-f0-9]{16})$/);
      if (match) {
        const e = this.db.events[match[1]];
        if (!e) return this.send(id, 'This invitation is unavailable. Ask the organiser for a new link.');
        if (!e.cancelled && e.owner !== id && !e.guests[id]) e.guests[id] = { name: name(m.from), status: 'later', comment: '', answers: [], phone: '' };
        return this.card(id, e);
      }
      return this.send(id, 'Welcome to XEvents 🎉\nPlan a meetup, invite friends, and keep everything together.\n\n/new — create an event\n/events — your events\n/cancel — stop current input\n/help — how it works');
    }
    if (command === '/help') return this.send(id, 'Create with /new and share the invitation link. Guests open the link and press Start, then choose Accept, Decline, Tentative, or Later. Responses can be changed anytime.\n\nAccepting guests choose a display name, optionally share their own phone number with the organiser, and answer custom questions. Use Comment for public notes.\n\nAdd media accepts photos, videos, and files; everyone with the invitation can contribute and browse. Telegram stores the media; this bot saves reusable file IDs.\n\nOrganisers can edit details, view private answers, rotate invitation links, remove media, or cancel events. /cancel stops any unfinished input.');
    if (command === '/events') {
      const events = Object.values(this.db.events).filter(e => this.allowed(e, id));
      if (!events.length) return this.send(id, 'No events yet. Use /new or open an invitation.');
      for (const e of events) await this.send(id, `${e.cancelled ? '🚫' : '🎉'} ${e.title}\n${e.when}`, keyboard([button('Open event', `v:${e.id}`)]));
      return;
    }
    if (command === '/new') {
      this.session(id, { step: 'title', draft: {} });
      return this.send(id, 'Let’s create your event. What is its name? (up to 100 characters)');
    }
    if (text.startsWith('/') && command !== '/skip' && command !== '/done') return this.send(id, 'Use /help for commands, or /cancel to stop the current input.');
    const s = this.db.sessions[id];
    if (!s) return this.send(id, 'Use /new to create an event or /events to open one.');
    if (s.draft) return this.create(id, text, s);
    const e = this.db.events[s.event];
    if (!this.allowed(e, id) || e.cancelled) { this.session(id); return this.send(id, 'This event is no longer available for changes.'); }
    const g = e.guests[id];
    if (s.step === 'upload') {
      if (command === '/done') { this.session(id); return this.card(id, e); }
      const media = m.photo ? { type: 'photo', file: m.photo.at(-1) } : m.video ? { type: 'video', file: m.video } : m.document ? { type: 'document', file: m.document } : null;
      if (!media) return this.send(id, 'Send a photo, video, or file. Send /done when finished.');
      e.media.push({ id: randomBytes(6).toString('hex'), type: media.type, fileId: media.file.file_id, filename: media.file.file_name || media.type, caption: clean(m.caption, 700), by: id, name: g?.name || name(m.from), at: new Date().toISOString() });
      return this.send(id, '📎 Saved to the event. Send more, or /done.');
    }
    if (s.step === 'edit') {
      if (e.owner !== id) return;
      const limit = s.field === 'title' ? 100 : s.field === 'description' ? 1500 : 300;
      if (!text || text.length > limit) return this.send(id, `Enter text up to ${limit} characters.`);
      e[s.field] = text; this.session(id); await this.notify(e, `📣 ${e.title}: the organiser updated ${s.field}. Open /events for the latest details.`); return this.card(id, e);
    }
    if (s.step === 'name') {
      if (!text || text.length > 100) return this.send(id, 'Enter a name up to 100 characters, or /skip to use your Telegram name.');
      s.response.name = command === '/skip' ? name(m.from) : text;
      s.step = 'phone';
      return this.send(id, 'Optionally share your phone number with the organiser only. Tap the button, type a number, or /skip.', { keyboard: [[{ text: 'Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
    }
    if (s.step === 'phone') {
      if (m.contact && m.contact.user_id !== id) return this.send(id, 'Please share your own contact, type your number, or /skip.');
      const phone = m.contact?.phone_number || text;
      if (command !== '/skip' && !/^\+?[\d\s().-]{5,30}$/.test(phone)) return this.send(id, 'Enter a valid phone number or /skip.');
      s.response.phone = command === '/skip' ? '' : phone;
      s.step = 'question'; s.index = 0;
      await this.send(id, 'Thank you. Your phone number stays private to the organiser.', { remove_keyboard: true });
      return this.nextQuestion(id, e, s);
    }
    if (s.step === 'question') {
      if (!text || text.length > 1000) return this.send(id, 'Enter an answer up to 1,000 characters or /skip.');
      s.response.answers.push({ question: e.questions[s.index], answer: command === '/skip' ? '' : text }); s.index++;
      return this.nextQuestion(id, e, s);
    }
    if (s.step === 'comment') {
      if (!text || text.length > 1000) return this.send(id, 'Enter a comment up to 1,000 characters or /skip.');
      if (s.response) {
        s.response.comment = command === '/skip' ? '' : text;
        e.guests[id] = s.response;
      } else g.comment = command === '/skip' ? '' : text;
      this.session(id);
      await this.send(id, '✅ Response saved. You can change it from the event buttons.');
      if (id !== e.owner) await this.send(e.owner, `${e.title}\n${e.guests[id].name}: ${labels[e.guests[id].status]}${e.guests[id].comment ? '\nComment: ' + e.guests[id].comment : ''}`).catch(() => {});
      return this.card(id, e);
    }
  }
  async create(id, text, s) {
    const prompts = { title: ['when', 'When is the event? Include date, time, and timezone (for example: 24 October 2026, 6pm Australia/Sydney).'], when: ['location', 'Where is it? Enter an address, meeting point, or online link.'], location: ['description', 'Describe your event, or /skip.'], description: ['questions', 'Add custom questions, one per line (up to 10), or /skip. Answers are private to the organiser.'] };
    if (!text) return this.send(id, 'Please enter text.');
    if (s.step === 'questions') {
      const questions = text === '/skip' ? [] : text.split('\n').map(x => x.trim()).filter(Boolean);
      if (questions.length > 10 || questions.some(q => q.length > 200)) return this.send(id, 'Use up to 10 questions, each at most 200 characters.');
      const e = { ...s.draft, id: randomBytes(8).toString('hex'), owner: id, questions, guests: {}, media: [], cancelled: false, createdAt: new Date().toISOString() };
      this.db.events[e.id] = e; this.session(id); await this.send(id, '🎉 Your event is ready! Share the invite link with your guests.'); return this.card(id, e);
    }
    const limit = s.step === 'title' ? 100 : s.step === 'description' ? 1500 : 300;
    if (text.length > limit || (text === '/skip' && s.step !== 'description')) return this.send(id, `Enter ${s.step} up to ${limit} characters.`);
    s.draft[s.step] = text === '/skip' ? '' : text;
    const [next, prompt] = prompts[s.step]; s.step = next; return this.send(id, prompt);
  }
  async nextQuestion(id, e, s) {
    if (s.index < e.questions.length) return this.send(id, `Question ${s.index + 1}/${e.questions.length}\n${e.questions[s.index]}\n\nEnter your answer, or /skip.`);
    s.step = 'comment'; return this.send(id, 'Add an RSVP comment visible to the event guests, or /skip.');
  }
  async notify(e, text) {
    for (const uid of Object.keys(e.guests)) if (Number(uid) !== e.owner) await this.send(Number(uid), text).catch(() => {});
  }
  async callback(q) {
    const id = q.from.id;
    const [action, eid, arg] = (q.data || '').split(':');
    const e = this.db.events[eid];
    await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!this.allowed(e, id)) return this.send(id, 'Open a valid invitation link first.');
    if (e.cancelled) return this.card(id, e);
    const hostActions = ['h', 'a', 'x', 'z', 'edit', 'rotate', 'remove'];
    if (hostActions.includes(action) && e.owner !== id) return this.send(id, 'Only the organiser can do that.');
    if (action === 'v') return this.card(id, e);
    if (action === 'r' && labels[arg]) {
      this.session(id, { event: eid, step: arg === 'yes' ? 'name' : 'comment', response: { ...(e.guests[id] || { name: name(q.from), phone: '', answers: [] }), status: arg } });
      return this.send(id, arg === 'yes' ? 'What name should guests see? Enter a custom name, or /skip to use your Telegram name.' : `Selected: ${labels[arg]}. Add a public comment, or /skip to save your response.`);
    }
    if (action === 'g') {
      let text = `👥 ${e.title}\n`;
      for (const [status, label] of Object.entries(labels)) {
        text += `\n${label}\n`;
        const guests = Object.values(e.guests).filter(g => g.status === status);
        text += guests.length ? guests.map(g => `• ${g.name}${g.comment ? ' — ' + g.comment : ''}`).join('\n') + '\n' : 'Nobody yet\n';
      }
      return this.long(id, text);
    }
    if (action === 'c') {
      if (!e.guests[id]) return this.send(id, 'Choose an RSVP first so your comment has a display name.');
      this.session(id, { event: eid, step: 'comment' }); return this.send(id, 'Enter your public RSVP comment, or /skip to clear it.');
    }
    if (action === 'u') { this.session(id, { event: eid, step: 'upload' }); return this.send(id, 'Send photos, videos, or files for this event. All invited guests can see them. Send /done when finished.'); }
    if (action === 'm') {
      const page = Number(arg);
      if (!Number.isSafeInteger(page) || page < 0) return;
      const media = e.media.slice(page * 5, page * 5 + 5);
      if (!media.length) return this.send(id, 'No shared media on this page yet. Use Add media to contribute.');
      for (const f of media) {
        const method = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' }[f.type];
        await this.api(method, { chat_id: id, [f.type]: f.fileId, caption: `Shared by ${f.name}${f.caption ? '\n' + f.caption : ''}`, ...(e.owner === id ? { reply_markup: keyboard([button('Remove from event', `remove:${eid}:${f.id}`)]) } : {}) });
      }
      const nav = [];
      if (page > 0) nav.push(button('← Previous', `m:${eid}:${page - 1}`));
      if ((page + 1) * 5 < e.media.length) nav.push(button('Next →', `m:${eid}:${page + 1}`));
      return this.send(id, `Media page ${page + 1}`, keyboard(...(nav.length ? [nav] : []), [button('Back to event', `v:${eid}`)]));
    }
    if (action === 'remove') { e.media = e.media.filter(f => f.id !== arg); return this.send(id, 'Removed from the event collection. Previously sent copies remain in Telegram chats.'); }
    if (action === 'h') return this.send(id, 'Organiser tools', keyboard([button('Private guest responses', `a:${eid}`)], [button('Edit title', `edit:${eid}:title`), button('Edit time', `edit:${eid}:when`)], [button('Edit location', `edit:${eid}:location`), button('Edit description', `edit:${eid}:description`)], [button('Replace invite link', `rotate:${eid}`)], [button('Cancel event', `x:${eid}`)]));
    if (action === 'a') {
      const rows = Object.values(e.guests).map(g => `${g.name} — ${labels[g.status]}\nPhone: ${g.phone || 'Not shared'}\n${(g.answers || []).map(a => `${a.question}: ${a.answer || 'Skipped'}`).join('\n')}\nComment: ${g.comment || 'None'}`);
      return this.long(id, `Private organiser responses — ${e.title}\n\n${rows.join('\n\n') || 'No guests yet.'}`);
    }
    if (action === 'edit' && ['title', 'when', 'location', 'description'].includes(arg)) { this.session(id, { event: eid, step: 'edit', field: arg }); return this.send(id, `Enter the new ${arg}.`); }
    if (action === 'rotate') {
      const newId = randomBytes(8).toString('hex'); delete this.db.events[eid]; e.id = newId; this.db.events[newId] = e;
      for (const s of Object.values(this.db.sessions)) if (s.event === eid) s.event = newId;
      await this.send(id, 'Invite link replaced. The old link no longer works. Existing guests can still open the event with /events.'); return this.card(id, e);
    }
    if (action === 'x') return this.send(id, 'Cancel this event? Guests will be notified and new responses/uploads will close.', keyboard([button('Yes, cancel event', `z:${eid}`), button('Keep event', `v:${eid}`)]));
    if (action === 'z') { e.cancelled = true; await this.notify(e, `🚫 ${e.title} has been cancelled by the organiser.`); return this.card(id, e); }
  }
}
