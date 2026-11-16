import {createHmac,randomUUID} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {photoCollection} from '../src/permissions.js';

const calls=[];
const worker=new Miniflare(convertV4MiniflareOptions({workers:[{
  name:'fictional-media-check',modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{APP_ENV:'production',BOT_USERNAME:'FictionalBot',APP_URL:'https://fictional.test/app',TELEGRAM_BOT_TOKEN:'fictional-token',TELEGRAM_WEBHOOK_SECRET:'fictional-secret'},
  outboundService:async request=>{const params=await request.json();calls.push({method:new URL(request.url).pathname.split('/').at(-1),...params});return Response.json({ok:true,result:new URL(request.url).pathname.endsWith('/sendMediaGroup')?params.media.map((_,index)=>({message_id:calls.length*10+index,chat:{id:params.chat_id}})):{message_id:calls.length,chat:{id:params.chat_id}}});}
}]}));
try{
  const db=await worker.getD1Database('DB');
  for(const file of ['0001_initial.sql','0002_delivery_lease.sql','0003_mini_app.sql'])await db.exec((await readFile('migrations/'+file,'utf8')).replace(/\n/g,' '));
  const album=photoCollection('Fictional Worker album',1);
  const save=(kind,id,value)=>db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').bind(kind,String(id),JSON.stringify(value)).run();
  const read=async(kind,id)=>JSON.parse((await db.prepare('SELECT data FROM records WHERE kind=? AND id=?').bind(kind,String(id)).first()).data);
  await save('events',album.id,album);
  let next=800;
  const update=async body=>{
    const response=await worker.dispatchFetch('https://fictional.test/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'fictional-secret'},body:JSON.stringify({update_id:next++,...body})});assert.equal(response.status,200);
  };
  const message=(id,text,extra={})=>update({message:{chat:{id,type:'private'},from:{id,first_name:'Fictional guest'},text,...extra}});
  const callback=(id,action,arg)=>update({callback_query:{id:'fictional-'+next,from:{id,first_name:'Fictional guest'},data:`${action}:${album.id}${arg?':'+arg:''}`}});
  const settle=async()=>{for(let i=0;i<150;i++){if((await db.prepare('SELECT count(*) AS n FROM outbox').first()).n===0)return;await new Promise(resolve=>setTimeout(resolve,40));}assert.fail('Mocked media delivery did not settle.');};
  // Hold the sender to verify durable queue state independently of Telegram.
  await db.prepare("INSERT INTO delivery_lease(id,owner,expires) VALUES(1,'fictional-hold',unixepoch()+60)").run();
  await message(2,'/start p_'+album.viewToken);await message(3,'/start u_'+album.uploadToken);
  await callback(2,'media-follow','on');await callback(3,'media-add');
  await message(3,'',{photo:[{file_id:'fictional-photo'}]});await message(3,'✅ Finish uploads');
  const receipt=calls.find(call=>call.text?.includes('Finish uploads received'));assert.ok(receipt);
  const state=await read('preferences',2);assert.equal(state.mediaDelivery[album.id].received.length,0);assert.equal(Object.keys(state.mediaDelivery[album.id].pending).length,1);
  await callback(2,'media-get','new');
  await db.prepare("DELETE FROM delivery_lease WHERE owner='fictional-hold'").run();
  await callback(2,'v');await settle();
  const photos=calls.filter(call=>call.method==='sendPhoto');assert.equal(photos.length,1);assert.equal(photos[0].chat_id,2);assert.match(photos[0].caption,/New media/);assert.equal(photos[0].__mediaDelivery,undefined);
  assert.equal((await read('preferences',2)).mediaDelivery[album.id].received.length,1);
  assert.ok(calls.some(call=>call.method==='editMessageText' && call.message_id===calls.indexOf(receipt)+1 && call.text.includes('Uploads finished')));
  await callback(2,'media-get','new');await settle();assert.equal(calls.filter(call=>call.method==='sendPhoto').length,1);
  await callback(2,'media-follow','off');await settle();await callback(3,'media-add');await message(3,'',{photo:[{file_id:'fictional-photo-two'}]});await settle();
  assert.equal(calls.filter(call=>call.method==='sendPhoto').length,1);
  await callback(2,'media-get','all');await settle();
  const albums=calls.filter(call=>call.method==='sendMediaGroup');
  assert.equal(albums.length,1);assert.equal(albums[0].media.length,2);
  assert.deepEqual(albums[0].media.map(file=>file.media),['fictional-photo','fictional-photo-two']);
  assert.equal((await read('preferences',2)).mediaDelivery[album.id].received.length,2);
  await callback(2,'media-get','new');await settle();
  assert.equal(calls.filter(call=>call.method==='sendMediaGroup').length,1);
  const auth=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:2,first_name:'Fictional viewer'})});
  const dataCheck=[...auth].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const authKey=createHmac('sha256','WebAppData').update('fictional-token').digest();auth.set('hash',createHmac('sha256',authKey).update(dataCheck).digest('hex'));
  const firstFile=(await read('events',album.id)).media[0],base=`https://fictional.test/api/events/${album.id}/media/${firstFile.id}`,headers={Authorization:'tma '+auth.toString()};
  await db.prepare("INSERT INTO delivery_lease(id,owner,expires) VALUES(1,'fictional-status-hold',unixepoch()+60)").run();
  const started=await worker.dispatchFetch(base+'/send',{method:'POST',headers});assert.equal(started.status,200);const tracking=await started.json();assert.equal(tracking.status,'queued');
  const statusUrl=base+'/delivery-status?request='+tracking.request;
  assert.equal((await worker.dispatchFetch(statusUrl)).status,401);
  assert.equal((await (await worker.dispatchFetch(statusUrl,{headers})).json()).status,'queued');
  await db.prepare("DELETE FROM delivery_lease WHERE owner='fictional-status-hold'").run();await callback(2,'v');await settle();
  assert.equal((await (await worker.dispatchFetch(statusUrl,{headers})).json()).status,'sent');
  const pref=await read('preferences',2);pref.mediaAccess={};await save('preferences',2,pref);
  assert.equal((await worker.dispatchFetch(statusUrl,{headers})).status,403);

  const signed=id=>{const q=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id,first_name:'Fictional viewer'})});const text=[...q].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');q.set('hash',createHmac('sha256',authKey).update(text).digest('hex'));return 'tma '+q;};
  const api=async(id,path,input)=>{const response=await worker.dispatchFetch('https://fictional.test/api/'+path,{method:input===undefined?'GET':'POST',headers:{Authorization:signed(id),'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return response;};
  pref.mediaAccess={[album.id]:album.viewToken};await save('preferences',2,pref);
  const liked=await api(2,'events/'+album.id+'/media/'+firstFile.id+'/likes',{liked:true});assert.equal(liked.status,200);assert.equal((await liked.json()).count,1);
  const counts=await api(2,'events/'+album.id+'/media/'+firstFile.id+'/likes');assert.deepEqual(await counts.json(),{count:1,liked:true});
  const created=await api(2,'collections',{title:'Fictional private collection',personal:true,requestId:randomUUID()});assert.equal(created.status,200);const personal=(await created.json()).event;assert.equal(personal.sharingDisabled,true);
  const input={sourceEvent:album.id,mediaIds:[firstFile.id],requestId:randomUUID()};assert.equal((await api(2,'albums/'+personal.id+'/references',input)).status,403);
  assert.equal((await api(1,'albums/'+album.id+'/reshare',{allowed:true,confirm:true,version:0})).status,200);
  const imported=await api(2,'albums/'+personal.id+'/references',input);assert.equal(imported.status,200);const linked=(await imported.json()).ids[0];
  const gallery=await api(2,'events/'+personal.id+'/gallery');assert.equal((await gallery.json()).media[0].liked,true);
  assert.equal((await api(3,'events/'+personal.id+'/gallery')).status,403);
  const copied=await api(2,'albums/'+personal.id+'/copies',{sourceEvent:album.id,mediaId:firstFile.id,requestId:crypto.randomUUID()});assert.equal(copied.status,200);const savedPhoto=(await copied.json()).ids[0];
  assert.equal((await api(2,'collections/'+personal.id+'/access',{action:'regenerate',confirm:true,version:0})).status,200);
  const shared=await read('events',personal.id);await message(4,'/start p_'+shared.viewToken);await settle();
  const viewerGallery=await api(4,'events/'+personal.id+'/gallery');const visible=(await viewerGallery.json()).media;assert.equal(visible.length,1);assert.equal(visible[0].id,savedPhoto);assert.equal(visible[0].savedCopy,true);
  assert.equal((await api(1,'albums/'+album.id+'/members',{userId:2,blocked:true,confirm:true,version:0})).status,200);
  assert.equal((await api(2,'events/'+personal.id+'/media/'+linked+'/likes')).status,403);
  assert.equal((await api(2,'events/'+personal.id+'/media/'+linked+'/send',{})).status,403);
  assert.deepEqual(await(await api(4,'events/'+personal.id+'/media/'+savedPhoto+'/likes')).json(),{count:0,liked:false});
  assert.equal((await api(4,'events/'+personal.id+'/media/'+savedPhoto+'/send',{})).status,200);await settle();assert.ok((await read('preferences',4)).mediaDelivery[personal.id].received.includes(savedPhoto));
  console.log('Worker single-photo save, destination-only visibility and delivery after source revocation passed. D1 local; Telegram mocked.');
  console.log('Worker personal albums, canonical photo likes, consent and source revocation passed. D1 local; Telegram mocked.');
  console.log('Worker upload completion, shared menus, pending deduplication, delivery receipts and Follow on/off passed. D1 local; Telegram mocked.');
}finally{await worker.dispose();}
