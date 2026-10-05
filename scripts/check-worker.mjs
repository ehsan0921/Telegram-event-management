import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'test',
  modules: true, scriptPath: '.wrangler/build/worker.js', compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], bindings: { BOT_USERNAME: 'XEvents_bot', APP_URL: 'https://test/app', TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_WEBHOOK_SECRET: 'test-secret' },
  outboundService: async request => {
    if (request.url.includes('/file/bot')) return new Response(new Uint8Array([255,216,255]), { headers: { 'Content-Type':'image/jpeg' } });
    return new Response(JSON.stringify({ ok: true, result: request.url.endsWith('/sendPhoto') ? { photo:[{file_id:'test-banner'}] } : request.url.endsWith('/getFile') ? {file_path:'photos/banner.jpg'} : {} }), { headers: { 'Content-Type': 'application/json' } });
  }
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
  async function message(update_id, text, uid = 123) {
    const body = { update_id, message: { from: { id: uid, first_name: 'Tester' }, chat: { id: uid, type: 'private' }, text } };
    const response = await mf.dispatchFetch('https://test/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  async function callback(update_id, data, uid = 123) {
    const response = await mf.dispatchFetch('https://test/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify({ update_id, callback_query: { id: String(update_id), from: { id: uid, first_name: 'Tester' }, data } }) });
    assert.equal(response.status, 200);
  }
  const texts = ['/new', 'Cloud event', 'Tomorrow 6pm Sydney', 'Park', '/skip', 'Dietary needs?'];
  for (const [i, text] of texts.entries()) await message(i + 1, text);
  const creationToken = JSON.parse((await db.prepare("SELECT data FROM records WHERE kind='sessions' AND id='123'").first()).data).token;
  await callback(1001, `pd:${creationToken}`);
  const event = await db.prepare("SELECT data FROM records WHERE kind='events'").first();
  assert.equal(JSON.parse(event.data).title, 'Cloud event');
  await message(6, 'Dietary needs?');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='events'").first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM processed').first()).n, 7);
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
  assert.equal((await api('admin/overview',null,123)).status,403);
  assert.equal((await api('bootstrap')).data.user.isSuperAdmin,false);
  assert.equal((await api('bootstrap',null,123456789)).data.user.isSuperAdmin,true);
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
  const deadlineSession = (await api('bootstrap')).data.session;
  assert.equal((await api('draft-deadline', { date: '2026-10-20', time: '12:00', timezone: 'Australia/Sydney', sessionToken: deadlineSession.token })).status, 200);
  await callback(1002, `pd:${deadlineSession.token}`);
  assert.equal((await api('bootstrap')).data.events.find(e => e.title === 'Picker event').startsAt, '2026-10-24T07:00:00Z');
  const privateInput = { ...input, requestId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', title: 'Approval event', location: 'SECRET LOCATION', questions: '', requireApproval: true, hideLocation: true, ticketInfo: 'SECRET TICKET', deadlineDate: '2026-10-20', deadlineTime: '12:00', permissions: { guestList: false, uploadMedia: false, viewMedia: false } };
  const privateMade = await api('events', privateInput); assert.equal(privateMade.status, 200);
  const privateId = privateMade.data.event.id;
  assert.equal((await api('events', { ...privateInput, requestId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', deadlineDate: '2026-10-25' })).status, 400);
  await message(20, `/start e_${privateId}`, 456);
  let guestView = (await api('bootstrap', null, 456)).data.events[0];
  assert.equal(guestView.location, null); assert.equal(guestView.counts, null); assert.equal(guestView.ticket, null);
  assert.doesNotMatch(JSON.stringify(guestView), /SECRET/);
  await callback(21, `r:${privateId}:yes`, 456);
  await message(22, 'Guest', 456); await message(23, '/skip', 456); await message(24, '/skip', 456);
  guestView = (await api('bootstrap', null, 456)).data.events[0]; assert.equal(guestView.approval, 'pending'); assert.equal(guestView.location, null);
  await callback(25, `approve:${privateId}:456`, 456); assert.equal((await api('bootstrap', null, 456)).data.events[0].approval, 'pending');
  await db.prepare("UPDATE records SET data=json_set(data,'$.responseDeadline','2020-01-01T00:00:00Z') WHERE kind='events' AND id=?").bind(privateId).run();
  await callback(26, `r:${privateId}:no`, 456); assert.equal((await api('bootstrap', null, 456)).data.events[0].status, 'yes');
  await callback(27, `approve:${privateId}:456`);
  guestView = (await api('bootstrap', null, 456)).data.events[0]; assert.equal(guestView.approval, 'approved'); assert.equal(guestView.location, 'SECRET LOCATION'); assert.equal(guestView.ticket.info, 'SECRET TICKET'); assert.ok(guestView.ticket.code);
  assert.equal((await api('bootstrap')).data.events.find(e => e.id === privateId).counts.yes, 1);
  assert.equal((await api('bootstrap', null, 789)).data.events.length, 0);
  assert.equal((await api(`events/${privateId}/reminder`, {minutes:60},456)).status,200);
  assert.equal((await api('bootstrap',null,456)).data.events[0].reminder,60);
  assert.equal((await api(`events/${privateId}/reminder`, {minutes:60},789)).status,400);
  assert.equal((await api(`events/${privateId}/reminder`, {minutes:0},456)).status,200);
  const form=new FormData(); form.set('photo',new File([new Uint8Array([255,216,255])],'banner.jpg',{type:'image/jpeg'}));
  const uploadRequest=new Request('https://test/upload',{method:'POST',body:form});
  const uploadBytes=await uploadRequest.arrayBuffer(); const uploadType=uploadRequest.headers.get('Content-Type');
  assert.equal((await mf.dispatchFetch(`https://test/api/events/${privateId}/banner`,{method:'POST',headers:{Authorization:'tma '+initData(456),'Content-Type':uploadType},body:uploadBytes})).status,403);
  const uploaded=await mf.dispatchFetch(`https://test/api/events/${privateId}/banner`,{method:'POST',headers:{Authorization:'tma '+initData(123),'Content-Type':uploadType},body:uploadBytes});
  assert.equal(uploaded.status,200); assert.equal((await uploaded.json()).event.hasBanner,true);
  assert.equal((await mf.dispatchFetch(`https://test/api/events/${privateId}/banner`,{headers:{Authorization:'tma '+initData(789)}})).status,403);
  const image=await mf.dispatchFetch(`https://test/api/events/${privateId}/banner`,{headers:{Authorization:'tma '+initData(456)}});
  assert.equal(image.status,200); assert.equal(image.headers.get('Content-Type'),'image/jpeg'); assert.equal((await image.arrayBuffer()).byteLength,3);
  const overview=await api('admin/overview',null,123456789);
  assert.equal(overview.status,200);
  assert.equal(overview.data.events.length,(await api('bootstrap')).data.events.length);
  assert.equal(overview.data.events.find(e=>e.id===privateId).location,'SECRET LOCATION');
  assert.equal(overview.data.events.find(e=>e.id===privateId).guests[0].id,456);
  assert.ok(overview.data.users.some(u=>u.id===123 && u.organised.includes(privateId)));
  assert.ok(overview.data.users.some(u=>u.id===456 && u.invited.includes(privateId)));
  assert.ok(overview.data.users.some(u=>u.id===123456789 && u.firstName==='Tester'));
  assert.doesNotMatch(JSON.stringify(overview.data),/sessionToken|test-secret|test-banner|query_id/);
  assert.equal((await api('admin/overview',null,456)).status,403);
  assert.equal((await api('admin/overview',{id:123456789},456)).status,403);
  const disposable=await api('events',{...input,requestId:'dddddddd-dddd-dddd-dddd-dddddddddddd',defaultReminder:240});
  const disposableId=disposable.data.event.id; assert.equal(disposable.data.event.defaultReminder,240);
  assert.equal((await api(`events/${disposableId}/cancel`,{confirm:true},456)).status,400);
  assert.equal((await api(`events/${disposableId}/delete`,{confirm:false})).status,400);
  assert.equal((await api(`events/${disposableId}/cancel`,{confirm:true})).status,200);
  assert.equal((await api('bootstrap')).data.events.find(e=>e.id===disposableId).cancelled,true);
  assert.equal((await api(`events/${disposableId}/delete`,{confirm:true})).status,200);
  assert.ok(!(await api('bootstrap')).data.events.some(e=>e.id===disposableId));
  console.log('Worker integration passed: authentication, timezone/date conversion, opt-in guest settings, private data, deadlines, approvals/tickets, and chat picker continuation. Telegram mocked.');
} finally { await mf.dispose(); }
