import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaDates} from '../src/media-preview.js';
import {photoCollection} from '../src/permissions.js';
import {Bot} from '../src/bot.js';

test('album dates use stored creation and latest known media activity without inventing legacy dates',()=>{
  const createdAt='2026-10-01T00:00:00.000Z';
  assert.deepEqual(mediaDates({createdAt,media:[]}),{createdAt,mediaUpdatedAt:createdAt});
  assert.deepEqual(mediaDates({media:[{at:'invalid'},{at:'2026-10-03T00:00:00Z'}]}),{createdAt:null,mediaUpdatedAt:'2026-10-03T00:00:00.000Z'});
  assert.deepEqual(mediaDates({media:[]}),{createdAt:null,mediaUpdatedAt:null});
  assert.equal(mediaDates({createdAt,mediaUpdatedAt:'2026-10-05T00:00:00Z',media:[{at:'2026-10-03T00:00:00Z'}]}).mediaUpdatedAt,'2026-10-05T00:00:00.000Z');
});

test('album updates track uploads, settings and removals, but not viewing',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T00:00:00Z')});
  const album=photoCollection('Fictional album',1),data={events:{[album.id]:album},sessions:{},preferences:{}};
  const bot=new Bot({data},async()=>({}),'FictionalBot');
  const cb=action=>bot.handle({callback_query:{from:{id:1},data:action+':'+album.id}});
  t.mock.timers.tick(60000);await cb('media-add');
  await bot.handle({message:{from:{id:1,first_name:'Alex'},chat:{id:1,type:'private'},photo:[{file_id:'fictional-file'}]}});
  const uploaded=album.mediaUpdatedAt;assert.equal(uploaded,'2026-10-01T00:01:00.000Z');
  t.mock.timers.tick(60000);await cb('v');assert.equal(album.mediaUpdatedAt,uploaded);
  await cb('photo-names');assert.equal(album.mediaUpdatedAt,'2026-10-01T00:02:00.000Z');
  const file=album.media[0].id;t.mock.timers.tick(60000);await bot.handle({callback_query:{from:{id:1},data:`remove:${album.id}:${file}`}});
  assert.equal(album.mediaUpdatedAt,'2026-10-01T00:03:00.000Z');assert.equal(album.createdAt,'2026-10-01T00:00:00.000Z');
});
