import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'test',
  modules: true, scriptPath: '.wrangler/build/worker.js', compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], bindings: { BOT_USERNAME: 'XEvents_bot', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
  outboundService: async () => new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'Content-Type': 'application/json' } })
  }]
}));
try {
  const db = await mf.getD1Database('DB');
  const schema = await readFile('migrations/0001_initial.sql', 'utf8');
  // Keep the trigger body together; D1 exec accepts one statement per line.
  await db.exec(schema.replace(/\n/g, ' '));
  await db.exec(await readFile('migrations/0002_delivery_lease.sql', 'utf8'));
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
  console.log('Worker integration passed: authentication, D1 persistence, event creation, duplicate handling, lease release. Telegram mocked.');
} finally { await mf.dispose(); }
