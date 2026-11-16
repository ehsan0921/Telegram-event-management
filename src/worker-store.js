import {flushProgress} from './media-progress-core.js';
import { Bot } from './bot.js';
import {readAlbumMembers} from './album-members.js';
import {readOnlinePricing} from './exchange.js';
import { snapshotActive } from './snapshot-mode.js';
import { mayUseTestApp, TestAccessError } from './test-access.js';

export class BusyError extends Error {}

export async function mutateState(env, action, updateId, scope) {
  const owner = crypto.randomUUID();
  let lock;
  for(let attempt=0;attempt<21;attempt++){
    lock=await env.DB.prepare('INSERT INTO lease (id, owner, expires) VALUES (1, ?, unixepoch()+60) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE lease.expires < unixepoch() RETURNING owner').bind(owner).first();
    if(lock)break;
    if(attempt<20)await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (!lock) throw new BusyError('Please try again in a moment.');
  try {
    if (env.snapshotUser && !await mayUseTestApp(env, env.snapshotUser)) throw new TestAccessError();
    if (updateId !== undefined && await env.DB.prepare('SELECT id FROM processed WHERE id=?').bind(updateId).first()) return;
    let query=env.DB.prepare("SELECT kind,id,data FROM records WHERE kind IN ('events','sessions','preferences')");
    if(scope){
      const users=scope.users,events=scope.events,marks=values=>values.map(()=>'?').join(',');
      // Load whole records for these recipients and their delivery albums only.
      // The before-map below contains only loaded records, so other rows cannot
      // be deleted or overwritten by a scoped media mutation.
      query=env.DB.prepare(`SELECT kind,id,data FROM records WHERE (kind IN ('preferences','sessions') AND id IN (${marks(users)})) OR (kind='events' AND (id IN (${marks(events)}) OR id IN (SELECT j.key FROM records p,json_each(p.data,'$.mediaDelivery') j WHERE p.kind='preferences' AND p.id IN (${marks(users)}))))`).bind(...users,...events,...users);
    }
    const {results}=await query.all();
    if(scope){
      const albums=results.filter(row=>row.kind==='events').map(row=>JSON.parse(row.data));
      const sources=[...new Set(albums.flatMap(e=>(e.media || []).map(file=>file.reference?.event).filter(Boolean)))];
      const creators=[...new Set(albums.filter(e=>e.media?.some(file=>file.reference)).map(e=>String(e.owner)))];
      if(sources.length){
        const extra=await env.DB.prepare("SELECT kind,id,data FROM records WHERE (kind='events' AND id IN (SELECT value FROM json_each(?))) OR (kind='preferences' AND id IN (SELECT value FROM json_each(?)))").bind(JSON.stringify(sources),JSON.stringify(creators)).all();
        const loaded=new Set(results.map(row=>row.kind+':'+row.id));for(const row of extra.results)if(!loaded.has(row.kind+':'+row.id))results.push(row);
      }
    }
    const data = { events: {}, sessions: {}, preferences: {} };
    for (const row of results) data[row.kind][row.id] = JSON.parse(row.data);
    const before = new Map(results.map(r => [`${r.kind}:${r.id}`, r.data]));
    const messages = [];
    const bot = new Bot({ data }, async (method, params) => { messages.push({ method, params }); return {}; }, env.BOT_USERNAME, env.APP_URL);
    bot.durableMediaDelivery=true;
    bot.productionSnapshot = await snapshotActive(env);
    bot.albumMembersFor=e=>readAlbumMembers(env,e);
    bot.pricing=scope?undefined:await readOnlinePricing(env,data.preferences._pricing);
    const settings = [];
    bot.resumeMedia=id=>settings.push(env.DB.prepare("UPDATE records SET data=json_set(data,'$.blocked',0) WHERE kind='media_chat_state' AND id=?").bind(String(id)));
    const value = await action(data, bot, {
      persist(sql, ...args) { settings.push(env.DB.prepare(sql).bind(...args)); },
      setAppSetting(key, value) {
        settings.push(env.DB.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value));
      }
    });
    await flushProgress(bot,scope?new Set(scope.users):null);
    const batch = [env.DB.prepare('INSERT INTO commits(owner) VALUES (?)').bind(owner), ...settings];
    for (const kind of ['events', 'sessions', 'preferences']) {
      for (const [id, record] of Object.entries(data[kind])) {
        const serialized = JSON.stringify(record);
        if (before.get(`${kind}:${id}`) !== serialized) batch.push(env.DB.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').bind(kind, id, serialized));
        before.delete(`${kind}:${id}`);
      }
    }
    for (const key of before.keys()) {
      const [kind, id] = key.split(':');
      batch.push(env.DB.prepare('DELETE FROM records WHERE kind=? AND id=?').bind(kind, id));
    }
    const prefix = updateId === undefined ? crypto.randomUUID() : String(updateId);
    for (const [index, msg] of messages.entries()) batch.push(env.DB.prepare('INSERT INTO outbox(id,method,params) VALUES (?,?,?)').bind(`${prefix}:${String(index).padStart(5, '0')}`, msg.method, JSON.stringify(msg.params)));
    if (updateId !== undefined) batch.push(env.DB.prepare('INSERT INTO processed(id,at) VALUES (?,unixepoch())').bind(updateId));
    batch.push(env.DB.prepare('DELETE FROM commits WHERE owner=?').bind(owner));
    await env.DB.batch(batch);
    return value;
  } finally { await env.DB.prepare('DELETE FROM lease WHERE owner=?').bind(owner).run(); }
}

// Call only for permission checks, media receipts and their progress notices.
// General bot actions retain the complete state view and existing transaction.
export function mutateMediaState(env,items,action){
  const users=[...new Set(items.map(item=>String(item.user)))],events=[...new Set(items.map(item=>String(item.event)))];
  return mutateState(env,action,undefined,{users,events});
}
