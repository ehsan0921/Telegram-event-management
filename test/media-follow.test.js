import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {photoCollection} from '../src/permissions.js';
import {processUpdate,drainOutbox} from '../src/worker.js';

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
  assert.deepEqual(viewer.reply_markup.inline_keyboard[0].map(b=>b.text),['Get all media (1)','Get new media (1)']);
  assert.equal(viewer.reply_markup.inline_keyboard[1][0].web_app.url,`https://example.test/app?gallery=${f.album.id}`);
  assert.ok(!JSON.stringify(viewer).includes(f.album.uploadToken));assert.ok(!JSON.stringify(viewer).includes('media-add:'));
  assert.ok(JSON.stringify(contributor).includes('media-add:'));assert.ok(JSON.stringify(contributor).includes(f.album.uploadToken));
  assert.ok(JSON.stringify(viewer).includes('Follow: On'));assert.ok(JSON.stringify(contributor).includes('Follow: On'));
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

test('follow sends new uploads with notification, stops before delivery when switched off, and preserves hidden attribution',async t=>{
  const f=fixture(t);await f.cb(2,'media-follow','on');await drainOutbox(f.env);await f.upload();await drainOutbox(f.env);
  let photos=f.sent.filter(row=>row.method==='sendPhoto');assert.equal(photos.length,1);assert.equal(photos[0].chat_id,2);assert.match(photos[0].caption,/New media · Fictional memories/);assert.notEqual(photos[0].disable_notification,true);
  await f.upload();await f.cb(2,'media-follow','off');await drainOutbox(f.env);assert.equal(f.sent.filter(row=>row.method==='sendPhoto').length,1);
  await f.cb(2,'media-follow','on');const album=f.read('events',f.album.id);album.showUploaders=false;f.save('events',album.id,album);
  await f.upload();await drainOutbox(f.env);photos=f.sent.filter(row=>row.method==='sendPhoto');assert.equal(photos.length,2);assert.doesNotMatch(photos[1].caption,/Shared by/);
});
