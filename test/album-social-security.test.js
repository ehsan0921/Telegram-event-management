import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import {photoCollection} from '../src/permissions.js';
import {miniApi} from '../src/mini-api.js';
import {processUpdate,drainOutbox} from '../src/worker.js';

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const name of ['0001_initial.sql','0002_delivery_lease.sql','0003_mini_app.sql'])db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const save=(kind,id,data)=>db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,String(id),JSON.stringify(data));
 const read=(kind,id)=>{const row=db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,String(id));return row && JSON.parse(row.data);};
 const source=photoCollection('Fictional source album',1),dest=photoCollection('Fictional personal album',2);
 source.media=[{id:'111111111111',type:'photo',fileId:'fictional-original-photo',thumbnail:'fictional-thumbnail',filename:'photo',name:'Fictional uploader',caption:'Fictional private caption',by:1,at:'2026-01-01T00:00:00.000Z'},{id:'222222222222',type:'photo',fileId:'fictional-second-photo',filename:'photo',name:'Fictional uploader',by:1}];
 save('events',source.id,source);save('events',dest.id,dest);
 for(let id=1;id<=7;id++)save('users',id,{id,firstName:'Fictional '+id});
 save('preferences',2,{mediaAccess:{[source.id]:source.viewToken}});
 save('preferences',3,{mediaAccess:{[source.id]:source.viewToken,[dest.id]:dest.viewToken}});
 save('preferences',4,{mediaAccess:{[dest.id]:dest.viewToken}});
 save('preferences',5,{mediaAccess:{[source.id]:source.uploadToken,[dest.id]:dest.viewToken}});
 const env={APP_ENV:'production',BOT_USERNAME:'FictionalBot',APP_URL:'https://fictional.test/app',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args) || null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return db.prepare(sql).run(...this.args);}};},async batch(statements){db.exec('BEGIN');try{for(const q of statements)db.prepare(q.sql).run(...q.args);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}}};
 const calls=[];let message=10000,update=900000;
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  if(String(url).includes('/file/bot')){calls.push({method:'file-bytes'});return new Response('fictional-media-bytes',{headers:{'Content-Type':'image/jpeg'}});}
  const method=String(url).split('/').at(-1),params=JSON.parse(options.body);calls.push({method,params});
  if(method==='getFile')return Response.json({ok:true,result:{file_path:'fictional/media.jpg'}});
  return Response.json({ok:true,result:method==='sendMediaGroup'?params.media.map(()=>({message_id:++message,chat:{id:params.chat_id}})):{message_id:++message,chat:{id:params.chat_id}}});
 });
 const auth=id=>{const query=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Fictional '+id})});const text=[...query].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n'),key=createHmac('sha256','WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();query.set('hash',createHmac('sha256',key).update(text).digest('hex'));return 'tma '+query;};
 const api=(id,path,input)=>miniApi(new Request('https://fictional.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{Authorization:auth(id),'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})}),env);
 const value=async(id,path,input)=>{const response=await api(id,path,input);assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('Cache-Control'),'no-store');return response.json();};
 const policy=async allowed=>{const e=read('events',source.id);return value(1,'albums/'+source.id+'/reshare',{allowed,confirm:true,version:e.mediaReshareVersion || 0});};
 const add=(requestId=randomUUID(),mediaIds=[source.media[0].id])=>value(2,'albums/'+dest.id+'/references',{sourceEvent:source.id,mediaIds,requestId});
 const cb=(id,eid,action,arg)=>processUpdate(env,{update_id:update++,callback_query:{id:'fictional-'+update,from:{id,first_name:'Fictional '+id},data:action+':'+eid+(arg?':'+arg:'')}});
 const msg=(id,text,extra={})=>processUpdate(env,{update_id:update++,message:{chat:{id,type:'private'},from:{id,first_name:'Fictional '+id},text,...extra}});
 return {db,save,read,source,dest,env,calls,api,value,policy,add,cb,msg,auth};
}

const saveCopy=(f,requestId=randomUUID(),mediaId='111111111111')=>f.value(2,'albums/'+f.dest.id+'/copies',{sourceEvent:f.source.id,mediaId,requestId});

test('Album App secure launch preserves gallery route and signed auth; missing or forged launch login remains rejected',async t=>{
 const f=fixture(t);await f.cb(2,f.source.id,'v');const menu=JSON.parse(f.db.prepare("SELECT params FROM outbox WHERE method='sendMessage' ORDER BY rowid DESC LIMIT 1").get().params);assert.equal(menu.reply_markup.inline_keyboard[0][0].web_app.url,'https://fictional.test/app?gallery='+f.source.id);assert.equal(menu.reply_markup.keyboard,undefined);
 await f.msg(2,'📂 Open album app');const launch=JSON.parse(f.db.prepare("SELECT params FROM outbox WHERE method='sendMessage' ORDER BY rowid DESC LIMIT 1").get().params);assert.equal(launch.reply_markup.inline_keyboard[0][0].web_app.url,'https://fictional.test/app?gallery='+f.source.id);
 for(const Authorization of ['tma ','tma user=%7B%22id%22%3A2%7D']){const response=await miniApi(new Request('https://fictional.test/api/events/'+f.source.id+'/gallery',{headers:{Authorization}}),f.env);assert.equal(response.status,401);}assert.equal((await f.api(2,'events/'+f.source.id+'/gallery')).status,200);assert.equal(f.calls.filter(call=>['sendPhoto','sendMediaGroup'].includes(call.method)).length,0);
});

test('saved state is loaded only from owned albums and duplicate identity survives a different source album',async t=>{
 const f=fixture(t);assert.equal((await f.value(2,'events/'+f.source.id+'/gallery')).media[0].isSaved,false);const saved=await saveCopy(f);assert.equal((await f.value(2,'events/'+f.source.id+'/gallery')).media[0].isSaved,true);assert.equal((await f.value(3,'events/'+f.source.id+'/gallery')).media[0].isSaved,false);
 const albums=await f.value(2,'albums/owned?sourceEvent='+f.source.id+'&mediaId=111111111111');assert.deepEqual(albums.albums.map(a=>[a.id,a.containsPhoto]),[[f.dest.id,true]]);assert.equal((await f.api(4,'albums/owned?sourceEvent='+f.source.id+'&mediaId=111111111111')).status,403);
 const other=photoCollection('Fictional alternate source',2);other.media=[{...f.source.media[0],id:'999999999999'}];f.save('events',other.id,other);const again=await f.value(2,'albums/'+f.dest.id+'/copies',{sourceEvent:other.id,mediaId:'999999999999',requestId:randomUUID()});assert.equal(again.alreadyInAlbum,true);assert.equal(again.added,0);assert.deepEqual(again.ids,saved.ids);assert.equal(f.read('events',f.dest.id).media.length,1);
});

test('concurrent saves use one stored photo and own original media is already in its album',async t=>{
 const f=fixture(t),results=await Promise.all([saveCopy(f),saveCopy(f)]);assert.equal(results.filter(r=>r.added===1).length,1);assert.equal(results.filter(r=>r.alreadyInAlbum).length,1);assert.equal(f.read('events',f.dest.id).media.length,1);
 const own=await f.value(1,'albums/'+f.source.id+'/copies',{sourceEvent:f.source.id,mediaId:'111111111111',requestId:randomUUID()});assert.equal(own.alreadyInAlbum,true);assert.equal(own.added,0);assert.equal(f.read('events',f.source.id).media.length,2);
});

test('Share explains independent photo copies without changing link or upload settings',async t=>{
 const f=fixture(t),before=structuredClone(f.read('events',f.source.id));await f.cb(2,f.source.id,'album-share');const messages=f.db.prepare("SELECT params FROM outbox WHERE method='sendMessage'").all().map(row=>JSON.parse(row.params));assert.ok(messages.some(message=>message.text?.includes('Revoking this link does not recall saved copies.')));assert.deepEqual(f.read('events',f.source.id),before);
});

test('a current source viewer saves exactly one independent photo without a separate linking grant',async t=>{
 const f=fixture(t),source=structuredClone(f.read('events',f.source.id));assert.notEqual(source.allowMediaReshare,true);
 const result=await saveCopy(f),raw=f.read('events',f.dest.id).media[0];assert.equal(result.added,1);assert.equal(raw.fileId,source.media[0].fileId);assert.equal(raw.reference,undefined);assert.deepEqual(raw.savedFrom,{event:source.id,media:'111111111111'});assert.deepEqual(f.read('events',source.id),source);assert.equal(f.calls.length,0);
 const gallery=await f.value(4,'events/'+f.dest.id+'/gallery');assert.equal(gallery.media.length,1);assert.equal(gallery.media[0].savedCopy,true);assert.equal(gallery.media[0].fileId,undefined);assert.equal(gallery.media[0].savedFrom,undefined);assert.match(gallery.copySharingNote,/does not recall/);
 const path='events/'+f.dest.id+'/media/'+raw.id;assert.equal(await(await f.api(4,path)).text(),'fictional-media-bytes');assert.deepEqual(await f.value(4,path+'/likes'),{count:0,liked:false});assert.equal((await f.api(4,path+'/send',{})).status,200);
});

test('saved copies remain after source link rotation or individual source revocation; new source access stays denied',async t=>{
 const f=fixture(t),saved=(await saveCopy(f)).ids[0];await f.value(1,'collections/'+f.source.id+'/access',{action:'regenerate',confirm:true,version:0});assert.equal((await f.api(2,'events/'+f.source.id+'/gallery')).status,403);assert.equal((await f.value(4,'events/'+f.dest.id+'/gallery')).media[0].id,saved);
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/copies',{sourceEvent:f.source.id,mediaId:'222222222222',requestId:randomUUID()})).status,403);
 await f.value(1,'albums/'+f.source.id+'/members',{userId:4,blocked:true,confirm:true,version:0});assert.equal((await f.api(4,'events/'+f.dest.id+'/media/'+saved+'/likes')).status,200);assert.equal((await f.api(4,'events/'+f.source.id+'/media/111111111111/likes')).status,403);
});

test('destination ownership and current source access are required; a client cannot supply inaccessible bytes or a whole album',async t=>{
 const f=fixture(t),body={sourceEvent:f.source.id,mediaId:'111111111111',requestId:randomUUID()};assert.equal((await f.api(3,'albums/'+f.dest.id+'/copies',body)).status,403);assert.equal((await f.api(2,'albums/'+f.dest.id+'/copies',{...body,mediaIds:['111111111111','222222222222']})).status,400);
 await f.value(1,'albums/'+f.source.id+'/members',{userId:2,blocked:true,confirm:true,version:0});assert.equal((await f.api(2,'albums/'+f.dest.id+'/copies',{...body,fileId:'client-injected'})).status,403);assert.equal(f.read('events',f.dest.id).media.length,0);assert.equal(f.calls.length,0);
});

test('destination access alone controls a saved copy after saving, including preview, likes, send and status',async t=>{
 const f=fixture(t),saved=(await saveCopy(f)).ids[0],path='events/'+f.dest.id+'/media/'+saved;await f.value(2,'albums/'+f.dest.id+'/members',{userId:4,blocked:true,confirm:true,version:0});
 for(const suffix of ['', '/thumbnail','/likes','/delivery-status?request='+'a'.repeat(16)])assert.equal((await f.api(4,path+suffix)).status,403);assert.equal((await f.api(4,path+'/send',{})).status,403);assert.equal((await f.api(3,path+'/likes')).status,200);
 await f.value(2,'collections/'+f.dest.id+'/access',{action:'regenerate',confirm:true,version:0});assert.equal((await f.api(3,path+'/likes')).status,403);assert.equal((await f.api(2,path+'/likes')).status,200);
});

test('copy requests deduplicate, preserve tombstones after removal, and never delete the source',async t=>{
 const f=fixture(t),request=randomUUID(),first=await saveCopy(f,request),source=structuredClone(f.read('events',f.source.id));assert.deepEqual((await saveCopy(f,request)).ids,first.ids);assert.equal((await saveCopy(f)).added,0);assert.equal(f.read('events',f.dest.id).media.length,1);
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/copies',{sourceEvent:f.source.id,mediaId:'222222222222',requestId:request})).status,409);
 await f.value(2,'albums/'+f.dest.id+'/remove',{mediaId:first.ids[0],confirm:true,version:f.read('events',f.dest.id).mediaEditVersion});assert.deepEqual((await saveCopy(f,request)).ids,[]);assert.equal(f.read('events',f.dest.id).media.length,0);assert.deepEqual(f.read('events',f.source.id),source);
});

for(const first of ['copy','revoke'])test('source revoke and save serialize safely when '+first+' commits first',async t=>{
 const f=fixture(t),original=f.env.DB.batch;let enter,release,held=false;const entered=new Promise(resolve=>enter=resolve),barrier=new Promise(resolve=>release=resolve);
 f.env.DB.batch=async statements=>{if(!held && statements.some(q=>q.args.some(v=>typeof v==='string' && v.includes(first==='copy'?'"savedFrom"':'"mediaRevokedUsers"')))){held=true;enter();await barrier;}return original(statements);};
 const copy=()=>f.api(2,'albums/'+f.dest.id+'/copies',{sourceEvent:f.source.id,mediaId:'111111111111',requestId:randomUUID()}),revoke=()=>f.api(1,'albums/'+f.source.id+'/members',{userId:2,blocked:true,confirm:true,version:0});
 const a=first==='copy'?copy():revoke();await entered;const b=first==='copy'?revoke():copy();release();const result=await Promise.all([a,b]);assert.equal(result[first==='copy'?0:1].status,first==='copy'?200:403);assert.equal(result[first==='copy'?1:0].status,200);assert.equal((await f.value(4,'events/'+f.dest.id+'/gallery')).media.length,first==='copy'?1:0);
});

test('saving an authorized legacy reference makes a new copy without rewriting or widening older references',async t=>{
 const f=fixture(t);await f.policy(true);const old=(await f.add()).ids[0],third=photoCollection('Fictional third album',3);f.save('events',third.id,third);f.save('preferences',4,{mediaAccess:{[f.dest.id]:f.dest.viewToken,[third.id]:third.viewToken}});
 const copy=await f.value(3,'albums/'+third.id+'/copies',{sourceEvent:f.dest.id,mediaId:old,requestId:randomUUID()});await f.policy(false);assert.equal((await f.value(4,'events/'+third.id+'/gallery')).media[0].id,copy.ids[0]);assert.deepEqual((await f.value(3,'events/'+f.dest.id+'/gallery')).media,[]);assert.ok(f.read('events',f.dest.id).media[0].reference);
});

test('copies preserve hidden attribution and existing photo-like privacy and pause in safe mode',async t=>{
 const f=fixture(t),source=f.read('events',f.source.id);source.showUploaders=false;f.save('events',source.id,source);const copy=await saveCopy(f);assert.equal(f.read('events',f.dest.id).media[0].name,null);assert.equal((await f.value(4,'events/'+f.dest.id+'/gallery')).media[0].name,null);
 await f.value(4,'events/'+f.dest.id+'/media/'+copy.ids[0]+'/likes',{liked:true});assert.deepEqual(await f.value(2,'events/'+f.dest.id+'/media/'+copy.ids[0]+'/likes'),{count:1,liked:false});f.env.ALBUM_SOCIAL_ENABLED='false';assert.equal((await f.api(2,'albums/'+f.dest.id+'/copies',{sourceEvent:source.id,mediaId:'222222222222',requestId:randomUUID()})).status,503);assert.equal(f.read('events',f.dest.id).media.length,1);
});

for(const revoke of ['source','destination'])test('queued saved-photo delivery follows '+revoke+' revocation semantics without resending',async t=>{
 const f=fixture(t),saved=(await saveCopy(f)).ids[0];await f.cb(4,f.dest.id,'media-get','all');await f.value(revoke==='source'?1:2,'albums/'+(revoke==='source'?f.source.id:f.dest.id)+'/members',{userId:revoke==='source'?2:4,blocked:true,confirm:true,version:0});await drainOutbox(f.env);
 const calls=f.calls.filter(call=>call.method==='sendPhoto' && call.params.chat_id===4);assert.equal(calls.length,revoke==='source'?1:0);assert.equal(f.read('preferences',4).mediaDelivery[f.dest.id].received.includes(saved),revoke==='source');await drainOutbox(f.env);assert.equal(f.calls.filter(call=>call.method==='sendPhoto' && call.params.chat_id===4).length,calls.length);
});

test('failed copy commit leaves no partial photo, request tombstone or notification; retry commits once',async t=>{
 const f=fixture(t),original=f.env.DB.batch,requestId=randomUUID();let fail=true;f.env.DB.batch=async statements=>{if(fail && statements.some(q=>q.sql.includes("VALUES ('media_import'"))){fail=false;throw Error('Fictional storage interruption');}return original(statements);};
 const body={sourceEvent:f.source.id,mediaId:'111111111111',requestId};assert.notEqual((await f.api(2,'albums/'+f.dest.id+'/copies',body)).status,200);assert.equal(f.read('events',f.dest.id).media.length,0);assert.equal(f.read('media_import','2:'+requestId),undefined);assert.equal(f.calls.length,0);const saved=await saveCopy(f,requestId);assert.equal(saved.added,1);assert.deepEqual((await saveCopy(f,requestId)).ids,saved.ids);assert.equal(f.read('events',f.dest.id).media.length,1);
});

test('personal album creation is private, owned and idempotent; legacy collection creation stays compatible',async t=>{
 const f=fixture(t),requestId=randomUUID(),first=await f.value(2,'collections',{title:'Fictional private memories',personal:true,requestId});
 assert.equal(first.event.isOwner,true);assert.equal(first.event.sharingDisabled,true);assert.equal(first.event.photoLinks,null);
 assert.equal((await f.value(2,'collections',{title:'Fictional private memories',personal:true,requestId})).event.id,first.event.id);
 assert.equal((await f.api(3,'events/'+first.event.id+'/gallery')).status,403);
 const old=await f.value(2,'collections',{title:'Fictional shared memories',requestId:randomUUID()});assert.ok(old.event.photoLinks.viewer);
 const owned=await f.value(2,'albums/owned');assert.ok(owned.albums.some(e=>e.id===first.event.id));assert.ok(!owned.albums.some(e=>e.id===f.source.id));assert.equal(f.calls.length,0);
});

test('view permission alone and co-host access do not authorize linking; owner opt-in is versioned and confirmed',async t=>{
 const f=fixture(t),before=structuredClone(f.read('events',f.dest.id));const source=f.read('events',f.source.id);source.cohost={id:6,name:'Fictional cohost'};f.save('events',source.id,source);assert.equal((await f.api(6,'events/'+source.id+'/gallery')).status,200);assert.ok((await f.value(1,'albums/'+source.id+'/manage')).members.some(person=>person.id===6));
 const request={sourceEvent:f.source.id,mediaIds:['111111111111'],requestId:randomUUID()};
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/references',request)).status,403);assert.deepEqual(f.read('events',f.dest.id),before);
 for(const uid of [2,3,4,6])assert.equal((await f.api(uid,'albums/'+f.source.id+'/reshare',{allowed:true,confirm:true,version:0})).status,403);
 assert.equal((await f.api(1,'albums/'+f.source.id+'/reshare',{allowed:true,confirm:false,version:0})).status,400);
 await f.policy(true);assert.equal((await f.api(1,'albums/'+f.source.id+'/reshare',{allowed:false,confirm:true,version:0})).status,409);
 const added=await f.add();assert.equal(added.added,1);const raw=f.read('events',f.dest.id).media[0];assert.equal(raw.fileId,undefined);assert.equal(raw.name,undefined);assert.equal(raw.caption,undefined);assert.equal(raw.reference.event,f.source.id);
});

test('linking is idempotent; removal and an old add retry cannot restore a removed reference or delete its source',async t=>{
 const f=fixture(t);await f.policy(true);const requestId=randomUUID(),added=await f.add(requestId),again=await f.add(requestId);assert.equal(again.alreadyHandled,true);assert.deepEqual(added.ids,again.ids);assert.equal(f.read('events',f.dest.id).media.length,1);
 const before=structuredClone(f.read('events',f.source.id)),target=f.read('events',f.dest.id);
 assert.equal((await f.api(3,'albums/'+f.dest.id+'/remove',{mediaId:added.ids[0],confirm:true,version:target.mediaEditVersion})).status,403);
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/remove',{mediaId:added.ids[0],confirm:false,version:target.mediaEditVersion})).status,400);
 await f.value(2,'albums/'+f.dest.id+'/remove',{mediaId:added.ids[0],confirm:true,version:target.mediaEditVersion});
 assert.deepEqual(f.read('events',f.source.id),before);assert.deepEqual((await f.add(requestId)).ids,[]);assert.equal(f.read('events',f.dest.id).media.length,0);
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/references',{sourceEvent:f.source.id,mediaIds:['222222222222'],requestId})).status,409);
});

test('likes use verified identity, are idempotent under concurrency, and expose only counts and own state',async t=>{
 const f=fixture(t),path='events/'+f.source.id+'/media/111111111111/likes';
 const responses=await Promise.all([f.api(2,path,{liked:true,userId:7}),f.api(3,path,{liked:true})]);assert.ok(responses.every(r=>r.status===200));
 assert.equal((await f.value(2,path,{liked:true})).count,2);assert.equal((await f.value(3,path,{liked:false})).count,1);
 const listed=await f.value(3,path);assert.deepEqual(listed,{count:1,liked:false});
 const denied=await f.api(4,path);assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('Fictional 2'));
 assert.equal((await f.api(2,path+'?offset=-1')).status,400);assert.equal((await f.api(2,path,{liked:'true'})).status,400);
 const unauth=await miniApi(new Request('https://fictional.test/api/'+path),f.env);assert.equal(unauth.status,401);
});

test('linked-photo likes share the original identity, while missing source access blocks metadata, bytes, status and send',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],path='events/'+f.dest.id+'/media/'+linked;
 await f.value(3,path+'/likes',{liked:true});assert.equal((await f.value(2,'events/'+f.source.id+'/media/111111111111/likes')).count,1);
 const gallery=await f.value(3,'events/'+f.dest.id+'/gallery');assert.equal(gallery.media.length,1);assert.equal(gallery.media[0].likeCount,1);assert.equal(gallery.media[0].fileId,undefined);assert.equal(gallery.media[0].reference,true);
 assert.deepEqual((await f.value(4,'events/'+f.dest.id+'/gallery')).media,[]);
 const start=f.calls.length;
 for(const suffix of ['', '?download=1','/thumbnail','/likes','/delivery-status?request='+'a'.repeat(16)])assert.equal((await f.api(4,path+suffix)).status,403);
 assert.equal((await f.api(4,path+'/send',{})).status,403);assert.equal(f.calls.length,start);
 const bytes=await f.api(3,path+'?download=1');assert.equal(bytes.status,200);assert.equal(bytes.headers.get('Cache-Control'),'no-store');assert.equal(await bytes.text(),'fictional-media-bytes');
});

test('count-only likes preserve source settings and do not expand destination visibility',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],source=structuredClone(f.read('events',f.source.id)),dest=structuredClone(f.read('events',f.dest.id)),before=f.read('preferences',4);
 await f.value(3,'events/'+f.dest.id+'/media/'+linked+'/likes',{liked:true});assert.deepEqual(await f.value(2,'events/'+f.source.id+'/media/111111111111/likes'),{count:1,liked:false});assert.equal((await f.api(4,'events/'+f.dest.id+'/media/'+linked+'/likes')).status,403);assert.deepEqual((await f.value(4,'events/'+f.dest.id+'/gallery')).media,[]);assert.deepEqual(f.read('events',f.source.id),source);assert.deepEqual(f.read('events',f.dest.id),dest);assert.deepEqual(f.read('preferences',4),before);
});

test('source opt-out and re-enabling do not revive old foreign grants; retrying an old add never refreshes them',async t=>{
 const f=fixture(t);await f.policy(true);const requestId=randomUUID(),linked=(await f.add(requestId)).ids[0],old=structuredClone(f.read('events',f.dest.id).media[0]);
 await f.policy(false);await f.policy(true);assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked+'/likes')).status,403);
 await f.add(requestId);assert.deepEqual(f.read('events',f.dest.id).media[0],old);
 const ownerGallery=await f.value(2,'events/'+f.dest.id+'/gallery');assert.equal(ownerGallery.media.length,0);assert.deepEqual(ownerGallery.unavailable,[{id:linked}]);
 assert.deepEqual((await f.value(3,'events/'+f.dest.id+'/gallery')).unavailable,[]);
});

test('source creator access revocation invalidates linked media for all recipients, without revoking other source viewers',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],token=f.source.viewToken;
 await f.value(1,'albums/'+f.source.id+'/members',{userId:2,blocked:true,confirm:true,version:0});
 assert.equal(f.read('events',f.source.id).viewToken,token);assert.equal((await f.api(3,'events/'+f.source.id+'/media/111111111111/likes')).status,200);
 for(const uid of [2,3])assert.equal((await f.api(uid,'events/'+f.dest.id+'/media/'+linked+'/send',{})).status,403);
 await f.msg(2,'/start p_'+token);assert.equal(f.read('preferences',2).mediaAccess[f.source.id],undefined);
 await f.msg(2,'/start u_'+f.source.uploadToken);assert.equal(f.read('preferences',2).mediaAccess[f.source.id],undefined);
 assert.equal((await f.api(2,'events/'+f.source.id+'/gallery')).status,403);
});

test('individual destination revocation is confirmed, scoped and cannot be bypassed by the same link',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],token=f.dest.viewToken;
 const stored={received:['fictional-already-sent'],pending:{'111111111111':'fictional-pending'},uncertain:{'222222222222':'fictional-unknown'}};
 const pref=f.read('preferences',3);pref.mediaDelivery={[f.dest.id]:structuredClone(stored)};f.save('preferences',3,pref);
 const otherBefore=structuredClone(f.read('preferences',5));
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/members',{userId:3,blocked:true,confirm:false,version:0})).status,400);
 await f.value(2,'albums/'+f.dest.id+'/members',{userId:3,blocked:true,confirm:true,version:0});
 assert.equal(f.read('events',f.dest.id).viewToken,token);assert.deepEqual(f.read('preferences',5),otherBefore);assert.deepEqual(f.read('preferences',3).mediaDelivery[f.dest.id].received,stored.received);assert.deepEqual(f.read('preferences',3).mediaDelivery[f.dest.id].uncertain,stored.uncertain);
 await f.msg(3,'/start p_'+token);assert.equal(f.read('preferences',3).mediaAccess[f.dest.id],undefined);assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked+'/likes')).status,403);
 assert.equal((await f.api(5,'events/'+f.dest.id+'/media/'+linked+'/likes')).status,200);
 assert.equal((await f.api(2,'albums/'+f.dest.id+'/members',{userId:5,blocked:true,confirm:true,version:0})).status,409);
 await f.value(2,'albums/'+f.dest.id+'/members',{userId:3,blocked:false,confirm:true,version:1});assert.equal((await f.api(3,'events/'+f.dest.id+'/gallery')).status,403);
 await f.msg(3,'/start p_'+token);assert.equal((await f.api(3,'events/'+f.dest.id+'/gallery')).status,200);
});

test('rotating source links invalidates old links and linked grants while preserving media and receipts',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],old=structuredClone(f.read('events',f.source.id)),pref=f.read('preferences',3);
 pref.mediaDelivery={[f.source.id]:{received:['111111111111'],pending:{'222222222222':'fictional-pending'},uncertain:{'ffffffffffff':'fictional-unknown'}}};f.save('preferences',3,pref);
 await f.value(1,'collections/'+f.source.id+'/access',{action:'regenerate',confirm:true,version:0});
 const fresh=f.read('events',f.source.id);assert.notEqual(fresh.viewToken,old.viewToken);assert.deepEqual(fresh.media,old.media);assert.deepEqual(f.read('preferences',3).mediaDelivery[f.source.id].received,['111111111111']);assert.equal(f.read('preferences',3).mediaDelivery[f.source.id].uncertain.ffffffffffff,'fictional-unknown');
 await f.msg(3,'/start p_'+old.viewToken);assert.equal(f.read('preferences',3).mediaAccess[f.source.id],undefined);
 await f.msg(3,'/start p_'+fresh.viewToken);await f.msg(2,'/start p_'+fresh.viewToken);
 assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked)).status,403);
});

test('media-only revocation preserves private event RSVP, payment and non-media session data',async t=>{
 const f=fixture(t),e=f.read('events',f.source.id);delete e.kind;e.guests[2]={name:'Fictional guest',status:'yes',ticket:'fictional-ticket',payment:{status:'paid',charge:'fictional-charge'}};f.save('events',e.id,e);f.save('sessions',2,{event:e.id,step:'phone',invitationToken:'fictional-invite'});
 const before=structuredClone(e.guests[2]),session=f.read('sessions',2);await f.value(1,'albums/'+e.id+'/members',{userId:2,blocked:true,confirm:true,version:0});
 assert.deepEqual(f.read('events',e.id).guests[2],before);assert.deepEqual(f.read('sessions',2),session);assert.equal((await f.api(2,'events/'+e.id+'/gallery')).status,403);assert.equal((await f.api(2,'events/'+e.id)).status,200);
});

for(const recipient of [2,3])test('queued references for '+recipient+' recheck source access under the concurrent scheduler and never send after revocation',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0];await f.cb(recipient,f.dest.id,'media-get','all');
 await f.value(1,'albums/'+f.source.id+'/members',{userId:2,blocked:true,confirm:true,version:0});await drainOutbox(f.env);
 assert.equal(f.calls.filter(call=>['sendPhoto','sendMediaGroup'].includes(call.method)).length,0);assert.deepEqual(f.read('preferences',recipient).mediaDelivery[f.dest.id].received,[]);
 assert.equal((await f.api(recipient,'events/'+f.dest.id+'/media/'+linked+'/delivery-status?request='+'a'.repeat(16))).status,403);
});

test('native batching resolves references to existing file IDs without altering source objects',async t=>{
 const f=fixture(t),source=f.read('events',f.source.id);source.media=Array.from({length:11},(_,i)=>({id:(i+1).toString(16).padStart(12,'0'),type:'photo',fileId:'fictional-batch-'+i,filename:'photo',name:'Fictional owner',by:1}));f.save('events',source.id,source);await f.policy(true);
 const before=structuredClone(f.read('events',source.id));await f.add(randomUUID(),source.media.map(file=>file.id));await f.cb(3,f.dest.id,'media-get','all');await drainOutbox(f.env);
 const sent=f.calls.filter(call=>['sendPhoto','sendMediaGroup'].includes(call.method));assert.deepEqual(sent.map(call=>call.method),['sendMediaGroup','sendPhoto']);assert.deepEqual(sent.flatMap(call=>call.params.media?.map(file=>file.media) || [call.params.photo]),source.media.map(file=>file.fileId));assert.deepEqual(f.read('events',source.id),before);assert.equal(f.read('preferences',3).mediaDelivery[f.dest.id].received.length,11);
});

test('disabled galleries and transitive references cannot bypass source restrictions',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0],third=photoCollection('Fictional third album',2);f.save('events',third.id,third);
 assert.equal((await f.api(2,'albums/'+third.id+'/references',{sourceEvent:f.dest.id,mediaIds:[linked],requestId:randomUUID()})).status,403);
 const event=f.read('events',f.source.id);delete event.kind;event.guests[2]={name:'Fictional guest',status:'yes'};event.permissions.viewMedia=false;f.save('events',event.id,event);
 assert.equal((await f.api(2,'events/'+event.id+'/gallery')).status,403);assert.equal((await f.api(2,'albums/'+third.id+'/references',{sourceEvent:event.id,mediaIds:['222222222222'],requestId:randomUUID()})).status,403);
});

test('revoking a source viewer blocks only that viewer across references, likes and delivery',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0];
 await f.value(1,'albums/'+f.source.id+'/members',{userId:3,blocked:true,confirm:true,version:0});
 for(const suffix of ['/likes','/thumbnail','/delivery-status?request='+'a'.repeat(16)])assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked+suffix)).status,403);
 assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked+'/send',{})).status,403);
 assert.equal((await f.value(2,'events/'+f.dest.id+'/gallery')).media.length,1);
 assert.equal((await f.value(5,'events/'+f.dest.id+'/gallery')).media.length,1);
});

test('source uploader privacy is retained when a destination exposes uploader names',async t=>{
 const f=fixture(t);await f.policy(true);await f.add();const e=f.read('events',f.source.id);e.showUploaders=false;f.save('events',e.id,e);
 const gallery=await f.value(3,'events/'+f.dest.id+'/gallery');assert.equal(gallery.media[0].name,null);assert.ok(!JSON.stringify(gallery).includes('Fictional uploader'));
});

test('legacy liker-list requests expose no names, identities or pagination and preserve likes',async t=>{
 const f=fixture(t),users={};for(let id=100;id<161;id++){users[id]='2026-01-01';f.save('users',id,{id,firstName:'Fictional liker '+id});}
 f.save('media_likes',f.source.id+':111111111111',{users});const path='events/'+f.source.id+'/media/111111111111/likes';
 for(const suffix of ['', '?offset=0','?offset=50'])assert.deepEqual(await f.value(2,path+suffix),{count:61,liked:false});assert.equal(Object.keys(f.read('media_likes',f.source.id+':111111111111').users).length,61);
});

test('named event invitation withdrawal blocks future linked access without changing RSVP records',async t=>{
 const f=fixture(t),e=f.read('events',f.source.id);delete e.kind;e.invitationMode='named';e.permissions={viewMedia:true,uploadMedia:false};e.invitees={fictional:{respondedBy:2}};e.guests={2:{status:'yes',invitationToken:'fictional'}};e.allowMediaReshare=true;f.save('events',e.id,e);
 await f.add();delete e.invitees.fictional;f.save('events',e.id,e);assert.deepEqual((await f.value(2,'events/'+f.dest.id+'/gallery')).media,[]);assert.equal(f.read('events',e.id).guests[2].status,'yes');
 assert.ok(!(await f.value(1,'albums/'+e.id+'/manage')).members.some(u=>u.id===2));
});

test('feature rollback pauses new writes while retaining reference privacy and stored records',async t=>{
 const f=fixture(t);await f.policy(true);const linked=(await f.add()).ids[0];await f.value(3,'events/'+f.dest.id+'/media/'+linked+'/likes',{liked:true});const before=f.read('events',f.dest.id);f.env.ALBUM_SOCIAL_ENABLED='false';
 assert.equal((await f.api(3,'events/'+f.dest.id+'/media/'+linked+'/likes',{liked:false})).status,503);
 const gallery=await f.value(3,'events/'+f.dest.id+'/gallery');assert.equal(gallery.socialFeatures,false);assert.equal(gallery.canRemove,false);assert.equal(gallery.media[0].canLike,false);assert.equal(gallery.media[0].likeCount,1);
 assert.deepEqual((await f.value(4,'events/'+f.dest.id+'/gallery')).media,[]);assert.equal((await f.api(4,'events/'+f.dest.id+'/media/'+linked+'/send',{})).status,403);assert.deepEqual(f.read('events',f.dest.id),before);
});
