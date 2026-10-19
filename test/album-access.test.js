import test from 'node:test';
import assert from 'node:assert/strict';
import {changeAlbumAccess} from '../src/album-access.js';
import {photoCollection,photoLinks,mediaRole,mediaCan,shareUploadLink} from '../src/permissions.js';
import {visibleStuff} from '../src/stuff.js';
import {Bot} from '../src/bot.js';

function fixture(){
  const album=photoCollection('Fictional album',1),other=photoCollection('Other album',2);
  album.media.push({id:'fictional-media',fileId:'fictional-file'});
  const data={events:{[album.id]:album,[other.id]:other},sessions:{1:{event:album.id,step:'upload',uploadToken:album.uploadToken},2:{event:album.id,step:'upload',uploadToken:album.uploadToken},3:{event:other.id,step:'upload'}},preferences:{2:{mediaAccess:{[album.id]:album.uploadToken,[other.id]:other.viewToken}},3:{mediaAccess:{[album.id]:album.viewToken}}}};
  return {album,other,data};
}

test('disable makes albums creator-only, invalidates links/grants and clears guest upload sessions',()=>{
  const {album,other,data}=fixture(),oldViewer=album.viewToken,oldContributor=album.uploadToken,files=structuredClone(album.media);
  album.cohost={id:4};
  changeAlbumAccess(data,1,album,{action:'disable',confirm:true,version:0});
  assert.equal(album.sharingDisabled,true);assert.equal(album.albumAccessVersion,1);assert.notEqual(album.viewToken,oldViewer);assert.notEqual(album.uploadToken,oldContributor);
  assert.equal(photoLinks(album,'FictionalBot'),null);assert.equal(shareUploadLink(album,'FictionalBot'),null);
  assert.equal(mediaCan(album,1,'uploadMedia'),true);assert.equal(mediaRole(album,4),null);
  assert.equal(visibleStuff(album,4),false);
  assert.equal(mediaRole(album,3,{mediaAccess:{[album.id]:oldViewer}}),null);
  assert.equal(mediaRole(album,2,{mediaAccess:{[album.id]:oldContributor}}),null);
  assert.equal(data.sessions[2],undefined);assert.equal(data.sessions[1].uploadToken,null);assert.equal(data.sessions[3].event,other.id);
  assert.equal(data.preferences[2].mediaAccess[album.id],undefined);assert.equal(data.preferences[2].mediaAccess[other.id],other.viewToken);assert.deepEqual(album.media,files);
});

test('regenerating enables fresh sharing without restoring old memberships or modifying media',()=>{
  const {album,data}=fixture(),original=photoLinks(album,'FictionalBot');
  changeAlbumAccess(data,1,album,{action:'disable',confirm:true,version:0});
  changeAlbumAccess(data,1,album,{action:'regenerate',confirm:true,version:1});
  const links=photoLinks(album,'FictionalBot');assert.ok(links.viewer && links.contributor);assert.notEqual(links.viewer,original.viewer);assert.notEqual(links.contributor,original.contributor);
  assert.equal(album.sharingDisabled,false);assert.equal(mediaRole(album,2,data.preferences[2]),null);assert.equal(album.media.length,1);
  const tokens=[album.viewToken,album.uploadToken];assert.throws(()=>changeAlbumAccess(data,1,album,{action:'regenerate',confirm:true,version:1}));assert.deepEqual([album.viewToken,album.uploadToken],tokens);
});

test('sharing changes enforce ownership, type, confirmation and current version',()=>{
  for(const overrides of [{id:2},{confirm:false},{version:99},{action:'unknown'}]){
    const {album,data}=fixture(),before=structuredClone(data),{id=1,...input}=overrides;
    assert.throws(()=>changeAlbumAccess(data,id,album,{action:'disable',confirm:true,version:0,...input}));assert.deepEqual(data,before);
  }
  const {album,data}=fixture();album.kind='event';assert.throws(()=>changeAlbumAccess(data,1,album,{action:'disable',confirm:true,version:0}));
});

test('Telegram danger actions require confirmation and old viewer/upload links stay invalid',async()=>{
  const {album,data}=fixture(),calls=[],old=photoLinks(album,'FictionalBot');
  const bot=new Bot({data},async(method,params)=>calls.push({method,...params}),'FictionalBot');
  const cb=(id,payload)=>bot.handle({callback_query:{from:{id},data:payload}});
  await cb(2,'album-disable:'+album.id);assert.equal(album.sharingDisabled,undefined);
  await cb(1,'album-disable:'+album.id);assert.equal(album.sharingDisabled,undefined);assert.match(calls.at(-1).text,/Only you/);
  await cb(1,'album-access-confirm:'+album.id+':disable:0');assert.equal(album.sharingDisabled,true);
  for(const link of [old.viewer,old.contributor]){await bot.handle({message:{from:{id:2},chat:{id:2,type:'private'},text:'/start '+new URL(link).searchParams.get('start')}});assert.match(calls.at(-1).text,/unavailable/);}
});
