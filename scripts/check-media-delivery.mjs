import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {photoCollection} from '../src/permissions.js';

const calls=[];
const worker=new Miniflare(convertV4MiniflareOptions({workers:[{
  name:'fictional-media-check',modules:true,scriptPath:'.wrangler/build/worker.js',compatibilityDate:'2026-10-05',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
  bindings:{APP_ENV:'production',BOT_USERNAME:'FictionalBot',APP_URL:'https://fictional.test/app',TELEGRAM_BOT_TOKEN:'fictional-token',TELEGRAM_WEBHOOK_SECRET:'fictional-secret'},
  outboundService:async request=>{const params=await request.json();calls.push({method:new URL(request.url).pathname.split('/').at(-1),...params});return Response.json({ok:true,result:{message_id:calls.length,chat:{id:params.chat_id}}});}
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
  console.log('Worker upload completion, shared menus, pending deduplication, delivery receipts and Follow on/off passed. D1 local; Telegram mocked.');
}finally{await worker.dispose();}
