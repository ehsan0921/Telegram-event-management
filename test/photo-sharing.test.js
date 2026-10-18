import test from 'node:test';
import assert from 'node:assert/strict';
import {Bot} from '../src/bot.js';
import {photoCollection,photoLinks,mediaCan,mediaRole} from '../src/permissions.js';
import {publicEvent} from '../src/mini-api.js';
import {mediaApi} from '../src/media-api.js';

function fixture(appUrl='https://example.test/app'){
  const store={data:{events:{},sessions:{},preferences:{},users:{},offset:0}},calls=[];
  const bot=new Bot(store,async(method,params)=>{calls.push({method,...params});return {};},'FictionalPhotosBot',appUrl);
  const msg=(id,text,extra={})=>bot.handle({message:{chat:{id,type:'private'},from:{id,first_name:'Alex'},text,...extra}});
  const cb=(id,data)=>bot.handle({callback_query:{id:'fictional',from:{id,first_name:'Alex'},data}});
  return {store,bot,calls,msg,cb};
}

test('photo-only creation works from the keyboard and from Create event without a schedule or RSVP',async()=>{
  for(const entry of ['keyboard','create']){
    const f=fixture();
    if(entry==='keyboard')await f.msg(1,'📷 Photo sharing');
    else{
      await f.msg(1,'🎉 Create event');
      assert.ok(f.calls.some(c=>c.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='photos-new')));
      await f.cb(1,'photos-new');
    }
    await f.msg(1,'Fictional holiday photos');
    const e=Object.values(f.store.data.events)[0];
    assert.equal(e.kind,'photos');assert.equal(e.startsAt,undefined);assert.equal(e.isPublic,false);assert.deepEqual(e.guests,{});
    assert.notEqual(e.viewToken,e.uploadToken);
    const card=f.calls.at(-1),buttons=card.reply_markup.inline_keyboard.flat();
    for(const role of ['viewer','contributor']){
      const copy=buttons.find(b=>b.text===`Copy ${role} link`);
      assert.equal(copy.copy_text.text,photoLinks(e,'FictionalPhotosBot')[role]);
      assert.equal(copy.url,undefined);assert.equal(copy.callback_data,undefined);
    }
    assert.ok(!buttons.some(b=>/ticket|RSVP|Accept/.test(b.text)));
    assert.ok(publicEvent(e,1,'FictionalPhotosBot').photoLinks);
    assert.equal(publicEvent(e,2,'FictionalPhotosBot').photoLinks,undefined);
  }
});

test('album keyboard creates collections and lists only accessible active albums',async()=>{
  const f=fixture();
  await f.msg(1,'📷 Create Album');
  await f.msg(1,'Fictional album');
  const own=Object.values(f.store.data.events)[0];
  const shared=photoCollection('Shared album',2),privateAlbum=photoCollection('Private album',2),cancelled=photoCollection('Cancelled album',1);
  cancelled.cancelled=true;
  for(const e of [shared,privateAlbum,cancelled])f.store.data.events[e.id]=e;
  await f.msg(1,'/start p_'+shared.viewToken);
  f.calls.length=0;
  await f.msg(1,'🗂 My album');
  assert.deepEqual(f.calls.slice(1).map(c=>c.text),[own.title,shared.title]);
  assert.equal(f.store.data.sessions[1],undefined);
  await f.msg(1,'⚙️ Settings');
  assert.equal(f.calls.at(-1).reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?tab=settings');
  const offline=fixture('');
  await offline.msg(1,'⚙️ Settings');
  assert.match(offline.calls.at(-1).text,/when it is configured/);
});

test('viewers cannot upload via callbacks, guessed upload links or stale contributor sessions',async()=>{
  const f=fixture(),e=photoCollection('Shared memories',1);f.store.data.events[e.id]=e;
  await f.msg(2,'/start p_'+e.viewToken);
  assert.equal(mediaRole(e,2,f.store.data.preferences[2]),'viewer');
  assert.equal(f.bot.mediaCan(e,2,'viewMedia'),true);assert.equal(f.bot.mediaCan(e,2,'uploadMedia'),false);
  assert.ok(!f.calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data?.startsWith('media-add:')));
  await f.cb(2,'media-add:'+e.id);assert.notEqual(f.store.data.sessions[2]?.step,'upload');
  await f.msg(2,'/start a_'+e.id);assert.notEqual(f.store.data.sessions[2]?.step,'upload');
  await f.cb(2,'book:'+e.id);assert.deepEqual(e.guests,{});
  await f.msg(3,'/start u_'+e.uploadToken);await f.cb(3,'media-add:'+e.id);
  assert.equal(f.store.data.sessions[3].step,'upload');
  await f.msg(3,'',{photo:[{file_id:'fictional-photo',file_size:100}]});assert.equal(e.media.length,1);
  // Simulate access changing while an old upload prompt remains in Telegram.
  f.store.data.preferences[3].mediaAccess[e.id]=e.viewToken;
  await f.msg(3,'',{photo:[{file_id:'fictional-denied-photo'}]});assert.equal(e.media.length,1);
  assert.deepEqual(e.guests,{});
  await f.msg(4,'/start e_'+e.id);assert.equal(f.bot.mediaAllowed(e,4),false);assert.deepEqual(e.guests,{});
});

test('gallery enforces role grants, shares only the viewer link and rejects invalidated tokens',async()=>{
  const e=photoCollection('Fictional gallery',1),pref={mediaAccess:{[e.id]:e.viewToken}};
  const env={BOT_USERNAME:'FictionalPhotosBot',DB:{prepare(sql){return {bind(){return this;},async first(){return {data:JSON.stringify(sql.includes("kind='events'")?e:pref)};}};}}};
  const request=()=>new Request(`https://example.test/api/events/${e.id}/gallery`);
  let response=await mediaApi(request(),env,{id:2}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.canUpload,false);assert.equal(body.galleryUrl,photoLinks(e,env.BOT_USERNAME).viewer);
  assert.ok(!JSON.stringify(body).includes(e.uploadToken));
  pref.mediaAccess[e.id]=e.uploadToken;
  body=await (await mediaApi(request(),env,{id:2})).json();assert.equal(body.canUpload,true);
  e.uploadToken='a'.repeat(32);assert.equal((await mediaApi(request(),env,{id:2})).status,403);
  pref.mediaAccess[e.id]=e.viewToken;e.cancelled=true;assert.equal((await mediaApi(request(),env,{id:2})).status,403);
});

test('collections fail closed without valid grants and existing event media permissions stay unchanged',()=>{
  const e=photoCollection('Fictional',1);
  assert.equal(mediaCan(e,2,'viewMedia'),false);assert.equal(mediaCan(e,2,'uploadMedia'),false);
  assert.equal(mediaCan(e,1,'uploadMedia'),true);
  const legacy={owner:1,guests:{2:{status:'yes'}},permissions:{viewMedia:true,uploadMedia:false}};
  assert.equal(mediaCan(legacy,2,'viewMedia'),true);assert.equal(mediaCan(legacy,2,'uploadMedia'),false);
});

test('only owners change uploader visibility and hidden names never appear in gallery metadata or bot attribution',async()=>{
  const f=fixture(''),e=photoCollection('Fictional memories',1);f.store.data.events[e.id]=e;
  e.media.push({id:'abcdef123456',type:'photo',fileId:'fictional-media',filename:'photo',name:'Fictional uploader',by:3,caption:'Holiday sunset'});
  await f.msg(2,'/start p_'+e.viewToken);
  await f.cb(2,'photo-names:'+e.id);assert.equal(e.showUploaders,true);
  await f.cb(1,'photo-names:'+e.id);assert.equal(e.showUploaders,false);
  const pref=f.store.data.preferences[2];
  const env={BOT_USERNAME:'FictionalPhotosBot',DB:{prepare(sql){return {bind(){return this;},async first(){return {data:JSON.stringify(sql.includes("kind='events'")?e:pref)};}};}}};
  const request=()=>new Request(`https://example.test/api/events/${e.id}/gallery`);
  const hidden=await(await mediaApi(request(),env,{id:2})).json();
  assert.equal(hidden.media[0].name,null);assert.equal(hidden.media[0].by,undefined);
  assert.ok(!JSON.stringify(hidden).includes('Fictional uploader'));assert.equal(hidden.media[0].caption,'Holiday sunset');
  await f.cb(2,`m:${e.id}:0`);
  assert.equal(f.calls.findLast(c=>c.method==='sendPhoto').caption,'Shared media\nHoliday sunset');
  assert.equal(e.media[0].name,'Fictional uploader');assert.equal(e.media[0].by,3);
  await f.cb(1,'photo-names:'+e.id);
  const visible=await(await mediaApi(request(),env,{id:2})).json();assert.equal(visible.media[0].name,'Fictional uploader');
  await f.cb(2,`m:${e.id}:0`);assert.match(f.calls.findLast(c=>c.method==='sendPhoto').caption,/Shared by Fictional uploader/);
});
