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
  async function create() {
    for (const text of ['/new', 'Birthday', '24 October 2026, 6pm Sydney', 'My house', 'Bring a friend', 'Dietary needs?\nWhat will you bring?']) await msg(1, text);
    return Object.values(store.data.events)[0];
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
