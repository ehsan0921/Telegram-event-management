import { Bot } from './bot.js';

export async function authorized(request, secret) {
  if (!secret) return false;
  const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([secret, supplied].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function telegram(env, method, params) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10000)
    });
  } catch { return { ok: false, error_code: 503 }; }
  try { return await response.json(); } catch { return { ok: false, error_code: 503 }; }
}

export async function processUpdate(env, update) {
  const owner = crypto.randomUUID();
  const lock = await env.DB.prepare('INSERT INTO lease (id, owner, expires) VALUES (1, ?, unixepoch()+60) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE lease.expires < unixepoch() RETURNING owner').bind(owner).first();
  if (!lock) return new Response('Busy; retry', { status: 503 });
  try {
    if (await env.DB.prepare('SELECT id FROM processed WHERE id=?').bind(update.update_id).first()) return new Response('OK');
    const { results } = await env.DB.prepare('SELECT kind,id,data FROM records').all();
    const data = { events: {}, sessions: {} };
    for (const row of results) data[row.kind][row.id] = JSON.parse(row.data);
    const before = new Map(results.map(r => [`${r.kind}:${r.id}`, r.data]));
    const messages = [];
    // Capture outgoing effects, commit the state, then deliver from the durable outbox.
    const bot = new Bot({ data }, async (method, params) => { messages.push({ method, params }); return {}; }, env.BOT_USERNAME);
    await bot.handle(update);
    const batch = [env.DB.prepare('INSERT INTO commits(owner) VALUES (?)').bind(owner)];
    for (const kind of ['events', 'sessions']) {
      for (const [id, value] of Object.entries(data[kind])) {
        const serialized = JSON.stringify(value);
        if (before.get(`${kind}:${id}`) !== serialized) batch.push(env.DB.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').bind(kind, id, serialized));
        before.delete(`${kind}:${id}`);
      }
    }
    for (const key of before.keys()) {
      const [kind, id] = key.split(':');
      batch.push(env.DB.prepare('DELETE FROM records WHERE kind=? AND id=?').bind(kind, id));
    }
    for (const [index, msg] of messages.entries()) batch.push(env.DB.prepare('INSERT INTO outbox(id,method,params) VALUES (?,?,?)').bind(`${update.update_id}:${String(index).padStart(5, '0')}`, msg.method, JSON.stringify(msg.params)));
    batch.push(env.DB.prepare('INSERT INTO processed(id,at) VALUES (?,unixepoch())').bind(update.update_id));
    batch.push(env.DB.prepare('DELETE FROM commits WHERE owner=?').bind(owner));
    await env.DB.batch(batch);
    return new Response('OK');
  } finally {
    await env.DB.prepare('DELETE FROM lease WHERE owner=?').bind(owner).run();
  }
}

export async function drainOutbox(env) {
  const owner = crypto.randomUUID();
  const lock = await env.DB.prepare('INSERT INTO delivery_lease(id,owner,expires) VALUES (1,?,unixepoch()+60) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE delivery_lease.expires<unixepoch() RETURNING owner').bind(owner).first();
  if (!lock) return;
  const deadline = Date.now() + 20000;
  try {
  const { results } = await env.DB.prepare('SELECT id,due FROM outbox ORDER BY rowid LIMIT 20').all();
  for (const { id, due } of results) {
    if (Date.now() > deadline || due > Math.floor(Date.now() / 1000)) break;
    const row = await env.DB.prepare('UPDATE outbox SET due=unixepoch()+60, attempts=attempts+1 WHERE id=? AND due<=unixepoch() RETURNING *').bind(id).first();
    if (!row) continue;
    const result = await telegram(env, row.method, JSON.parse(row.params));
    if (result.ok || [400, 403].includes(result.error_code)) {
      await env.DB.prepare('DELETE FROM outbox WHERE id=?').bind(id).run();
      if (!result.ok) console.log(JSON.stringify({ event: 'delivery_rejected', method: row.method, code: result.error_code }));
    } else {
      const seconds = Math.max(5, Math.min(result.parameters?.retry_after || 2 ** Math.min(row.attempts, 10), 3600));
      await env.DB.prepare('UPDATE outbox SET due=unixepoch()+? WHERE id=?').bind(seconds, id).run();
      break;
    }
  }
  } finally { await env.DB.prepare('DELETE FROM delivery_lease WHERE owner=?').bind(owner).run(); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return Response.json({ service: 'XEvents', status: 'running' });
    if (url.pathname === '/setup' && request.method === 'POST') {
      if (!await authorized(request, env.TELEGRAM_WEBHOOK_SECRET)) return new Response('Unauthorized', { status: 401 });
      const me = await telegram(env, 'getMe', {});
      if (!me.ok) return Response.json({ configured: false, error: 'Bot token is invalid or unavailable' }, { status: 502 });
      if (me.result.username.toLowerCase() !== env.BOT_USERNAME.toLowerCase()) return Response.json({ configured: false, error: 'Bot username mismatch' }, { status: 409 });
      const hook = await telegram(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, max_connections: 1, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      if (!hook.ok) return Response.json({ configured: false, error: 'Webhook setup failed', code: hook.error_code }, { status: 502 });
      await telegram(env, 'setMyCommands', { commands: [
        { command: 'new', description: 'Create an event' }, { command: 'events', description: 'Your events and invitations' },
        { command: 'cancel', description: 'Stop current input' }, { command: 'help', description: 'How XEvents works' }
      ] });
      const info = await telegram(env, 'getWebhookInfo', {});
      return Response.json({ configured: true, bot: me.result.username, webhook: info.result?.url, pendingUpdates: info.result?.pending_update_count });
    }
    if (url.pathname !== '/telegram' || request.method !== 'POST') return new Response('Not found', { status: 404 });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return new Response('Not configured', { status: 503 });
    if (!await authorized(request, env.TELEGRAM_WEBHOOK_SECRET)) return new Response('Unauthorized', { status: 401 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) return new Response('Too large', { status: 413 });
    let update;
    try { update = JSON.parse(new TextDecoder().decode(bytes)); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (!Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
    try {
      const response = await processUpdate(env, update);
      if (response.ok) ctx.waitUntil(drainOutbox(env));
      return response;
    } catch {
      console.error(JSON.stringify({ event: 'update_failed', update_id: update.update_id }));
      return new Response('Retry later', { status: 503 });
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(drainOutbox(env));
    ctx.waitUntil(env.DB.prepare('DELETE FROM processed WHERE at < unixepoch()-604800').run());
  }
};
