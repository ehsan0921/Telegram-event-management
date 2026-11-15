import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {photoCollection} from '../src/permissions.js';
import {processUpdate,drainOutbox} from '../src/worker.js';
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
  assert.deepEqual(viewer.reply_markup.inline_keyboard[1].map(b=>b.text),['Get all (1)','Get new (1)']);
  assert.equal(viewer.reply_markup.inline_keyboard[0][0].web_app.url,`https://example.test/app?gallery=${f.album.id}`);
  assert.ok(!JSON.stringify(viewer).includes(f.album.uploadToken));assert.ok(JSON.stringify(viewer).includes('media-add:'));
  assert.ok(JSON.stringify(contributor).includes('media-add:'));assert.ok(!JSON.stringify(contributor).includes(f.album.uploadToken));
  assert.ok(JSON.stringify(viewer).includes('Follow On'));assert.ok(JSON.stringify(contributor).includes('Follow On'));
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
  assert.deepEqual(await first.json(),{queued:true,alreadyQueued:false});
  const again=await mediaApi(new Request(path,{method:'POST'}),f.env,{id:2});
  assert.deepEqual(await again.json(),{queued:true,alreadyQueued:true});
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
  const f=fixture(t);f.mode='success';f.requests=[];
  f.album.media=types.map((type,index)=>({id:(index+1).toString(16).padStart(12,'0'),type,fileId:'fictional-'+index,name:'Fictional uploader',by:1}));
  f.save('events',f.album.id,f.album);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=new URL(url).pathname.split('/').at(-1),params=JSON.parse(options.body);
    assert.ok(!Object.keys(params).some(key=>key.startsWith('__')));
    if(!['sendMediaGroup','sendPhoto','sendVideo','sendDocument','sendVoice'].includes(method))return Response.json({ok:true,result:{message_id:9000}});
    f.requests.push({method,params});
    if(f.mode==='timeout')throw Error('Fictional timeout');
    if(f.mode==='429')return Response.json({ok:false,error_code:429,parameters:{retry_after:7}});
    if(f.mode==='400')return Response.json({ok:false,error_code:400});
    const messages=(params.media || [params]).map((_,index)=>({message_id:f.requests.length*100+index+1,chat:{id:params.chat_id}}));
    return Response.json({ok:true,result:f.mode==='partial'?messages.slice(1):method==='sendMediaGroup'?messages:messages[0]});
  });
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
  assert.equal(response.status,409);assert.match((await response.json()).error,/unconfirmed/);
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
  await f.cb(2,'media-cancel',String(generation));release();await sending;
  assert.equal(f.requests.length,1);assert.equal(f.state(2).received.length,10);assert.equal(Object.keys(f.state(2).pending).length,0);
  await f.cb(2,'media-get','new');await drainOutbox(f.env);
  const files=f.requests.flatMap(r=>r.params.media?r.params.media.map(x=>x.media):[r.params.photo]);assert.equal(files.length,21);assert.equal(new Set(files).size,21);assert.equal(f.state(2).received.length,21);
});
test('Cancel is scoped to one recipient and stale Cancel buttons cannot stop a later delivery',async t=>{
  const f=batchFixture(t,['photo','photo']);await f.cb(2,'media-get','all');await f.cb(3,'media-get','all');
  const old=f.state(2).deliveryGeneration;await f.cb(2,'media-cancel',String(old));await drainOutbox(f.env);
  assert.equal(f.state(2).received.length,0);assert.equal(f.state(3).received.length,2);
  await f.cb(2,'media-get','new');assert.notEqual(f.state(2).deliveryGeneration,old);
  await f.cb(2,'media-cancel',String(old));await drainOutbox(f.env);assert.equal(f.state(2).received.length,2);
});
