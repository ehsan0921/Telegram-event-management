import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const definition=source.match(/^function loginRecoveryLink.*$/m)?.[0];
const recovery=new Function('return ('+definition+');')();
test('unauthenticated stale keyboard recovery preserves only validated album context, never login data',()=>{
 assert.equal(recovery('https://t.me/FictionalBot','0123456789abcdef'),'https://t.me/FictionalBot?start=albumapp_0123456789abcdef');
 assert.equal(recovery('https://t.me/FictionalBot',null),'https://t.me/FictionalBot?start=app');for(const input of ['../../private','0123456789abcdef&user=1','token=fictional'])assert.equal(recovery('https://t.me/FictionalBot',input),'https://t.me/FictionalBot?start=app');for(const bot of ['javascript:alert(1)','https://evil.test/FictionalBot','https://t.me/FictionalBot?token=bad','https://t.me/a/b'])assert.equal(recovery(bot,'0123456789abcdef'),null);
});
