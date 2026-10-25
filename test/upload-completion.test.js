import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/worker.js';

test('finish receipt precedes the state lease, while completion is committed with session removal and retry deduplication',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const file of ['0001_initial.sql','0002_delivery_lease.sql','0003_mini_app.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const save=db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?)');
  save.run('events','fictional-event',JSON.stringify({id:'fictional-event',title:'Fictional album',owner:1,guests:{},media:[{by:1,fileId:'fictional-file'}]}));
  save.run('sessions','1',JSON.stringify({event:'fictional-event',step:'upload',uploads:1}));
  let receipt=false,failCommit=false;
  const env={APP_ENV:'production',BOT_USERNAME:'FictionalBot',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){if(sql.startsWith('INSERT INTO lease'))assert.equal(receipt,true);return db.prepare(sql).get(...this.args) || null;},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return db.prepare(sql).run(...this.args);},sql};},async batch(statements){if(failCommit)throw Error('Fictional failed save');db.exec('BEGIN');try{for(const statement of statements)db.prepare(statement.sql).run(...statement.args);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}}};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const params=JSON.parse(options.body);
    assert.match(params.text,/Finish uploads received/);
    assert.equal(params.reply_markup.inline_keyboard[0][0].callback_data,'upload-status');
    assert.equal(db.prepare('SELECT count(*) AS n FROM lease').get().n,0);
    assert.ok(options.signal);receipt=true;return Response.json({ok:true,result:{message_id:101,chat:{id:1}}});
  });
  const update={update_id:123,message:{chat:{id:1,type:'private'},from:{id:1,first_name:'Fictional uploader'},text:'✅ Finish uploads'}};
  failCommit=true;
  await assert.rejects(processUpdate(env,update),/Fictional failed save/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='sessions'").get().n,1);
  failCommit=false;
  assert.equal((await processUpdate(env,update)).status,200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='sessions'").get().n,0);
  const messages=db.prepare('SELECT params FROM outbox ORDER BY id').all().map(row=>JSON.parse(row.params));
  assert.equal(messages.length,2);assert.ok(messages.every(message=>message.__uploadNotice));
  assert.match(messages[0].text,/1 saved/);
  assert.equal(messages[1].message_id,101);
  assert.equal(db.prepare('SELECT method FROM outbox ORDER BY id').all()[1].method,'editMessageText');
  await processUpdate(env,update);
  assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get().n,2);
});
