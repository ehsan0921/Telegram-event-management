import test from 'node:test';
import assert from 'node:assert/strict';
import {Bot} from '../src/bot.js';
import {photoCollection,mediaRole} from '../src/permissions.js';
import {invitationSettings} from '../src/invitations.js';
import {leaveAlbum,removeInvitation,visibleStuff} from '../src/stuff.js';

function fixture(mode='legacy'){
  const e={id:'0123456789abcdef',owner:1,title:'Fictional gathering',startsAt:'2099-10-24T08:00:00Z',timezone:'Australia/Sydney',location:'Example venue',guests:{2:{name:'Fictional guest',status:'yes',responseRecorded:true,responseVersion:3,ticket:'FICTIONAL',participants:2,comment:'Keep this comment',answers:['Example answer']}},media:[],permissions:{},...invitationSettings({invitationMode:mode,...(mode==='named'?{guestNames:'Fictional guest'}:{})})};
  if(mode==='named'){const token=Object.keys(e.invitees)[0];e.guests[2].invitationToken=token;e.invitees[token].respondedBy=2;}
  const data={events:{[e.id]:e},preferences:{},sessions:{}},calls=[];
  const bot=new Bot({data},async(method,params)=>calls.push({method,...params}),'FictionalBot');
  return {e,data,bot,calls};
}

test('opening album links saves access without downgrading a contributor; leaving preserves uploads',async()=>{
  const {data,bot}=fixture(),album=photoCollection('Fictional album',1);data.events[album.id]=album;
  const start=text=>bot.handle({message:{from:{id:2,first_name:'Alex'},chat:{id:2,type:'private'},text}});
  await start('/start p_'+album.viewToken);assert.equal(visibleStuff(album,2,data.preferences[2]),true);
  await start('/start u_'+album.uploadToken);await start('/start p_'+album.viewToken);
  assert.equal(mediaRole(album,2,data.preferences[2]),'contributor');
  album.media.push({id:'example',by:2,fileId:'fictional'});data.sessions[2]={event:album.id,step:'upload'};
  leaveAlbum(data,2,album);assert.equal(visibleStuff(album,2,data.preferences[2]),false);assert.equal(data.sessions[2],undefined);assert.equal(album.media.length,1);
  assert.throws(()=>leaveAlbum(data,1,album));
  await start('/start p_'+album.viewToken);assert.equal(mediaRole(album,2,data.preferences[2]),'viewer');
});

for(const mode of ['legacy','tickets','named'])test(mode+': hide invitation keeps stored RSVP and claim; cancellation uses existing response flow',async()=>{
  const f=fixture(mode),before=structuredClone(f.e.guests[2]);
  await removeInvitation(f.bot,2,f.e,{notify:false});assert.deepEqual(f.e.guests[2],before);assert.equal(visibleStuff(f.e,2,f.data.preferences[2]),false);assert.equal(f.calls.length,0);
  await f.bot.card(2,f.e);assert.equal(visibleStuff(f.e,2,f.data.preferences[2]),false,'Automatic cards must not restore a removed invitation.');
  await f.bot.handle({callback_query:{from:{id:2},data:'v:'+f.e.id}});assert.equal(visibleStuff(f.e,2,f.data.preferences[2]),true);
  f.calls.length=0;await removeInvitation(f.bot,2,f.e,{notify:true,version:3});
  assert.equal(f.e.guests[2].status,'no');assert.equal(f.e.guests[2].responseVersion,4);assert.equal(f.e.guests[2].comment,before.comment);assert.equal(f.e.guests[2].invitationToken,before.invitationToken);
  assert.ok(f.calls.some(call=>call.chat_id===1 && call.text.includes('Not coming')));
  assert.equal(visibleStuff(f.e,2,f.data.preferences[2]),false);
  const sent=f.calls.length;await removeInvitation(f.bot,2,f.e,{notify:true,version:4});assert.equal(f.calls.length,sent);
});

test('past invitation removal preserves response and never announces cancellation',async()=>{
  const f=fixture();f.e.startsAt='2000-01-01T00:00:00Z';const previous=structuredClone(f.e.guests[2]);
  await removeInvitation(f.bot,2,f.e,{notify:true,version:3});assert.deepEqual(f.e.guests[2],previous);assert.equal(f.calls.length,0);
});

test('cancellation preserves payment, deadline, checked-in, ownership and stale-response protections',async()=>{
  for(const status of ['reported','processing','paid','refund_pending','refund_failed']){
    const f=fixture();f.e.guests[2].payment={status,audit:'fictional'};const before=structuredClone(f.e.guests[2]);
    await assert.rejects(removeInvitation(f.bot,2,f.e,{notify:true,version:3}));assert.deepEqual(f.e.guests[2],before);assert.equal(f.calls.length,0);
    await removeInvitation(f.bot,2,f.e,{notify:false});assert.deepEqual(f.e.guests[2],before);
  }
  const f=fixture();await assert.rejects(removeInvitation(f.bot,1,f.e));await assert.rejects(removeInvitation(f.bot,3,f.e));await assert.rejects(removeInvitation(f.bot,2,f.e,{notify:true,version:2}));
  f.e.checkIns={FICTIONAL:{userId:2}};await assert.rejects(removeInvitation(f.bot,2,f.e,{notify:true,version:3}));delete f.e.checkIns;
  f.e.responseDeadline='2000-01-01T00:00:00Z';await assert.rejects(removeInvitation(f.bot,2,f.e,{notify:true,version:3}));assert.equal(f.e.guests[2].status,'yes');
});
