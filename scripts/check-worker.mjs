import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'test',
  modules: true, scriptPath: '.wrangler/build/worker.js', compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], bindings: { BOT_USERNAME: 'XEvents_bot', APP_URL: 'https://test/app', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
  outboundService: async () => new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'Content-Type': 'application/json' } })
  }]
}));
try {
  const db = await mf.getD1Database('DB');
  const schema = await readFile('migrations/0001_initial.sql', 'utf8');
  // Keep the trigger body together; D1 exec accepts one statement per line.
  await db.exec(schema.replace(/\n/g, ' '));
  await db.exec(await readFile('migrations/0002_delivery_lease.sql', 'utf8'));
  await db.exec(await readFile('migrations/0003_mini_app.sql', 'utf8'));
  assert.equal((await mf.dispatchFetch('https://test/')).status, 200);
  assert.equal((await mf.dispatchFetch('https://test/telegram', { method: 'POST', body: '{}' })).status, 401);
  async function message(update_id, text) {
    const body = { update_id, message: { from: { id: 123, first_name: 'Tester' }, chat: { id: 123, type: 'private' }, text } };
    const response = await mf.dispatchFetch('https://test/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  const texts = ['/new', 'Cloud event', 'Tomorrow 6pm Sydney', 'Park', '/skip', 'Dietary needs?'];
  for (const [i, text] of texts.entries()) await message(i + 1, text);
  const event = await db.prepare("SELECT data FROM records WHERE kind='events'").first();
  assert.equal(JSON.parse(event.data).title, 'Cloud event');
  await message(6, 'Dietary needs?');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='events'").first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM processed').first()).n, 6);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM lease').first()).n, 0);
  const initData = uid => {
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id: uid, first_name: 'Tester' }), query_id: 'query' });
    const data = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const key = createHmac('sha256', 'WebAppData').update('fake').digest();
    params.set('hash', createHmac('sha256', key).update(data).digest('hex')); return params.toString();
  };
  async function api(path, input, uid = 123) {
    const response = await mf.dispatchFetch('https://test/api/' + path, { method: input ? 'POST' : 'GET', headers: { Authorization: 'tma ' + initData(uid), 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await mf.dispatchFetch('https://test/api/bootstrap')).status, 401);
  assert.equal((await api('bootstrap')).data.events.length, 1);
  assert.equal((await api('bootstrap', null, 456)).data.events.length, 0);
  assert.equal((await api('preferences', { timezone: 'America/New_York' })).status, 200);
  const input = { title: 'Mini app event', location: 'Cafe', description: '', questions: 'Diet?', date: '2026-10-24', time: '18:00', timezone: 'Australia/Sydney', requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const made = await api('events', input); assert.equal(made.status, 200); assert.equal(made.data.event.startsAt, '2026-10-24T07:00:00Z');
  assert.equal((await api('events', input)).data.event.id, made.data.event.id);
  assert.equal((await api('bootstrap')).data.events.length, 2);
  assert.equal((await api('bootstrap')).data.preference.timezone, 'America/New_York');
  const path = `events/${made.data.event.id}/schedule`;
  assert.equal((await api(path, { ...input, time: '19:00' }, 456)).status, 400);
  assert.equal((await api(path, { ...input, time: '19:00' })).data.event.startsAt, '2026-10-24T08:00:00Z');
  assert.equal((await api('preview', { date: '2026-10-04', time: '02:30', timezone: 'Australia/Sydney' })).status, 400);
  await message(7, '/new'); await message(8, 'Picker event'); await message(9, '🗓 Pick date & time');
  const bootstrap = (await api('bootstrap')).data;
  assert.ok(bootstrap.session.token);
  assert.equal((await api('picker', { ...input, sessionToken: 'wrong' })).status, 400);
  assert.equal((await api('picker', { ...input, sessionToken: bootstrap.session.token })).status, 200);
  const session = JSON.parse((await db.prepare("SELECT data FROM records WHERE kind='sessions' AND id='123'").first()).data);
  assert.equal(session.step, 'location'); assert.equal(session.draft.startsAt, '2026-10-24T07:00:00Z');
  assert.equal((await api('picker', { ...input, sessionToken: bootstrap.session.token })).status, 400);
  await message(10, 'Park'); await message(11, '/skip'); await message(12, '/skip');
  assert.equal((await api('bootstrap')).data.events.find(e => e.title === 'Picker event').startsAt, '2026-10-24T07:00:00Z');
  console.log('Worker integration passed: webhook and Mini App authentication, timezone persistence, private event access, date conversion, idempotent creation, organiser permissions, and chat picker continuation. Telegram mocked.');
} finally { await mf.dispose(); }
