import {progressStats,progressKeyboard} from '../src/media-progress-core.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {photoCollection} from '../src/permissions.js';
import worker,{processUpdate,drainOutbox} from '../src/worker.js';
import {mediaApi} from '../src/media-api.js';

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const file of ['0001_initial.sql','0002_delivery_lease.sql','0003_mini_app.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const album=photoCollection('Fictional memories',1);
  album.media=[{id:'111111111111',type:'photo',fileId:'fictional-photo',name:'Fictional uploader',by:1,caption:'Fictional sunset'}];
  const save=(kind,id,value)=>db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,String(id),JSON.stringify(value));
  const read=(kind,id)=>JSON.parse(db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,String(id)).data);
  save('events',album.id,album);save('preferences',2,{mediaAccess:{[album.id]:album.viewToken}});save('preferences',3,{mediaAccess:{[album.id]:album.uploadToken}});
  let failReceipt=false;
  const env={APP_ENV:'production',BOT_USERNAME:'FictionalBot',APP_URL:'https://example.test/app',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args) || null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return db.prepare(sql).run(...this.args);}};},async batch(statements){
    if(failReceipt && statements.some(s=>s.args.some(value=>typeof value==='string' && value.includes('"received":["111111111111"]')))){failReceipt=false;throw Error('Fictional receipt failure');}
    db.exec('BEGIN');try{for(const s of statements)db.prepare(s.sql).run(...s.args);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }}};
  const sent=[];let rejectMedia=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const params=JSON.parse(options.body),method=url.split('/').at(-1);sent.push({method,...params});
    assert.equal(params.__mediaDelivery,undefined);assert.equal(params.__mediaDelivered,undefined);
    return Response.json(rejectMedia && method==='sendPhoto'?{ok:false,error_code:400}:{ok:true,result:{message_id:sent.length}});
  });
  let next=100;
  const cb=(id,action,arg)=>processUpdate(env,{update_id:next++,callback_query:{id:'fictional-'+next,from:{id,first_name:'Fictional'},data:`${action}:${album.id}${arg?':'+arg:''}`}});
  const state=id=>read('preferences',id).mediaDelivery?.[album.id];
  const upload=async()=>{
    save('sessions',3,{event:album.id,step:'upload',uploadToken:album.uploadToken});
    await processUpdate(env,{update_id:next++,message:{chat:{id:3,type:'private'},from:{id:3,first_name:'Fictional contributor'},photo:[{file_id:'fictional-new-photo'}]}});
  };
  return {db,album,env,sent,save,read,cb,state,upload,failReceipt(){failReceipt=true;},rejectMedia(){rejectMedia=true;}};
}

test('viewer and contributor menus share layout while viewers never receive contributor tokens or upload access',async t=>{
  const f=fixture(t);
  await f.cb(2,'v');await f.cb(3,'v');
  const menus=f.db.prepare("SELECT params FROM outbox WHERE method='sendMessage' ORDER BY rowid").all().map(row=>JSON.parse(row.params));
  const viewer=menus[0],contributor=menus[1];
  assert.deepEqual(viewer.reply_markup.inline_keyboard[1].map(b=>b.text),['📥 Get all (1)','🆕 Get new (1)']);
  assert.equal(viewer.reply_markup.inline_keyboard[0][0].web_app.url,`https://example.test/app?gallery=${f.album.id}`);
  assert.ok(!JSON.stringify(viewer).includes(f.album.uploadToken));assert.ok(JSON.stringify(viewer).includes('media-add:'));
  assert.ok(JSON.stringify(contributor).includes('media-add:'));assert.ok(!JSON.stringify(contributor).includes(f.album.uploadToken));
  assert.ok(JSON.stringify(viewer).includes('Follow:ON'));assert.ok(JSON.stringify(contributor).includes('Follow:ON'));
});

test('photo links follow by default, deliver new uploads and preserve saved Off on reopening either link',async t=>{
  const f=fixture(t);
  const open=(update_id,prefix,token)=>processUpdate(f.env,{update_id,message:{chat:{id:2,type:'private'},from:{id:2,first_name:'Fictional viewer'},text:`/start ${prefix}_${token}`}});
  await open(900,'p',f.album.viewToken);
  assert.equal(f.state(2).follow,true);assert.ok(f.state(2).followToken);
  await f.upload();await drainOutbox(f.env);
  assert.equal(f.sent.filter(row=>row.method==='sendPhoto' && row.chat_id===2).length,1);
  await f.cb(2,'media-follow','off');
  for(const [index,prefix,token] of [[901,'p',f.album.viewToken],[902,'u',f.album.uploadToken]]){
    await open(index,prefix,token);assert.equal(f.state(2).follow,false);
  }
  await f.upload();await drainOutbox(f.env);
  assert.equal(f.sent.filter(row=>row.method==='sendPhoto' && row.chat_id===2).length,1);
});

test('get new tracks successful deliveries only, deduplicates pending presses, and get all can resend',async t=>{
  const f=fixture(t);
  await f.cb(2,'media-get','new');await f.cb(2,'media-get','new');
  assert.deepEqual(f.state(2).received,[]);assert.equal(Object.keys(f.state(2).pending).length,1);
  await drainOutbox(f.env);
  assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);assert.deepEqual(f.state(2).received,['111111111111']);
  await f.cb(2,'media-get','new');await drainOutbox(f.env);assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
  await f.cb(2,'media-get','all');await drainOutbox(f.env);assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,2);
});

test('successful sends persist a receipt before state updates, so a receipt retry does not resend the file',async t=>{
  const f=fixture(t);await f.cb(2,'media-get','new');f.failReceipt();
  await assert.rejects(drainOutbox(f.env),/Fictional receipt failure/);
  assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
  f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.deepEqual(f.state(2).received,['111111111111']);assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
});

test('failed Telegram media remains new and revoked access cancels queued delivery',async t=>{
  const f=fixture(t);f.rejectMedia();await f.cb(2,'media-get','new');await drainOutbox(f.env);
  assert.deepEqual(f.state(2).received,[]);assert.deepEqual(f.state(2).pending,{});
  await f.cb(2,'media-get','new');f.save('preferences',2,{mediaAccess:{}});await drainOutbox(f.env);
  assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
});

test('Mini App sends report durable queue state, reuse existing file IDs and recheck revocation before delivery',async t=>{
  const f=fixture(t),path=`https://fictional.test/api/events/${f.album.id}/media/111111111111/send`;
  const first=await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});
  const initial=await first.json();assert.equal(initial.queued,true);assert.equal(initial.alreadyQueued,false);assert.equal(initial.status,'queued');assert.match(initial.request,/^[a-f0-9]{16}$/);
  const again=await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});
  const repeated=await again.json();assert.equal(repeated.queued,true);assert.equal(repeated.alreadyQueued,true);assert.equal(repeated.request,initial.request);
  assert.equal(f.sent.length,0);await drainOutbox(f.env);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].photo,'fictional-photo');
  await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});
  f.save('preferences',2,{mediaAccess:{}});await drainOutbox(f.env);assert.equal(f.sent.length,1);
  assert.equal((await mediaApi(new Request(path),f.env,{id:2})).status,403);
});

test('429 keeps media pending and new until a successful retry',async t=>{
  const f=fixture(t);let limited=true;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const params=JSON.parse(options.body);
    if(params.photo && limited)return Response.json({ok:false,error_code:429,parameters:{retry_after:7}});
    return Response.json({ok:true,result:{message_id:123}});
  });
  await f.cb(2,'media-get','new');await drainOutbox(f.env);
  assert.deepEqual(f.state(2).received,[]);assert.equal(Object.keys(f.state(2).pending).length,1);
  assert.ok(f.db.prepare("SELECT due FROM outbox WHERE method='sendPhoto'").get().due>Math.floor(Date.now()/1000));
  limited=false;f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.deepEqual(f.state(2).received,['111111111111']);assert.deepEqual(f.state(2).pending,{});
});

test('follow sends new uploads with notification, stops before delivery when switched off, and preserves hidden attribution',async t=>{
  const f=fixture(t);await f.cb(2,'media-follow','on');await drainOutbox(f.env);await f.upload();await drainOutbox(f.env);
  let photos=f.sent.filter(row=>row.method==='sendPhoto');assert.equal(photos.length,1);assert.equal(photos[0].chat_id,2);assert.match(photos[0].caption,/New media · Fictional memories/);assert.notEqual(photos[0].disable_notification,true);
  await f.upload();await f.cb(2,'media-follow','off');await drainOutbox(f.env);assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
  await f.cb(2,'media-follow','on');const album=f.read('events',f.album.id);album.showUploaders=false;f.save('events',album.id,album);
  await f.upload();await drainOutbox(f.env);photos=f.sent.filter(row=>row.method==='sendPhoto');assert.equal(photos.length,2);assert.doesNotMatch(photos[1].caption,/Shared by/);
});

function batchFixture(t,types){
  const f=fixture(t);f.mode='success';f.requests=[];f.ui=[];f.uiId=10000;
  f.album.media=types.map((type,index)=>({id:(index+1).toString(16).padStart(12,'0'),type,fileId:'fictional-'+index,name:'Fictional uploader',by:1}));
  f.save('events',f.album.id,f.album);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1),params=JSON.parse(options.body);
    assert.ok(!Object.keys(params).some(key=>key.startsWith('__')));
    if(!['sendMediaGroup','sendPhoto','sendVideo','sendDocument','sendVoice'].includes(method)){f.ui.push({method,params});return Response.json({ok:true,result:{message_id:params.message_id || ++f.uiId,chat:{id:params.chat_id}}});}
    f.requests.push({method,params});
    if(f.mode==='timeout')throw Error('Fictional timeout');
    if(f.mode==='429')return Response.json({ok:false,error_code:429,parameters:{retry_after:7}});
    if(f.mode==='400')return Response.json({ok:false,error_code:400});
    const messages=(params.media || [params]).map((_,index)=>({message_id:f.requests.length*100+index+1,chat:{id:params.chat_id}}));
    return Response.json({ok:true,result:f.mode==='partial'?messages.slice(1):method==='sendMediaGroup'?messages:messages[0]});
  });
  let textId=100000;
  f.pressCancel=(id=2,number)=>{const pref=f.read('preferences',id),pointer=pref.mediaKeyboard,job=pointer && pref.mediaDelivery[pointer.event].jobs[pointer.job];return processUpdate(f.env,{update_id:textId++,message:{chat:{id,type:'private'},from:{id},text:number===undefined?progressKeyboard(job).keyboard[0][0].text:`✖ Cancel #${number}`}});};
  return f;
}

test('200 photos queue and deliver as twenty ordered albums with existing file IDs',async t=>{
  const f=batchFixture(t,Array(200).fill('photo')),start=performance.now();
  await f.cb(2,'media-get','all');const queuedAt=performance.now();
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbox WHERE method='sendMediaGroup'").get().n,20);
  await drainOutbox(f.env);const deliveredAt=performance.now();
  assert.equal(f.requests.length,20);assert.ok(f.requests.every(r=>r.method==='sendMediaGroup' && r.params.media.length===10));
  assert.deepEqual(f.requests.flatMap(r=>r.params.media.map(item=>item.media)),f.album.media.map(file=>file.fileId));
  assert.equal(f.state(2).received.length,200);assert.equal(Object.keys(f.state(2).pending).length,0);
  console.log(JSON.stringify({syntheticMediaStages:{files:200,enqueueMs:Math.round((queuedAt-start)*100)/100,drainMs:Math.round((deliveredAt-queuedAt)*100)/100,telegramRequests:20,telegramNetwork:'mocked',physicalWebView:false}}));
});

test('mixed media preserves order and falls back to native sends for unsupported album types and remainders',async t=>{
  const f=batchFixture(t,['photo','video','document','voice','photo']);
  await f.cb(2,'media-get','all');await drainOutbox(f.env);
  assert.deepEqual(f.requests.map(r=>r.method),['sendMediaGroup','sendDocument','sendVoice','sendPhoto']);
  assert.deepEqual(f.requests[0].params.media.map(item=>item.type),['photo','video']);
  assert.equal(f.state(2).received.length,5);
});

test('album delivery rechecks per-file removal and revoked viewing access before sending',async t=>{
  const f=batchFixture(t,['photo','photo','photo']);await f.cb(2,'media-get','all');
  f.album.media.splice(1,1);f.save('events',f.album.id,f.album);await drainOutbox(f.env);
  assert.equal(f.requests[0].params.media.length,2);assert.equal(f.state(2).received.length,2);
  await f.cb(2,'media-get','all');f.save('preferences',2,{mediaAccess:{}});await drainOutbox(f.env);
  assert.equal(f.requests.length,1);
});

test('rate-limited first album delays later albums for that recipient and preserves order on retry',async t=>{
  const f=batchFixture(t,Array(21).fill('photo'));f.mode='429';
  await f.cb(2,'media-get','all');await drainOutbox(f.env);assert.equal(f.requests.length,1);
  await drainOutbox(f.env);assert.equal(f.requests.length,1);
  assert.equal(f.state(2).received.length,0);assert.equal(Object.keys(f.state(2).pending).length,21);
  f.mode='success';f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,21);
  assert.deepEqual(f.requests.slice(1).flatMap(r=>r.params.media?r.params.media.map(x=>x.media):[r.params.photo]),f.album.media.map(file=>file.fileId));
});

for(const mode of ['timeout','partial'])test(`${mode} album outcome is unconfirmed and cannot be blindly resent`,async t=>{
  const f=batchFixture(t,['photo','photo']);f.mode=mode;
  await f.cb(2,'media-get','all');await drainOutbox(f.env);
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,0);
  assert.equal(Object.keys(f.state(2).uncertain).length,2);
  await drainOutbox(f.env);await f.cb(2,'media-get','new');await drainOutbox(f.env);assert.equal(f.requests.length,1);
  await f.cb(2,'media-retry','review');await drainOutbox(f.env);assert.equal(f.requests.length,1);
  const messages=f.db.prepare("SELECT params FROM outbox WHERE method='sendMessage'").all();
  assert.ok(messages.every(row=>!JSON.parse(row.params).text.includes('all delivered')));
  f.mode='success';await f.cb(2,'media-retry','confirm');await drainOutbox(f.env);
  assert.equal(f.requests.length,2);assert.equal(f.state(2).received.length,2);
});

test('known album rejection leaves each file new; successful receipt persistence retries never resend',async t=>{
  const f=batchFixture(t,['photo','photo']);f.mode='400';
  await f.cb(2,'media-get','all');await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,0);assert.deepEqual(f.state(2).pending,{});
  f.mode='success';await f.cb(2,'media-get','new');
  const batch=f.env.DB.batch;let fail=true;
  f.env.DB.batch=async statements=>{if(fail && statements.some(s=>s.args.some(value=>typeof value==='string' && value.includes('"received":["')))){fail=false;throw Error('Fictional receipt commit failure');}return batch(statements);};
  await assert.rejects(drainOutbox(f.env),/receipt commit failure/);assert.equal(f.requests.length,2);
  f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);assert.equal(f.requests.length,2);assert.equal(f.state(2).received.length,2);
});

test('a crash after attempting an album is not replayed when its API receipt could not be persisted',async t=>{
  const f=batchFixture(t,['photo','photo']);await f.cb(2,'media-get','all');
  const prepare=f.env.DB.prepare;let fail=true;
  f.env.DB.prepare=sql=>{const statement=prepare(sql);if(sql==='UPDATE outbox SET params=? WHERE id=?'){
    const run=statement.run;statement.run=async()=>{if(fail && statement.args[0]?.includes('__mediaGroupDelivered')){fail=false;throw Error('Fictional receipt persistence interruption');}return run.call(statement);};
  }return statement;};
  await assert.rejects(drainOutbox(f.env),/receipt persistence interruption/);
  f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,0);assert.equal(Object.keys(f.state(2).uncertain).length,2);
});

test('/refresh preserves upload input and never queues or resends media',async t=>{
  const f=batchFixture(t,['photo','photo']);
  const update=id=>({update_id:id,message:{chat:{id:2,type:'private'},from:{id:2},text:'/refresh'}});
  await processUpdate(f.env,update(5000));await drainOutbox(f.env);assert.equal(f.requests.length,0);
  f.save('sessions',2,{event:f.album.id,step:'upload',uploadBatch:'fictional-batch'});
  await processUpdate(f.env,update(5001));await drainOutbox(f.env);
  assert.equal(f.read('sessions',2).step,'upload');assert.equal(f.requests.length,0);
});

test('an unconfirmed single send is blocked at the Mini App API until explicit review',async t=>{
  const f=batchFixture(t,['photo']);f.mode='timeout';
  const path=`https://fictional.test/api/events/${f.album.id}/media/${f.album.media[0].id}/send`;
  await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});await drainOutbox(f.env);
  const response=await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});
  assert.equal(response.status,200);assert.equal((await response.json()).status,'unconfirmed');
  assert.equal(f.requests.length,1);
});

test('document and audio files use compatible native groups of up to ten',async t=>{
  const f=batchFixture(t,[...Array(11).fill('document'),...Array(2).fill('audio')]);
  await f.cb(2,'media-get','all');await drainOutbox(f.env);
  assert.deepEqual(f.requests.map(r=>r.method),['sendMediaGroup','sendDocument','sendMediaGroup']);
  assert.deepEqual(f.requests.filter(r=>r.params.media).map(r=>r.params.media.map(file=>file.type)),[Array(10).fill('document'),Array(2).fill('audio')]);
  assert.equal(f.state(2).received.length,13);
});
test('legacy queued document rows are grouped from their current authorized media type without resetting receipts',async t=>{
  const f=batchFixture(t,Array(21).fill('document'));
  await f.cb(2,'media-get','all');
  // Recreate the durable shape observed in the live pre-upgrade backlog.
  f.db.prepare("DELETE FROM outbox WHERE method IN ('sendMediaGroup','sendDocument')").run();
  const state=f.state(2);
  for(const file of f.album.media){const tracking={event:f.album.id,media:file.id,user:2,token:state.pending[file.id],grant:f.album.viewToken};f.db.prepare('INSERT INTO outbox(id,method,params) VALUES (?,?,?)').run('fictional-legacy-'+file.id,'sendDocument',JSON.stringify({chat_id:2,document:file.fileId,__mediaDelivery:tracking}));}
  await drainOutbox(f.env);assert.deepEqual(f.requests.map(r=>r.method),['sendMediaGroup','sendMediaGroup','sendDocument']);assert.equal(f.state(2).received.length,21);
});
test('Cancel during an in-flight album preserves its receipt, stops later batches and permits Get new without duplicates',async t=>{
  const f=batchFixture(t,Array(21).fill('photo'));await f.cb(2,'media-get','all');
  let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const originalFetch=globalThis.fetch;let once=true;
  t.mock.method(globalThis,'fetch',async(...args)=>{if(once && args[0].endsWith('/sendMediaGroup')){once=false;enter();await gate;}return originalFetch(...args);});
  const sending=drainOutbox(f.env);await entered;
  const generation=f.state(2).deliveryGeneration;
  await f.pressCancel(2);release();await sending;
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,10);assert.equal(Object.keys(f.state(2).pending).length,0);
  await f.cb(2,'media-get','new');await drainOutbox(f.env);
  const files=f.requests.flatMap(r=>r.params.media?r.params.media.map(x=>x.media):[r.params.photo]);assert.equal(files.length,21);assert.equal(new Set(files).size,21);assert.equal(f.state(2).received.length,21);
});
test('Cancel is scoped to one recipient and stale Cancel buttons cannot stop a later delivery',async t=>{
  const f=batchFixture(t,['photo','photo']);await f.cb(2,'media-get','all');await f.cb(3,'media-get','all');
  const old=f.read('preferences',2).mediaKeyboard.number;await f.pressCancel(2,old);await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,0);assert.equal(f.state(3).received.length,2);
  await f.cb(2,'media-get','new');assert.notEqual(f.read('preferences',2).mediaKeyboard.number,old);
  await f.pressCancel(2,old);await drainOutbox(f.env);assert.equal(f.state(2).received.length,2);
});

test('event Follow is opt-in and follows new media without changing event RSVP or invitation data',async t=>{
  const f=fixture(t);delete f.album.kind;f.album.guests={2:{name:'Guest',status:'yes'},3:{name:'Uploader',status:'yes'}};f.save('events',f.album.id,f.album);
  await f.cb(2,'m','0');assert.equal(f.state(2).follow,false);await f.upload();assert.deepEqual(f.state(2).pending,{});
  await f.cb(2,'media-follow','on');await f.upload();await drainOutbox(f.env);
  assert.equal(f.sent.filter(r=>r.method==='sendPhoto' && r.chat_id===2).length,1);
  assert.deepEqual(f.read('events',f.album.id).guests,f.album.guests);
});
test('stale event-delivery Cancel cannot cancel the current standalone-album delivery',async t=>{
  const f=batchFixture(t,['photo','photo']);delete f.album.kind;f.album.guests={2:{name:'Guest',status:'yes'}};f.save('events',f.album.id,f.album);
  const other=photoCollection('Fictional other album',1);other.media=f.album.media.map((file,index)=>({...file,id:'f'.repeat(11)+index,fileId:'fictional-other-'+index}));f.save('events',other.id,other);
  const pref=f.read('preferences',2);pref.mediaAccess[other.id]=other.viewToken;f.save('preferences',2,pref);
  await f.cb(2,'media-get','all');await processUpdate(f.env,{update_id:8000,callback_query:{id:'fictional-other',from:{id:2},data:`media-get:${other.id}:all`}});
  await f.pressCancel(2,1);await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,2);assert.equal(f.read('preferences',2).mediaDelivery[other.id].received.length,2);
  assert.deepEqual(f.requests.flatMap(r=>r.params.media?.map(x=>x.media) || []),['fictional-0','fictional-1','fictional-other-0','fictional-other-1']);
});

test('Send status uses the actual request receipt, not historical received media',async t=>{
  const f=batchFixture(t,['photo']),file=f.album.media[0],path=`https://example.test/api/events/${f.album.id}/media/${file.id}`;
  const send=()=>mediaApi(new Request(path+'/send',{method:'POST'}),f.env,{id:2});
  const status=reference=>mediaApi(new Request(path+'/delivery-status?request='+reference),f.env,{id:2}).then(r=>r.json());
  const first=await (await send()).json();assert.equal(first.status,'queued');assert.match(first.request,/^[a-f0-9]{16}$/);assert.equal((await status(first.request)).status,'queued');
  await drainOutbox(f.env);assert.equal((await status(first.request)).status,'sent');
  const next=await (await send()).json();assert.notEqual(next.request,first.request);assert.equal((await status(next.request)).status,'queued');assert.ok(f.state(2).received.includes(file.id));
  await drainOutbox(f.env);assert.equal((await status(next.request)).status,'sent');
});
for(const [mode,expected] of [['400','failed'],['timeout','unconfirmed'],['partial','partial']])test(`${mode} delivery never becomes a false sent notice`,async t=>{
  const f=batchFixture(t,['photo','photo']);f.mode=mode;await f.cb(2,'media-get','all');
  const file=f.album.media[0],reference=f.state(2).pending[file.id];await drainOutbox(f.env);
  const response=await mediaApi(new Request(`https://example.test/api/events/${f.album.id}/media/${file.id}/delivery-status?request=${reference}`),f.env,{id:2});
  assert.equal((await response.json()).status,expected);
});
test('delivery status is isolated by user, current file access and request reference',async t=>{
  const f=batchFixture(t,['photo']),file=f.album.media[0];
  const sent=await (await mediaApi(new Request(`https://example.test/api/events/${f.album.id}/media/${file.id}/send`,{method:'POST'}),f.env,{id:2})).json();await drainOutbox(f.env);
  const path=`https://example.test/api/events/${f.album.id}/media/${file.id}/delivery-status?request=${sent.request}`;
  assert.equal((await (await mediaApi(new Request(path),f.env,{id:1})).json()).status,'unconfirmed');
  assert.equal((await mediaApi(new Request(path),f.env,{id:4})).status,403);
  f.save('preferences',2,{mediaAccess:{}});assert.equal((await mediaApi(new Request(path),f.env,{id:2})).status,403);
});

test('rejected delivery-status requests do not log private event/file IDs or request references',async t=>{
  const f=fixture(t),logs=[];t.mock.method(console,'log',line=>logs.push(String(line)));
  const response=await worker.fetch(new Request(`https://example.test/api/events/${f.album.id}/media/111111111111/delivery-status?request=aaaaaaaaaaaaaaaa`),f.env,{waitUntil(){}});
  assert.equal(response.status,401);assert.equal(logs.length,1);
  assert.ok(!logs[0].includes(f.album.id));assert.ok(!logs[0].includes('111111111111'));assert.ok(!logs[0].includes('aaaaaaaaaaaaaaaa'));assert.match(logs[0],/delivery-status/);
});

for(const size of [0,1,10,11,200])test('reply delivery keyboard counts confirmed receipts for '+size+' files',async t=>{
  const f=batchFixture(t,Array(size).fill('photo'));
  await f.cb(2,'media-get','all');
  const first=f.ui.find(r=>r.params.reply_markup?.keyboard);
  assert.ok(first);assert.equal(first.method,'sendMessage');assert.equal(first.params.reply_markup.inline_keyboard,undefined);
  assert.match(first.params.reply_markup.keyboard[0][0].text,new RegExp('Cancel · 0/'+size+'$'));
  assert.equal(first.params.reply_markup.keyboard.length,1);assert.equal(first.params.reply_markup.keyboard[0].length,1);assert.equal(first.params.text,size?'…':'Nothing new to send.');assert.equal(first.params.disable_notification,true);
  assert.equal(f.requests.length,0);
  const job=()=>Object.values(f.state(2).jobs)[0];
  assert.equal(job().notice.keyboardConfirmed,true);
  await drainOutbox(f.env);
  assert.equal(progressStats(job()).sent,size);assert.equal(progressStats(job()).remaining,0);
  assert.equal(f.requests.length,Math.ceil(size/10));
  assert.equal(f.read('preferences',2).mediaKeyboard,undefined);
  assert.ok(f.ui.some(r=>r.params.reply_markup?.keyboard && !JSON.stringify(r.params.reply_markup).includes('Cancel')));
  assert.equal(f.ui.some(r=>['editMessageText','editMessageReplyMarkup'].includes(r.method)),false);
});

test('reply keyboard bypasses a busy media lease; Cancel stops queued media without changing other users',async t=>{
  const f=batchFixture(t,Array(11).fill('photo'));
  f.db.prepare('INSERT INTO delivery_lease VALUES (1,?,unixepoch()+60)').run('fictional-busy');
  await f.cb(2,'media-get','all');
  assert.ok(f.ui.some(r=>r.params.reply_markup?.keyboard));assert.equal(f.requests.length,0);
  await f.cb(3,'media-get','all');
  await f.pressCancel(2);
  assert.ok(f.ui.some(r=>r.params.chat_id===2 && /Stopping/.test(r.params.text || '')));
  assert.equal(f.requests.length,0);
  f.db.exec('DELETE FROM delivery_lease');await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,0);assert.equal(f.state(3).received.length,11);
  assert.ok(f.requests.every(r=>r.params.chat_id===3));
});

test('initial control 429 gates media until the keyboard is acknowledged',async t=>{
  const f=batchFixture(t,['photo']);const real=globalThis.fetch;let rejected=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const params=JSON.parse(options.body);
    if(!rejected && params.reply_markup?.keyboard){rejected=true;return Response.json({ok:false,error_code:429,parameters:{retry_after:30}});}
    return real(url,options);
  });
  await f.cb(2,'media-get','all');
  assert.equal(Object.values(f.state(2).jobs)[0].notice.keyboardConfirmed,undefined);
  // Avoid a real wait: test the media drain with the control deliberately still delayed.
  await drainOutbox(f.env);assert.equal(f.requests.length,0);
  f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,1);
});

for(const mode of ['400','partial','timeout','429'])test('reply progress does not count '+mode+' as confirmed sent',async t=>{
  const f=batchFixture(t,['photo','photo']);await f.cb(2,'media-get','all');f.mode=mode;
  await drainOutbox(f.env);const job=Object.values(f.state(2).jobs)[0],stats=progressStats(job);
  assert.equal(stats.sent,0);assert.equal(stats.remaining,2);assert.match(progressKeyboard(job).keyboard[0][0].text,/Cancel · 0\/2/);
  if(mode==='400')assert.equal(stats.failed,2);
  if(mode==='partial')assert.equal(stats.partial,2);
  if(mode==='timeout')assert.equal(stats.unknown,2);
  if(mode==='429')assert.equal(stats.queued,2);
});

test('an ambiguous progress control never replays confirmed media receipts',async t=>{
  const f=batchFixture(t,['photo']);await f.cb(2,'media-get','all');
  const real=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>url.endsWith('/sendMessage') && JSON.parse(options.body).reply_markup?.keyboard?Response.json({ok:false,error_code:503}):real(url,options));
  const j=Object.values(f.state(2).jobs)[0];const button=`📊 0/1 sent · 1 left · #${j.number}`;
  await processUpdate(f.env,{update_id:900003,message:{chat:{id:2,type:'private'},from:{id:2},text:button}});
  await drainOutbox(f.env);f.db.exec('UPDATE outbox SET due=0');await drainOutbox(f.env);
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,1);
});

test('revoked access clears queued media even when the initial control was not acknowledged',async t=>{
  const f=batchFixture(t,['photo']);const real=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url,options)=>JSON.parse(options.body).reply_markup?.keyboard?Response.json({ok:false,error_code:429,parameters:{retry_after:30}}):real(url,options));
  await f.cb(2,'media-get','all');const pref=f.read('preferences',2);pref.mediaAccess={};f.save('preferences',2,pref);
  await drainOutbox(f.env);assert.equal(f.requests.length,0);assert.deepEqual(f.state(2).pending,{});
});

test('identical count labels from different jobs require explicit scoped confirmation',async t=>{
 const f=batchFixture(t,['photo','photo']);await f.cb(2,'media-get','all');const old=progressKeyboard(Object.values(f.state(2).jobs)[0]).keyboard[0][0].text;
 await f.pressCancel(2);await drainOutbox(f.env);await f.cb(2,'media-get','new');
 await processUpdate(f.env,{update_id:991000,message:{chat:{id:2,type:'private'},from:{id:2},text:old}});
 assert.equal(Object.values(f.state(2).jobs).at(-1).cancelRequested,undefined);
 const question=f.ui.findLast(r=>r.params.text?.startsWith('Which delivery'));
 assert.ok(question);
 const current=Object.values(f.state(2).jobs).at(-1);
 assert.ok(current.notice.keyboardMessageId);
 assert.equal(f.ui.some(r=>r.method==='deleteMessage' && r.params.message_id===current.notice.keyboardMessageId),false);
 const callback=question.params.reply_markup.inline_keyboard[0][0].callback_data;
 await processUpdate(f.env,{update_id:991001,callback_query:{id:'fictional-confirm',from:{id:2},data:callback}});await drainOutbox(f.env);
 assert.equal(f.requests.length,0);assert.equal(f.state(2).received.length,0);
 assert.ok(f.ui.every(r=>!/#\d+|Delivery #|Known in flight/.test(r.params.text || '')));
});

test('superseded controls are removed only after replacement; latest keyboard and media are retained',async t=>{
 const f=batchFixture(t,Array(11).fill('photo'));await f.cb(2,'media-get','all');await drainOutbox(f.env);
 const controls=f.ui.filter(r=>r.method==='sendMessage' && r.params.reply_markup?.keyboard),deleted=f.ui.filter(r=>r.method==='deleteMessage').map(r=>r.params.message_id);
 assert.ok(controls.length>=2);assert.ok(deleted.length>0);
 assert.ok(deleted.every(id=>id>=10000));assert.equal(deleted.includes(f.uiId),false);
 assert.equal(f.state(2).received.length,11);
});

test('a confirmation arriving after completion cannot cancel a later job',async t=>{
 const f=batchFixture(t,['photo']);await f.cb(2,'media-get','all');const old=Object.values(f.state(2).jobs)[0].id;await drainOutbox(f.env);
 await f.cb(2,'media-get','all');await f.cb(2,'media-stop',old);
 assert.equal(Object.values(f.state(2).jobs).at(-1).cancelRequested,undefined);await drainOutbox(f.env);assert.equal(f.requests.length,2);
});
