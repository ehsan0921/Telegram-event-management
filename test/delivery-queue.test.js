import test from 'node:test';
import assert from 'node:assert/strict';
import {drainOutbox} from '../src/worker.js';
import {DatabaseSync} from 'node:sqlite';

test('normal delivery drains beyond one batch so messages do not wait for the next cron',async t=>{
  const rows=Array.from({length:25},(_,i)=>({id:'fictional-'+i,due:0,attempts:1,method:'sendMessage',params:JSON.stringify({chat_id:1,text:'Fictional notice '+i})}));
  const sent=[];
  const env={APP_ENV:'production',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {bind(...args){this.args=args;return this;},async first(){if(sql.startsWith('INSERT INTO delivery_lease'))return {owner:'fixture'};if(sql.startsWith('UPDATE outbox SET due=unixepoch()+60'))return rows.find(r=>r.id===this.args[0]);throw Error('Unexpected query');},async all(){return {results:rows.slice(0,20)};},async run(){if(sql==='DELETE FROM outbox WHERE id=?')rows.splice(rows.findIndex(r=>r.id===this.args[0]),1);else assert.equal(sql,'DELETE FROM delivery_lease WHERE owner=?');}};}}};
  t.mock.method(globalThis,'fetch',async(_url,options)=>{sent.push(JSON.parse(options.body).text);return Response.json({ok:true});});
  await drainOutbox(env);assert.equal(sent.length,25);assert.equal(rows.length,0);assert.equal(new Set(sent).size,25);
});

test('upload confirmations bypass delayed retries and routine messages without leaking delivery metadata',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE delivery_lease(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER); CREATE TABLE outbox(id TEXT PRIMARY KEY,method TEXT,params TEXT,due INTEGER DEFAULT 0,attempts INTEGER DEFAULT 0);');
  const insert=db.prepare('INSERT INTO outbox(id,method,params,due) VALUES (?,\'sendMessage\',?,?)');
  insert.run('delayed',JSON.stringify({chat_id:1,text:'Delayed'}),Math.floor(Date.now()/1000)+3600);
  insert.run('routine',JSON.stringify({chat_id:2,text:'Routine'}),0);
  insert.run('upload',JSON.stringify({chat_id:3,text:'Uploads saved',__uploadNotice:true}),0);
  const env={APP_ENV:'production',TELEGRAM_BOT_TOKEN:'fictional-token',DB:{prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async first(){return db.prepare(sql).get(...this.args);},async all(){return {results:db.prepare(sql).all(...this.args)};},async run(){return db.prepare(sql).run(...this.args);}};}}};
  const sent=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{const params=JSON.parse(options.body);assert.equal('__uploadNotice' in params,false);sent.push(params.text);return Response.json({ok:true});});
  await drainOutbox(env);
  assert.deepEqual(sent,['Uploads saved','Routine']);
  assert.deepEqual(db.prepare('SELECT id FROM outbox').all().map(row=>row.id),['delayed']);
});
