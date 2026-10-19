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
  f.calls.length=0;
  await f.msg(1,'🗂 My stuff');
  assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.text),['Media album: '+own.title,'Media album: '+shared.title]);
  await f.cb(1,`v:${shared.id}`);assert.equal(f.calls.at(-1).text,shared.title);
  await f.msg(1,'➕ Create');
  assert.deepEqual(f.calls.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.callback_data),['nav:new','photos-new']);
  await f.cb(1,'photos-new');
  assert.equal(f.store.data.sessions[1].step,'photo-title');
  await f.msg(1,'👤 My account');
  assert.equal(f.store.data.sessions[1],undefined);
  assert.match(f.calls.at(-1).text,/My account\nName: Alex/);
  assert.equal(f.calls.at(-1).reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?tab=settings');
  await f.msg(1,'⚙️ Settings');
  assert.equal(f.calls.at(-1).reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/app?tab=settings');
  const offline=fixture('');
  await offline.msg(1,'⚙️ Settings');
  assert.match(offline.calls.at(-1).text,/when it is configured/);
});

test('My stuff lists event and gallery buttons before opening details and rechecks stale album access',async()=>{
  const f=fixture(),album=photoCollection('Fictional album',2);
  const e={id:'0123456789abcdef',title:'Fictional event',owner:1,invitationMode:'tickets',guests:{},permissions:{viewMedia:true},media:[]};
  f.store.data.events[e.id]=e;f.store.data.events[album.id]=album;
  await f.msg(1,'/start p_'+album.viewToken);f.calls.length=0;
  await f.msg(1,'🗂 My stuff');
  assert.equal(f.calls.length,2);
  const buttons=f.calls.at(-1).reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(b=>[b.text,b.callback_data]),[['Event: '+e.title,'v:'+e.id],['Media album: '+album.title,'v:'+album.id],['Media album: '+e.title,'m:'+e.id+':0']]);
  await f.cb(1,'m:'+e.id+':0');assert.ok(f.calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.web_app?.url.endsWith('?gallery='+e.id)));
  album.viewToken='a'.repeat(32);
  await f.cb(1,'v:'+album.id);
  assert.ok(!f.calls.at(-1).reply_markup.inline_keyboard?.flat().some(b=>b.web_app));
  // Keep each Telegram message bounded for accounts with many items.
  for(let i=0;i<65;i++){const item=photoCollection('Fictional album '+i,1);f.store.data.events[item.id]=item;}
  f.calls.length=0;await f.msg(1,'🗂 My stuff');
  const lists=f.calls.filter(c=>c.reply_markup?.inline_keyboard);
  assert.equal(lists.length,3);assert.ok(lists.every(c=>c.reply_markup.inline_keyboard.length<=30));
});

test('album deletion is owner-only, asks first and invalidates sharing and upload sessions',async()=>{
  const f=fixture(),e=photoCollection('Fictional album',1),other=photoCollection('Other album',1);
  f.store.data.events[e.id]=e;f.store.data.events[other.id]=other;
  await f.msg(2,'/start u_'+e.uploadToken);await f.cb(2,'media-add:'+e.id);
  assert.equal(f.store.data.sessions[2].event,e.id);
  await f.cb(2,'album-delete:'+e.id);await f.cb(2,'album-delete-confirm:'+e.id);
  assert.equal(f.store.data.events[e.id],e);
  await f.cb(1,'v:'+e.id);
  assert.equal(f.calls.at(-1).reply_markup.inline_keyboard.at(-1)[0].callback_data,'album-danger:'+e.id);
  await f.cb(1,'album-danger:'+e.id);
  assert.ok(f.calls.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='album-delete:'+e.id));
  await f.cb(1,'album-delete:'+e.id);assert.equal(f.store.data.events[e.id],e);
  assert.match(f.calls.at(-1).text,/Permanently delete media album/);
  await f.cb(1,'v:'+e.id);assert.equal(f.store.data.events[e.id],e);
  await f.cb(1,'album-delete-confirm:'+e.id);
  assert.equal(f.store.data.events[e.id],undefined);assert.equal(f.store.data.events[other.id],other);
  assert.equal(f.store.data.sessions[2],undefined);assert.equal(f.store.data.preferences[2].mediaAccess[e.id],undefined);
  await f.msg(2,'/start u_'+e.uploadToken);assert.match(f.calls.at(-1).text,/unavailable/);
  await f.msg(2,'/start p_'+e.viewToken);assert.match(f.calls.at(-1).text,/unavailable/);
  f.store.data.events.otherEvent={id:'otherEvent',owner:1,guests:{}};
  await f.cb(1,'album-delete-confirm:otherEvent');assert.ok(f.store.data.events.otherEvent);
});

test('albums accept native Telegram file types and arbitrary documents while preserving attribution',async()=>{
  const f=fixture(''),e=photoCollection('Fictional files',1);f.store.data.events[e.id]=e;
  const types=['photo','video','audio','voice','animation','video_note','sticker','document'];
  await f.cb(1,'media-add:'+e.id);
  for(const type of types){
    const file={file_id:'fictional-'+type,file_size:100,...(type==='document'?{file_name:'example.zip',mime_type:'application/zip'}:{})};
    await f.msg(1,'',{[type]:type==='photo'?[file]:file,caption:'Fictional caption'});
  }
  assert.deepEqual(e.media.map(file=>file.type),types);
  assert.ok(e.media.every(file=>file.name==='Alex' && file.by===1));
  assert.equal(e.media.at(-1).filename,'example.zip');
  for(const page of [0,1])await f.cb(1,`m:${e.id}:${page}`);
  const methods={photo:'sendPhoto',video:'sendVideo',audio:'sendAudio',voice:'sendVoice',animation:'sendAnimation',video_note:'sendVideoNote',sticker:'sendSticker',document:'sendDocument'};
  for(const type of types){
    const call=f.calls.find(call=>call.method===methods[type]);assert.equal(call[type],'fictional-'+type);
    if(['sticker','video_note'].includes(type))assert.equal(call.caption,undefined);
    else assert.match(call.caption,/Shared by Alex/);
  }
  // A viewer remains unable to upload any of the newly supported native types.
  await f.msg(2,'/start p_'+e.viewToken);await f.cb(2,'media-add:'+e.id);
  await f.msg(2,'',{audio:{file_id:'fictional-denied-audio'}});
  assert.equal(e.media.length,types.length);
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
