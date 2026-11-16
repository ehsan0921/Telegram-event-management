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

test('likes use verified identity, are idempotent under concurrency, and responses expose only counts and own state to current photo viewers',async t=>{
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

test('legacy liker-list requests return count only and never names, identities or pagination',async t=>{
 const f=fixture(t),users={};for(let id=100;id<161;id++){users[id]='2026-01-01';f.save('users',id,{id,firstName:'Fictional liker '+id});}
 f.save('media_likes',f.source.id+':111111111111',{users});const path='events/'+f.source.id+'/media/111111111111/likes';
 for(const suffix of ['', '?offset=0','?offset=50']){const result=await f.value(2,path+suffix);assert.deepEqual(result,{count:61,liked:false});assert.ok(!JSON.stringify(result).includes('Fictional liker'));}assert.equal(Object.keys(f.read('media_likes',f.source.id+':111111111111').users).length,61);
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
