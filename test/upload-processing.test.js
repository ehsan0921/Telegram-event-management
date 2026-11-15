import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/worker.js';
import {photoCollection} from '../src/permissions.js';

function fixture(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const file of ['0001_initial.sql','0002_delivery_lease.sql','0003_mini_app.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const f={db,receipts:[],failCommit:false,timeout:false};
  f.env={APP_ENV:'production',BOT_USERNAME:'FictionalBot',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args) || null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return db.prepare(sql).run(...this.args);},sql};},async batch(statements){if(f.onBatch)await f.onBatch();if(f.failCommit)throw Error('Fictional failed save');db.exec('BEGIN');try{for(const s of statements)db.prepare(s.sql).run(...s.args);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}}};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const params=JSON.parse(options.body);f.receipts.push(params);
    assert.match(params.text,/photos and files are being saved/);
    if(f.onReceipt)f.onReceipt();
    else assert.equal(db.prepare('SELECT count(*) AS n FROM lease').get().n,0);
    if(f.timeout)throw Error('Fictional network timeout');
    return Response.json({ok:true,result:{message_id:100+f.receipts.length,chat:{id:params.chat_id}}});
  });
  f.save=(kind,id,value)=>db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind,String(id),JSON.stringify(value));
  f.read=(kind,id)=>{const row=db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,String(id));return row?JSON.parse(row.data):null;};
  f.album=(user=1,batch='fictional-batch')=>{const e=photoCollection('Fictional album',user);f.save('events',e.id,e);f.save('sessions',user,{event:e.id,step:'upload',uploadBatch:batch});return e;};
  f.message=(update_id,text,extra={},id=1)=>processUpdate(f.env,{update_id,message:{chat:{id,type:'private'},from:{id,first_name:'Fictional uploader'},text,...extra}});
  f.photo=(update_id,id=1)=>f.message(update_id,undefined,{photo:[{file_id:'fictional-file-'+update_id}]},id);
  f.finish=(update_id,id=1)=>f.message(update_id,'✅ Finish uploads',{},id);
  f.messages=()=>db.prepare('SELECT method,params FROM outbox ORDER BY id').all().map(row=>({method:row.method,...JSON.parse(row.params)}));
  return f;
}

test('200 synthetic uploads with partial storage failure wait for retry and count only committed files',async t=>{
  const f=fixture(t),album=f.album();
  for(let i=1;i<=200;i++){
    f.failCommit=i===98;
    if(f.failCommit)await assert.rejects(f.photo(i),/Fictional failed save/);
    else assert.equal((await f.photo(i)).status,200);
  }
  assert.equal(f.read('events',album.id).media.length,199);
  assert.equal((await f.finish(201)).status,503);
  assert.equal(f.messages().length,0);assert.equal(f.receipts.length,1);
  assert.equal((await f.finish(202)).status,503);assert.equal(f.receipts.length,1);
  await f.message(203,'/new');await f.photo(204);
  assert.equal(f.read('sessions',1).step,'upload');
  assert.equal(f.read('events',album.id).media.length,199);
  assert.ok(f.messages().every(m=>!m.text.includes('Uploads finished')));
  await processUpdate(f.env,{update_id:205,callback_query:{id:'fictional-refresh',from:{id:1},data:'upload-status'}});
  assert.match(f.messages().at(-1).text,/199 of your files are currently saved/);
  await f.photo(98);await f.photo(98);
  assert.equal(f.read('events',album.id).media.length,200);
  assert.equal((await f.finish(201)).status,200);
  const completion=f.messages().filter(m=>m.text?.includes('Uploads finished'));
  assert.equal(completion.length,1);assert.match(completion[0].text,/200 saved in this upload/);
  assert.match(completion[0].text,/Only files received and saved are counted/);
  assert.ok(completion[0].reply_markup.inline_keyboard.flat().some(b=>b.text.includes('Add media')));
  await f.finish(202);assert.equal(f.messages().filter(m=>m.text?.includes('Uploads finished')).length,1);
});

test('receipt timeout and failed finish commit preserve the session, without duplicate receipts or early success',async t=>{
  const f=fixture(t);f.album();await f.photo(1);f.timeout=true;f.failCommit=true;
  await assert.rejects(f.finish(2),/Fictional failed save/);
  assert.equal(f.messages().length,0);assert.equal(f.read('sessions',1).step,'upload');
  assert.equal(f.read('upload_finish',1).closed,false);f.failCommit=false;
  await f.finish(2);await f.finish(2);await f.finish(3);
  assert.equal(f.receipts.length,1);assert.equal(f.read('sessions',1),null);
  assert.equal(f.messages().length,1);assert.equal(f.messages()[0].method,'sendMessage');
  assert.match(f.messages()[0].text,/1 saved in this upload/);
});

test('pending saves are isolated between uploaders and new batches, including the same album',async t=>{
  const f=fixture(t),album=f.album();f.album(2,'other-batch');
  f.failCommit=true;await assert.rejects(f.photo(1),/Fictional failed save/);f.failCommit=false;
  await f.photo(2,2);assert.equal((await f.finish(3,2)).status,200);
  assert.equal((await f.finish(4)).status,503);
  await f.photo(1);await f.finish(4);
  f.save('sessions',1,{event:album.id,step:'upload',uploadBatch:'new-batch'});
  await f.photo(5);await f.finish(6);
  const completion=f.messages().filter(m=>m.chat_id===1 && m.text?.includes('Uploads finished'));
  assert.equal(completion.length,2);assert.match(completion[1].text,/1 saved in this upload/);
  assert.match(completion[1].text,/2 of your files saved/);assert.equal(f.receipts.length,3);
});

test('Finish acknowledges while another upload holds the lease, then waits for its actual commit',async t=>{
  const f=fixture(t);f.album();
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  f.onBatch=async()=>{f.onBatch=null;entered();await gate;};
  const photo=f.photo(1);await started;
  f.onReceipt=()=>{
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lease').get().n,1);
    assert.equal(f.messages().length,0);release();
  };
  const finish=f.finish(2);
  assert.equal((await photo).status,200);assert.equal((await finish).status,200);
  assert.equal(f.receipts.length,1);assert.equal(f.messages().length,1);
  assert.match(f.messages()[0].text,/1 saved in this upload/);
});

test('completion reflects files still stored if media was removed during the batch',async t=>{
  const f=fixture(t),album=f.album();await f.photo(1);await f.photo(2);
  const stored=f.read('events',album.id);stored.media.pop();f.save('events',album.id,stored);
  await f.finish(3);assert.match(f.messages()[0].text,/1 saved in this upload/);
});
