import test from 'node:test';
import assert from 'node:assert/strict';
import {albumMembers} from '../src/album-members.js';
import {photoCollection} from '../src/permissions.js';
import {Bot} from '../src/bot.js';

test('album access list includes current grants only and returns names and roles without private data',()=>{
  const album=photoCollection('Fictional memories',1),preferences={
    1:{mediaAccess:{[album.id]:album.uploadToken}},
    2:{mediaAccess:{[album.id]:album.viewToken},profilePhone:'fictional-private-phone'},
    3:{mediaAccess:{[album.id]:album.uploadToken}},
    4:{mediaAccess:{[album.id]:'revoked-token'}},5:{mediaAccess:{other:album.uploadToken}}
  };
  const users={2:{firstName:'Fictional',lastName:'Viewer',id:2,username:'fictional-private-handle'},3:{firstName:'Fictional contributor',id:3}};
  assert.deepEqual(albumMembers(album,preferences,users),[{name:'Fictional contributor',role:'contributor'},{name:'Fictional Viewer',role:'viewer'}]);
  album.allowLinkUploads=false;
  assert.deepEqual(albumMembers(album,preferences,users),[{name:'Fictional Viewer',role:'viewer'}]);
  album.cancelled=true;assert.deepEqual(albumMembers(album,preferences,users),[]);
});

test('Telegram album access list is available only to its owner and handles empty lists',async()=>{
  const album=photoCollection('Fictional memories',1),calls=[];
  const data={events:{[album.id]:album},sessions:{},preferences:{2:{mediaAccess:{[album.id]:album.viewToken}}},users:{2:{firstName:'Fictional viewer'}}};
  const bot=new Bot({data},async(method,params)=>{calls.push({method,...params});},'FictionalBot');
  const cb=(id)=>bot.handle({callback_query:{from:{id},data:'album-members:'+album.id}});
  await cb(2);assert.match(calls.at(-1).text,/Only the album owner/);assert.doesNotMatch(calls.at(-1).text,/Fictional viewer/);
  await cb(1);assert.match(calls.at(-1).text,/Viewers \(1\)\n• Fictional viewer/);assert.match(calls.at(-1).text,/Contributors \(0\)\nNone yet/);
  delete data.preferences[2];await cb(1);assert.match(calls.at(-1).text,/Viewers \(0\)\nNone yet/);
});
