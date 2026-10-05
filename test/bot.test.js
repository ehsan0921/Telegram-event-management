import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';

function fixture() {
  const store = { data: { events: {}, sessions: {}, offset: 0 } };
  const calls = [];
  const bot = new Bot(store, async (method, params) => { calls.push({ method, ...params }); return {}; }, 'XEvents_bot');
  const msg = (id, text, extra = {}) => bot.handle({ message: { chat: { id, type: 'private' }, from: { id, first_name: `User ${id}` }, text, ...extra } });
  const cb = (id, data) => bot.handle({ callback_query: { id: 'query', from: { id, first_name: `User ${id}` }, data } });
  async function create(settings = { guestList: true, uploadMedia: true, viewMedia: true }) {
    for (const text of ['/new', 'Birthday', '24 October 2026, 6pm Sydney', 'My house', 'Bring a friend', 'Dietary needs?\nWhat will you bring?']) await msg(1, text);
    const token = store.data.sessions[1].token;
    for (const [key, enabled] of Object.entries(settings)) if (enabled) await cb(1, `pc:${token}:${key}`);
    await cb(1, `pd:${token}`);
    return Object.values(store.data.events).at(-1);
  }
  return { store, bot, calls, msg, cb, create };
}

test('create, invite, accept, custom name, private phone/questions, comment, change response', async () => {
  const f = fixture(); const e = await f.create();
  assert.match(f.bot.link(e), /^https:\/\/t.me\/XEvents_bot\?start=e_[a-f0-9]{16}$/);
  await f.msg(2, `/start e_${e.id}`);
  assert.equal(e.guests[2].status, 'later');
  await f.cb(2, `r:${e.id}:yes`);
  await f.msg(2, 'Party guest'); await f.msg(2, '+61412345678');
  await f.msg(2, 'Vegetarian'); await f.msg(2, 'Cake'); await f.msg(2, 'Looking forward to it');
  assert.equal(e.guests[2].status, 'yes'); assert.equal(e.guests[2].name, 'Party guest');
  assert.equal(e.guests[2].answers[1].answer, 'Cake');
  f.calls.length = 0; await f.cb(2, `g:${e.id}`);
  const publicText = f.calls.map(c => c.text || '').join('\n');
  assert.match(publicText, /Party guest/); assert.match(publicText, /Looking forward/);
  assert.doesNotMatch(publicText, /61412345678|Vegetarian|Cake/);
  f.calls.length = 0; await f.cb(2, `a:${e.id}`);
  assert.doesNotMatch(f.calls.map(c => c.text || '').join(''), /61412345678/);
  await f.cb(1, `a:${e.id}`); assert.match(f.calls.at(-1).text, /61412345678/);
  await f.cb(2, `r:${e.id}:no`); await f.msg(2, 'Cannot make it');
  assert.equal(e.guests[2].status, 'no');
  for (const status of ['maybe', 'later']) {
    await f.cb(2, `r:${e.id}:${status}`); await f.msg(2, '/skip');
    assert.equal(e.guests[2].status, status);
  }
});

test('media membership, retrieval, organiser removal, and cancellation', async () => {
  const f = fixture(); const e = await f.create();
  await f.cb(99, `u:${e.id}`); assert.equal(f.store.data.sessions[99], undefined);
  await f.msg(2, `/start e_${e.id}`); await f.cb(2, `u:${e.id}`);
  await f.msg(2, undefined, { photo: [{ file_id: 'small' }, { file_id: 'large' }], caption: 'Our group' });
  await f.msg(2, undefined, { video: { file_id: 'video' } });
  await f.msg(2, undefined, { document: { file_id: 'file', file_name: 'plan.pdf' } });
  assert.equal(e.media.length, 3); await f.msg(2, '/done');
  await f.cb(2, `m:${e.id}:0`); assert.ok(f.calls.some(c => c.method === 'sendPhoto' && c.photo === 'large'));
  const mediaId = e.media[0].id; await f.cb(2, `remove:${e.id}:${mediaId}`); assert.equal(e.media.length, 3);
  await f.cb(1, `remove:${e.id}:${mediaId}`); assert.equal(e.media.length, 2);
  await f.cb(2, `z:${e.id}`); assert.equal(e.cancelled, false);
  await f.cb(1, `z:${e.id}`); assert.equal(e.cancelled, true);
  await f.cb(2, `r:${e.id}:yes`); assert.equal(f.store.data.sessions[2], undefined);
});

test('foreign contacts rejected, abandoned RSVP does not change saved response, link rotation', async () => {
  const f = fixture(); const e = await f.create();
  await f.msg(2, `/start e_${e.id}`); await f.cb(2, `r:${e.id}:yes`); await f.msg(2, '/skip');
  await f.msg(2, undefined, { contact: { user_id: 3, phone_number: '12345678' } });
  assert.equal(f.store.data.sessions[2].step, 'phone');
  await f.msg(2, '/cancel'); assert.equal(e.guests[2].status, 'later');
  const old = e.id; await f.cb(1, `rotate:${old}`);
  assert.equal(f.store.data.events[old], undefined); assert.notEqual(e.id, old);
  await f.msg(3, `/start e_${old}`); assert.equal(e.guests[3], undefined);
  await f.cb(2, `v:${e.id}`); assert.match(f.calls.at(-1).text, /Birthday/);
});

test('event data, conversations, and polling offset survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xevents-'));
  try {
    const store = await new Store(dir).load();
    store.data.events.example = { title: 'Saved event' }; store.data.sessions[2] = { step: 'phone' }; store.data.offset = 42;
    await store.save();
    const loaded = await new Store(dir).load(); assert.deepEqual(loaded.data, store.data);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('button menus complete event creation and RSVP without typed commands', async () => {
  const f = fixture();
  await f.msg(1, '/start');
  assert.equal(f.calls.at(-1).reply_markup.keyboard[0][0].text, '🎉 Create event');
  await f.msg(1, '🎉 Create event');
  for (const text of ['Button party', 'Saturday, Sydney', 'Park', '⏭ Skip', '⏭ Skip']) await f.msg(1, text);
  const token = f.store.data.sessions[1].token;
  await f.cb(1, `pc:${token}:uploadMedia`); await f.cb(1, `pd:${token}`);
  const e = Object.values(f.store.data.events)[0];
  assert.equal(e.description, ''); assert.deepEqual(e.questions, []);
  const invite = f.calls.at(-1).reply_markup.inline_keyboard.flat().find(b => b.url);
  assert.equal(new URL(invite.url).searchParams.get('url'), f.bot.link(e));
  await f.msg(2, `/start e_${e.id}`); await f.cb(2, `r:${e.id}:yes`);
  await f.msg(2, '👤 Use Telegram name');
  assert.ok(f.calls.at(-1).reply_markup.keyboard.flat().some(b => b.request_contact));
  await f.msg(2, '⏭ Skip'); await f.msg(2, '⏭ Skip');
  assert.equal(e.guests[2].status, 'yes'); assert.equal(e.guests[2].name, 'User 2');
  await f.cb(2, `u:${e.id}`); await f.msg(2, undefined, { document: { file_id: 'test' } });
  await f.msg(2, '✅ Finish uploads'); assert.equal(f.store.data.sessions[2], undefined);
  await f.msg(2, '📅 My events'); assert.match(f.calls.at(-1).text, /Button party/);
  await f.cb(2, 'nav:home'); assert.equal(f.calls.at(-1).reply_markup.keyboard[0][0].text, '🎉 Create event');
  await f.msg(2, '🎉 Create event'); await f.msg(2, '✖️ Cancel input');
  assert.equal(f.store.data.sessions[2], undefined); assert.equal(Object.keys(f.store.data.events).length, 1);
});

test('organiser does not RSVP and guest extras are opt-in with backend enforcement', async () => {
  const f = fixture(); const e = await f.create({});
  await f.cb(1, `v:${e.id}`);
  assert.ok(!f.calls.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data?.startsWith('r:')));
  await f.cb(1, `r:${e.id}:yes`); assert.equal(e.guests[1], undefined); assert.equal(f.store.data.sessions[1], undefined);
  await f.msg(2, `/start e_${e.id}`);
  const actions = f.calls.at(-1).reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.deepEqual(actions.filter(x => x?.startsWith('r:')).length, 4);
  for (const prefix of ['g:', 'u:', 'm:', 'c:']) assert.ok(!actions.some(x => x?.startsWith(prefix)));
  for (const action of ['g', 'u', 'm']) {
    await f.cb(2, `${action}:${e.id}`); assert.match(f.calls.at(-1).text, /not enabled/);
  }
  await f.cb(2, `toggle:${e.id}:guestList`); assert.equal(e.permissions.guestList, false);
  await f.cb(1, `toggle:${e.id}:uploadMedia`); await f.cb(2, `u:${e.id}`);
  assert.equal(f.store.data.sessions[2].step, 'upload');
  await f.cb(1, `toggle:${e.id}:uploadMedia`);
  await f.msg(2, undefined, { document: { file_id: 'blocked' } }); assert.equal(e.media.length, 0);
  await f.cb(1, `g:${e.id}`); assert.match(f.calls.at(-1).text, /Guest|User 2/);
});

test('Later immediately lists pending invitations and responded events leave that list', async () => {
  const f = fixture(); const first = await f.create({}); const second = await f.create({});
  await f.msg(2, `/start e_${first.id}`); await f.msg(2, `/start e_${second.id}`);
  await f.cb(2, `r:${first.id}:later`);
  assert.equal(f.store.data.sessions[2], undefined);
  const listed = f.calls.slice(-2).map(c => c.reply_markup?.inline_keyboard?.flat()[0]?.callback_data);
  assert.deepEqual(listed.sort(), [`v:${first.id}`, `v:${second.id}`].sort());
  await f.cb(2, `r:${first.id}:no`); await f.msg(2, '⏭ Skip');
  f.calls.length = 0; await f.msg(2, '⏳ Pending invitations');
  assert.equal(f.calls.filter(c => c.reply_markup?.inline_keyboard).length, 1);
  assert.equal(f.calls.at(-1).reply_markup.inline_keyboard[0][0].callback_data, `v:${second.id}`);
});

test('approval gates location/tickets and only the organiser can approve or reject', async () => {
  const f = fixture(); const e = await f.create({ requireApproval: true }); e.ticketInfo = 'Private entry instructions';
  await f.msg(2, `/start e_${e.id}`); assert.doesNotMatch(f.calls.at(-1).text, /My house|Private entry instructions/);
  await f.cb(2, `r:${e.id}:yes`);
  for (const text of ['👤 Use Telegram name', '⏭ Skip', '⏭ Skip', '⏭ Skip', '⏭ Skip']) await f.msg(2, text);
  assert.equal(e.guests[2].approval, 'pending'); assert.equal(e.guests[2].ticket, undefined);
  assert.ok(f.calls.some(c => /organiser will send/.test(c.text || '')));
  assert.doesNotMatch(f.calls.at(-1).text, /My house|Private entry instructions/);
  await f.cb(2, `approve:${e.id}:2`); assert.equal(e.guests[2].approval, 'pending');
  await f.cb(2, `ticket:${e.id}`); assert.doesNotMatch(f.calls.at(-1).text, /My house|Private entry instructions/);
  await f.cb(1, `approve:${e.id}:2`); assert.equal(e.guests[2].approval, 'approved'); assert.ok(e.guests[2].ticket);
  const ticket = f.calls.find(c => c.chat_id === 2 && c.text?.includes('YOUR INVITATION'));
  assert.match(ticket.text, /My house/); assert.match(ticket.text, /Private entry instructions/);
  await f.cb(2, `r:${e.id}:yes`);
  for (const text of ['👤 Use Telegram name', '⏭ Skip', '⏭ Skip', '⏭ Skip', '⏭ Skip']) await f.msg(2, text);
  await f.cb(1, `reject:${e.id}:2`); assert.equal(e.guests[2].status, 'no'); assert.equal(e.guests[2].ticket, undefined);
});

test('deadline blocks old RSVP buttons and unfinished responses but permits approval', async () => {
  const f = fixture(); const e = await f.create({ requireApproval: true });
  await f.msg(2, `/start e_${e.id}`); await f.cb(2, `r:${e.id}:yes`); await f.msg(2, 'Guest');
  e.responseDeadline = '2020-01-01T00:00:00Z';
  await f.msg(2, '⏭ Skip'); assert.equal(f.store.data.sessions[2], undefined); assert.equal(e.guests[2].status, 'later');
  await f.cb(2, `r:${e.id}:yes`); assert.equal(e.guests[2].status, 'later');
  assert.ok(!f.calls.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data?.startsWith('r:')));
  e.guests[2] = { name: 'Guest', status: 'yes', approval: 'pending', answers: [] };
  await f.cb(1, `approve:${e.id}:2`); assert.equal(e.guests[2].approval, 'approved');
});

test('answering again replaces old answers and navigation discards unfinished input', async () => {
  const f = fixture(); const e = await f.create(); await f.msg(2, `/start e_${e.id}`);
  for (const answer of ['Old answer', 'New answer']) {
    await f.cb(2, `r:${e.id}:yes`);
    for (const text of ['👤 Use Telegram name', '⏭ Skip', answer, '⏭ Skip', '⏭ Skip']) await f.msg(2, text);
  }
  assert.equal(e.guests[2].answers.length, 2); assert.equal(e.guests[2].answers[0].answer, 'New answer');
  await f.cb(2, `r:${e.id}:no`); await f.cb(2, `v:${e.id}`);
  assert.equal(f.store.data.sessions[2], undefined); assert.equal(e.guests[2].status, 'yes');
});
