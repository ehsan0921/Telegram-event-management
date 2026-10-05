import { randomBytes } from 'node:crypto';

const labels = { yes: '✅ Coming', no: '❌ Not coming', maybe: '🤔 Tentative', later: '⏳ Respond later' };
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = (...rows) => ({ inline_keyboard: rows });
const name = u => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Guest';
const clean = (s, max = 1000) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const menu = { new: '🎉 Create event', events: '📅 My events', help: '❓ Help', home: '🏠 Main menu', cancel: '✖️ Cancel input', skip: '⏭ Skip', done: '✅ Finish uploads', name: '👤 Use Telegram name' };
const reply = (...rows) => ({ keyboard: rows.map(row => row.map(text => typeof text === 'string' ? { text } : text)), resize_keyboard: true, is_persistent: true });
const homeKeyboard = () => reply([menu.new, menu.events], [menu.help]);

export class Bot {
  constructor(store, api, username) { this.store = store; this.api = api; this.username = username; }
  get db() { return this.store.data; }
  send(id, text, reply_markup) { return this.api('sendMessage', { chat_id: id, text, ...(reply_markup ? { reply_markup } : {}) }); }
  async long(id, text, markup) {
    for (let i = 0; i < text.length; i += 3900) await this.send(id, text.slice(i, i + 3900), i + 3900 >= text.length ? markup : undefined);
  }
  inputKeyboard(s) {
    if (s.step === 'phone') return reply([{ text: '📱 Share my phone number', request_contact: true }], [menu.skip, menu.cancel]);
    if (s.step === 'name') return reply([menu.name], [menu.cancel]);
    if (s.step === 'upload') return reply([menu.done], [menu.cancel]);
    if (['description', 'questions', 'question', 'comment'].includes(s.step)) return reply([menu.skip], [menu.cancel]);
    return reply([menu.cancel]);
  }
  prompt(id, text) { return this.send(id, text, this.inputKeyboard(this.db.sessions[id])); }
  home(id, text = 'Welcome to XEvents 🎉\nCreate an event or open your events using the buttons below.') { return this.send(id, text, homeKeyboard()); }
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
    if (!e.cancelled) rows.push([{ text: '📨 Invite people', url: `https://t.me/share/url?url=${encodeURIComponent(this.link(e))}&text=${encodeURIComponent(`You're invited to ${e.title}!`)}` }]);
    rows.push([button(menu.events, 'nav:events'), button(menu.home, 'nav:home')]);
    const text = `🎉 ${e.title}${e.cancelled ? ' — CANCELLED' : ''}\n\n🗓 ${e.when}\n📍 ${e.location}\n\n${e.description}\n\n${counts}\n\nInvite people:\n${this.link(e)}\n\nNames and RSVP comments are visible to guests. Phone numbers and question answers are shared only with the organiser.`;
    for (let i = 0; i < text.length; i += 3900) await this.send(id, text.slice(i, i + 3900), i + 3900 >= text.length ? keyboard(...rows) : undefined);
  }
  async handle(update) {
    if (update.callback_query) return this.callback(update.callback_query);
    const m = update.message;
    if (!m || !m.from || m.from.is_bot) return;
    const id = m.from.id;
    if (m.chat.type !== 'private') return this.send(m.chat.id, `Please use me in a private chat: https://t.me/${this.username}`);
    let text = clean(m.text, 3000);
    const current = this.db.sessions[id];
    const navigation = { [menu.new]: '/new', [menu.events]: '/events', [menu.help]: '/help', [menu.home]: '/start', [menu.cancel]: '/cancel' };
    if (navigation[text]) text = navigation[text];
    else if (current && text === menu.name && current.step === 'name') text = '/skip';
    else if (current && text === menu.skip && ['phone', 'description', 'questions', 'question', 'comment'].includes(current.step)) text = '/skip';
    else if (current && text === menu.done && current.step === 'upload') text = '/done';
    const command = text.split(/\s/)[0].split('@')[0];
    if (command === '/cancel') { this.session(id); return this.home(id, 'Input cancelled. Choose what you’d like to do next.'); }
    if (command === '/start') {
      this.session(id);
      const match = text.match(/^\/start(?:@\w+)? e_([a-f0-9]{16})$/);
      if (match) {
        const e = this.db.events[match[1]];
        if (!e) return this.send(id, 'This invitation is unavailable. Ask the organiser for a new link.');
        if (!e.cancelled && e.owner !== id && !e.guests[id]) e.guests[id] = { name: name(m.from), status: 'later', comment: '', answers: [], phone: '' };
        return this.card(id, e);
      }
      return this.home(id);
    }
    if (command === '/help') { this.session(id); return this.home(id, 'Tap Create event, enter its details, then tap Invite people to share it. Guests open the link and press Start.\n\nUse Accept, Decline, Tentative, or Later to respond. Accepting guests can use their Telegram name or type a custom name, optionally share their phone number, and answer organiser questions. Tap Skip for optional inputs. Phone numbers and answers stay private to the organiser.\n\nGuest list shows responses and public comments. Add media lets everyone contribute photos, videos, and files; tap Finish uploads when done.\n\nUse Manage for organiser tools, My events to return to your events, and Cancel input to leave an unfinished step.'); }
    if (command === '/events') {
      this.session(id);
      const events = Object.values(this.db.events).filter(e => this.allowed(e, id));
      if (!events.length) return this.home(id, 'No events yet. Tap Create event or open an invitation.');
      await this.home(id, '📅 Your events — tap Open event below.');
      for (const e of events) await this.send(id, `${e.cancelled ? '🚫' : '🎉'} ${e.title}\n${e.when}`, keyboard([button('Open event', `v:${e.id}`)]));
      return;
    }
    if (command === '/new') {
      this.session(id, { step: 'title', draft: {} });
      return this.prompt(id, 'Let’s create your event. What is its name? (up to 100 characters)');
    }
    if (text.startsWith('/') && command !== '/skip' && command !== '/done') return this.send(id, 'Choose a menu button, or tap Cancel input to leave this step.', current ? this.inputKeyboard(current) : homeKeyboard());
    const s = this.db.sessions[id];
    if (!s) return this.home(id, 'Choose Create event or My events below.');
    if (s.draft) return this.create(id, text, s);
    const e = this.db.events[s.event];
    if (!this.allowed(e, id) || e.cancelled) { this.session(id); return this.send(id, 'This event is no longer available for changes.'); }
    const g = e.guests[id];
    if (s.step === 'upload') {
      if (command === '/done') { this.session(id); await this.home(id, '✅ Uploads finished.'); return this.card(id, e); }
      const media = m.photo ? { type: 'photo', file: m.photo.at(-1) } : m.video ? { type: 'video', file: m.video } : m.document ? { type: 'document', file: m.document } : null;
      if (!media) return this.prompt(id, 'Send a photo, video, or file. Tap Finish uploads when finished.');
      e.media.push({ id: randomBytes(6).toString('hex'), type: media.type, fileId: media.file.file_id, filename: media.file.file_name || media.type, caption: clean(m.caption, 700), by: id, name: g?.name || name(m.from), at: new Date().toISOString() });
      return this.prompt(id, '📎 Saved to the event. Send more, or tap Finish uploads.');
    }
    if (s.step === 'edit') {
      if (e.owner !== id) return;
      const limit = s.field === 'title' ? 100 : s.field === 'description' ? 1500 : 300;
      if (!text || text.length > limit) return this.send(id, `Enter text up to ${limit} characters.`);
      e[s.field] = text; this.session(id); await this.home(id, '✅ Event updated.'); await this.notify(e, `📣 ${e.title}: the organiser updated ${s.field}. Tap My events for the latest details.`); return this.card(id, e);
    }
    if (s.step === 'name') {
      if (!text || text.length > 100) return this.prompt(id, 'Enter a name up to 100 characters, or tap Use Telegram name.');
      s.response.name = command === '/skip' ? name(m.from) : text;
      s.step = 'phone';
      return this.prompt(id, 'Optionally share your phone number with the organiser only. Tap Share my phone number, type a number, or tap Skip.');
    }
    if (s.step === 'phone') {
      if (m.contact && m.contact.user_id !== id) return this.prompt(id, 'Please share your own contact, type your number, or tap Skip.');
      const phone = m.contact?.phone_number || text;
      if (command !== '/skip' && !/^\+?[\d\s().-]{5,30}$/.test(phone)) return this.prompt(id, 'Enter a valid phone number or tap Skip.');
      s.response.phone = command === '/skip' ? '' : phone;
      s.step = 'question'; s.index = 0;
      await this.send(id, 'Phone choice saved. Your number is visible only to the organiser.');
      return this.nextQuestion(id, e, s);
    }
    if (s.step === 'question') {
      if (!text || text.length > 1000) return this.prompt(id, 'Enter an answer up to 1,000 characters or tap Skip.');
      s.response.answers.push({ question: e.questions[s.index], answer: command === '/skip' ? '' : text }); s.index++;
      return this.nextQuestion(id, e, s);
    }
    if (s.step === 'comment') {
      if (!text || text.length > 1000) return this.prompt(id, 'Enter a comment up to 1,000 characters or tap Skip.');
      if (s.response) {
        s.response.comment = command === '/skip' ? '' : text;
        e.guests[id] = s.response;
      } else g.comment = command === '/skip' ? '' : text;
      this.session(id);
      await this.home(id, '✅ Response saved. You can change it from the event buttons.');
      if (id !== e.owner) await this.send(e.owner, `${e.title}\n${e.guests[id].name}: ${labels[e.guests[id].status]}${e.guests[id].comment ? '\nComment: ' + e.guests[id].comment : ''}`).catch(() => {});
      return this.card(id, e);
    }
  }
  async create(id, text, s) {
    const prompts = { title: ['when', 'When is the event? Include date, time, and timezone (for example: 24 October 2026, 6pm Australia/Sydney).'], when: ['location', 'Where is it? Enter an address, meeting point, or online link.'], location: ['description', 'Describe your event, or tap Skip.'], description: ['questions', 'Add custom questions, one per line (up to 10), or tap Skip. Answers are private to the organiser.'] };
    if (!text) return this.send(id, 'Please enter text.');
    if (s.step === 'questions') {
      const questions = text === '/skip' ? [] : text.split('\n').map(x => x.trim()).filter(Boolean);
      if (questions.length > 10 || questions.some(q => q.length > 200)) return this.send(id, 'Use up to 10 questions, each at most 200 characters.');
      const e = { ...s.draft, id: randomBytes(8).toString('hex'), owner: id, questions, guests: {}, media: [], cancelled: false, createdAt: new Date().toISOString() };
      this.db.events[e.id] = e; this.session(id); await this.home(id, '🎉 Your event is ready! Tap Invite people below to share it.'); return this.card(id, e);
    }
    const limit = s.step === 'title' ? 100 : s.step === 'description' ? 1500 : 300;
    if (text.length > limit || (text === '/skip' && s.step !== 'description')) return this.send(id, `Enter ${s.step} up to ${limit} characters.`);
    s.draft[s.step] = text === '/skip' ? '' : text;
    const [next, prompt] = prompts[s.step]; s.step = next; return this.prompt(id, prompt);
  }
  async nextQuestion(id, e, s) {
    if (s.index < e.questions.length) return this.prompt(id, `Question ${s.index + 1}/${e.questions.length}\n${e.questions[s.index]}\n\nEnter your answer, or tap Skip.`);
    s.step = 'comment'; return this.prompt(id, 'Add an RSVP comment visible to the event guests, or tap Skip to save without a comment.');
  }
  async notify(e, text) {
    for (const uid of Object.keys(e.guests)) if (Number(uid) !== e.owner) await this.send(Number(uid), text).catch(() => {});
  }
  async callback(q) {
    const id = q.from.id;
    const [action, eid, arg] = (q.data || '').split(':');
    const e = this.db.events[eid];
    await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (action === 'nav' && ['home', 'events', 'new'].includes(eid)) return this.handle({ message: { from: q.from, chat: { id, type: 'private' }, text: { home: '/start', events: '/events', new: '/new' }[eid] } });
    if (!this.allowed(e, id)) return this.send(id, 'Open a valid invitation link first.');
    if (e.cancelled) return this.card(id, e);
    const hostActions = ['h', 'a', 'x', 'z', 'edit', 'rotate', 'remove'];
    if (hostActions.includes(action) && e.owner !== id) return this.send(id, 'Only the organiser can do that.');
    if (action === 'v') { this.session(id); await this.home(id, 'Use the event buttons below.'); return this.card(id, e); }
    if (action === 'r' && labels[arg]) {
      this.session(id, { event: eid, step: arg === 'yes' ? 'name' : 'comment', response: { ...(e.guests[id] || { name: name(q.from), phone: '', answers: [] }), ...(arg === 'yes' ? { answers: [] } : {}), status: arg } });
      return this.prompt(id, arg === 'yes' ? 'What name should guests see? Enter a custom name, or tap Use Telegram name.' : `Selected: ${labels[arg]}. Add a public comment, or tap Skip to save your response.`);
    }
    if (action === 'g') {
      let text = `👥 ${e.title}\n`;
      for (const [status, label] of Object.entries(labels)) {
        text += `\n${label}\n`;
        const guests = Object.values(e.guests).filter(g => g.status === status);
        text += guests.length ? guests.map(g => `• ${g.name}${g.comment ? ' — ' + g.comment : ''}`).join('\n') + '\n' : 'Nobody yet\n';
      }
      return this.long(id, text, keyboard([button('Back to event', `v:${eid}`)]));
    }
    if (action === 'c') {
      if (!e.guests[id]) return this.send(id, 'Choose an RSVP first so your comment has a display name.');
      this.session(id, { event: eid, step: 'comment' }); return this.prompt(id, 'Enter your public RSVP comment, or tap Skip to clear it.');
    }
    if (action === 'u') { this.session(id, { event: eid, step: 'upload' }); return this.prompt(id, 'Send photos, videos, or files for this event. All invited guests can see them. Tap Finish uploads when finished.'); }
    if (action === 'm') {
      const page = Number(arg);
      if (!Number.isSafeInteger(page) || page < 0) return;
      const media = e.media.slice(page * 5, page * 5 + 5);
      if (!media.length) return this.send(id, 'No shared media on this page yet.', keyboard([button('📎 Add media', `u:${eid}`)], [button('Back to event', `v:${eid}`)]));
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
    if (action === 'h') return this.send(id, 'Organiser tools', keyboard([button('Private guest responses', `a:${eid}`)], [button('Edit title', `edit:${eid}:title`), button('Edit time', `edit:${eid}:when`)], [button('Edit location', `edit:${eid}:location`), button('Edit description', `edit:${eid}:description`)], [button('Replace invite link', `rotate:${eid}`)], [button('Cancel event', `x:${eid}`)], [button('Back to event', `v:${eid}`)]));
    if (action === 'a') {
      const rows = Object.values(e.guests).map(g => `${g.name} — ${labels[g.status]}\nPhone: ${g.phone || 'Not shared'}\n${(g.answers || []).map(a => `${a.question}: ${a.answer || 'Skipped'}`).join('\n')}\nComment: ${g.comment || 'None'}`);
      return this.long(id, `Private organiser responses — ${e.title}\n\n${rows.join('\n\n') || 'No guests yet.'}`, keyboard([button('Back to organiser tools', `h:${eid}`)]));
    }
    if (action === 'edit' && ['title', 'when', 'location', 'description'].includes(arg)) { this.session(id, { event: eid, step: 'edit', field: arg }); return this.prompt(id, `Enter the new ${arg}.`); }
    if (action === 'rotate') {
      const newId = randomBytes(8).toString('hex'); delete this.db.events[eid]; e.id = newId; this.db.events[newId] = e;
      for (const s of Object.values(this.db.sessions)) if (s.event === eid) s.event = newId;
      await this.send(id, 'Invite link replaced. The old link no longer works. Existing guests can still open the event with My events.'); return this.card(id, e);
    }
    if (action === 'x') return this.send(id, 'Cancel this event? Guests will be notified and new responses/uploads will close.', keyboard([button('Yes, cancel event', `z:${eid}`), button('Keep event', `v:${eid}`)]));
    if (action === 'z') { e.cancelled = true; await this.notify(e, `🚫 ${e.title} has been cancelled by the organiser.`); return this.card(id, e); }
  }
}
