import test from 'node:test';
import assert from 'node:assert/strict';
import {Bot} from '../src/bot.js';
import {photoCollection,photoLinks} from '../src/permissions.js';
function fixture(){
  const e=photoCollection('Fictional album',1),data={events:{[e.id]:e},preferences:{2:{mediaAccess:{[e.id]:e.viewToken}},3:{mediaAccess:{[e.id]:e.uploadToken}}},sessions:{}},calls=[];
  const bot=new Bot({data},async(method,params)=>{calls.push({method,...params});return {};},'FictionalBot','https://example.test/app');
  const cb=(id,action,arg)=>bot.handle({callback_query:{id:'fictional',from:{id,first_name:'Fictional'},data:`${action}:${e.id}${arg?':'+arg:''}`}});
  const last=()=>calls.at(-1),buttons=()=>(last().reply_markup?.inline_keyboard || last().reply_markup?.keyboard)?.flat() || [];
  return {e,data,calls,bot,cb,last,buttons};
}
test('album main menu uses the approved four readable rows and moves management into More',async()=>{
  const f=fixture();await f.cb(1,'v');
  assert.deepEqual(f.last().reply_markup.inline_keyboard.map(row=>row.map(b=>b.text)),[['📂 Open album app'],['📥 Get all (0)','🆕 Get new (0)'],['➕ Add media','🔗 Share'],['🔔 Follow:ON','⋯ More','🔄 Refresh']]);
  assert.ok(f.buttons().every(button=>button.text.length<24));
  await f.cb(1,'album-more');assert.ok(f.buttons().some(b=>b.callback_data===`album-danger:${f.e.id}`));assert.ok(f.buttons().some(b=>b.text==='🏠 Main menu'));
  await f.cb(2,'album-more');assert.ok(f.buttons().some(b=>b.text==='🚪 Leave album'));assert.ok(!f.buttons().some(b=>b.text==='⚠️ Danger zone'));
});

test('Album App launches directly inline; legacy text command still preserves album context and input',async()=>{
 const f=fixture();await f.cb(2,'v');assert.equal(f.last().reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?gallery='+f.e.id);const received=structuredClone(f.data.preferences[2].mediaDelivery);f.data.sessions[2]={step:'phone',event:f.e.id,fictionalInput:'keep'};
 await f.bot.handle({message:{chat:{id:2,type:'private'},from:{id:2},text:'📂 Open album app'}});assert.equal(f.last().reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?gallery='+f.e.id);assert.equal(f.last().reply_markup.keyboard,undefined);assert.deepEqual(f.data.sessions[2],{step:'phone',event:f.e.id,fictionalInput:'keep'});assert.deepEqual(f.data.preferences[2].mediaDelivery,received);assert.ok(f.calls.every(call=>call.method!=='sendMediaGroup' && call.method!=='sendPhoto'));
});

test('stale-keyboard recovery deep link rechecks current album permission and never grants access or sends media',async()=>{
 const f=fixture();await f.bot.handle({message:{chat:{id:2,type:'private'},from:{id:2},text:'/start albumapp_'+f.e.id}});assert.equal(f.last().reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?gallery='+f.e.id);
 const before=structuredClone(f.data);for(const id of [4,2]){if(id===2)f.e.viewToken='f'.repeat(32);await f.bot.handle({message:{chat:{id,type:'private'},from:{id},text:'/start albumapp_'+f.e.id}});assert.match(f.last().text,/unavailable/);assert.equal(f.last().reply_markup,undefined);assert.ok(!f.last().text.includes(f.e.title));}assert.equal(f.data.preferences[4],undefined);assert.deepEqual(f.data.preferences[2].mediaAccess,before.preferences[2].mediaAccess);assert.ok(f.calls.every(call=>call.method==='sendMessage'));
 f.bot.appUrl='';await f.cb(1,'album-app');assert.match(f.last().text,/not configured/);assert.ok(f.calls.every(call=>call.method==='sendMessage' || call.method==='answerCallbackQuery'));
});

test('restored inline album controls retain album-scoped Refresh and clear a legacy keyboard only once',async()=>{
 const f=fixture();f.data.preferences[2].activeAlbum=f.e.id;await f.cb(2,'album-open');
 assert.equal(f.calls.filter(c=>c.reply_markup?.remove_keyboard).length,1);
 assert.equal(f.last().reply_markup.keyboard,undefined);
 assert.equal(f.buttons()[0].web_app.url,'https://example.test/app?gallery='+f.e.id);
 assert.equal(f.buttons().find(b=>b.text==='🔄 Refresh').callback_data,'album-open:'+f.e.id);
 const before=structuredClone(f.data.preferences[2].mediaDelivery);
 await f.cb(2,'album-open');assert.equal(f.calls.filter(c=>c.reply_markup?.remove_keyboard).length,1);
 assert.deepEqual(f.data.preferences[2].mediaDelivery,before);
 assert.ok(f.calls.every(c=>!['sendPhoto','sendMediaGroup'].includes(c.method)));
 f.e.viewToken='f'.repeat(32);await f.cb(2,'album-open');assert.match(f.last().text,/unavailable/);
 assert.ok(!JSON.stringify(f.last()).includes(f.e.title));
});

test('opening inline album controls preserves a live single-button Cancel keyboard',async()=>{
 const f=fixture();await f.cb(2,'album-open');const pref=f.data.preferences[2];delete pref.albumControlsInline;
 const state=pref.mediaDelivery[f.e.id];state.jobs={fictional:{id:'fictional',items:{photo:{status:'queued',token:'fictional'}},notice:{}}};pref.mediaKeyboard={event:f.e.id,job:'fictional'};
 f.calls.length=0;await f.cb(2,'album-open');assert.ok(!f.calls.some(c=>c.reply_markup?.remove_keyboard));
 assert.ok(f.last().reply_markup.inline_keyboard);assert.equal(f.last().reply_markup.keyboard,undefined);
 assert.equal(f.bot.idleKeyboard(2).keyboard.length,1);assert.match(f.bot.idleKeyboard(2).keyboard[0][0].text,/Cancel/);
});
test('Share defaults to contributor when permitted, persists OFF, and never changes existing album access or tokens',async()=>{
  const f=fixture(),before=JSON.stringify(f.e),links=photoLinks(f.e,'FictionalBot');
  await f.cb(1,'album-share');assert.match(f.buttons()[0].text,/ON$/);assert.equal(f.buttons().find(b=>b.text==='Copy link').copy_text.text,links.contributor);
  await f.cb(1,'album-share-set','off');assert.match(f.buttons()[0].text,/OFF$/);assert.equal(f.buttons().find(b=>b.text==='Copy link').copy_text.text,links.viewer);
  await f.cb(1,'album-share');assert.match(f.buttons()[0].text,/OFF$/);assert.equal(JSON.stringify(f.e),before);
  await f.cb(3,'album-share');assert.match(f.buttons()[0].text,/ON$/);assert.equal(JSON.stringify(f.e),before);
});
test('viewer cannot promote a shared link or obtain a contributor token through forged Share callbacks',async()=>{
  const f=fixture();for(const action of ['album-share','album-share-set']){await f.cb(2,action,'on');assert.match(f.buttons()[0].text,/OFF$/);assert.equal(f.buttons().find(b=>b.text==='Copy link').copy_text.text,photoLinks(f.e,'FictionalBot').viewer);assert.ok(!JSON.stringify(f.last()).includes(f.e.uploadToken));}
  await f.cb(2,'media-add');assert.notEqual(f.data.sessions[2]?.step,'upload');
});
test('explicit upload restrictions and disabled sharing are preserved without silently enabling access',async()=>{
  const f=fixture();f.e.allowLinkUploads=false;const before=JSON.stringify(f.e);
  await f.cb(1,'album-share-set','on');assert.match(f.buttons()[0].text,/OFF$/);assert.equal(JSON.stringify(f.e),before);
  f.e.sharingDisabled=true;await f.cb(1,'album-share');assert.ok(!f.buttons().some(b=>b.copy_text));
  await f.cb(3,'album-share');assert.match(f.last().text,/unavailable/);assert.ok(!f.last().text.includes(f.e.title));
});

test('event media gains the album controls under the existing event ID while the event card remains separate',async()=>{
  const f=fixture();delete f.e.kind;f.e.guests={2:{name:'Guest',status:'yes'}};
  const before=JSON.stringify(f.e);
  await f.cb(1,'m','0');assert.deepEqual(f.last().reply_markup.inline_keyboard.slice(0,4).map(row=>row.map(b=>b.text)),[['📂 Open album app'],['📥 Get all (0)','🆕 Get new (0)'],['➕ Add media','🔗 Share'],['🔕 Follow:OFF','⋯ More','🔄 Refresh']]);
  await f.cb(1,'album-share');assert.match(f.buttons()[0].text,/ON$/);assert.ok(f.buttons().find(b=>b.text==='Copy link').copy_text.text.includes('start=u_'));
  await f.cb(1,'album-share-set','off');assert.equal(f.buttons().find(b=>b.text==='Copy link').copy_text.text,`https://t.me/FictionalBot?startapp=gallery_${f.e.id}`);
  assert.equal(JSON.stringify(f.e),before);assert.equal(Object.keys(f.data.events).length,1);
  await f.cb(1,'album-more');assert.ok(f.buttons().some(b=>b.text==='↩️ Back to event'));assert.ok(!f.buttons().some(b=>b.callback_data?.startsWith('album-danger:')));
  await f.cb(1,'v');assert.ok(!f.buttons().some(b=>b.text==='📥 Get all (0)'));
});
test('private event guest, link contributor, disabled gallery and outsider checks keep their existing boundaries',async()=>{
  const f=fixture();delete f.e.kind;f.e.guests={2:{name:'Guest',status:'yes'}};
  await f.cb(2,'album-open');assert.equal(f.last().text,f.e.title);
  await f.cb(3,'album-open');assert.equal(f.last().text,f.e.title);
  await f.cb(4,'album-share');assert.match(f.last().text,/unavailable/);
  f.e.allowLinkUploads=false;const before=JSON.stringify(f.e);
  await f.cb(1,'album-share-set','on');assert.match(f.buttons()[0].text,/OFF$/);assert.equal(JSON.stringify(f.e),before);
  await f.cb(3,'album-open');assert.match(f.last().text,/unavailable/);
  f.e.permissions.viewMedia=false;await f.cb(2,'album-open');assert.match(f.last().text,/unavailable/);
  await f.cb(1,'album-open');assert.equal(f.last().text,f.e.title);
});
