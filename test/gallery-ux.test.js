import test from 'node:test';
import assert from 'node:assert/strict';
import {setupGallery} from '../public/gallery.js';
import {readFileSync} from 'node:fs';
const productionAction=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').match(/^function action\(.*$/m)[0];

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('album page clears old settings and renders controls only after current gallery access succeeds',async t=>{
  const pending=deferred(),rendered=[];
  const f=galleryHarness(t,async path=>{if(path.includes('slow'))return pending.promise;if(path.includes('denied'))throw new Error('Access denied');return {title:'Example',media:[]};},(id,node)=>{rendered.push(id);node.append({textContent:'Settings'});node.hidden=false;});
  await f.openGallery('first');assert.equal(f.$('gallery-settings').hidden,false);
  const slow=f.openGallery('slow');assert.equal(f.$('gallery-settings').hidden,true);assert.equal(f.$('gallery-settings').children.length,0);
  await f.openGallery('denied');pending.resolve({title:'Old',media:[]});await slow;
  assert.deepEqual(rendered,['first']);assert.equal(f.$('gallery-settings').hidden,true);
});

test('full media preview shows uploader and caption and clears them for private attribution',async t=>{
  const file={id:'abcdef123456',type:'video',filename:'clip.mp4',name:'Fictional Alex',caption:'Example memories'};
  const f=galleryHarness(t,async()=>({title:'Fictional album',media:[file]}));
  await f.openGallery('0123456789abcdef');
  await f.button('Play video').onclick();
  assert.equal(f.$('media-uploader').textContent,'Uploaded by Fictional Alex');
  assert.equal(f.$('media-uploader').hidden,false);
  assert.equal(f.$('media-caption').textContent,file.caption);
  file.name=null;file.caption='';
  await f.openGallery('0123456789abcdef');await f.button('Play video').onclick();
  assert.equal(f.$('media-uploader').textContent,'');
  assert.equal(f.$('media-uploader').hidden,true);
  assert.equal(f.$('media-caption').textContent,'');
  assert.equal(f.$('media-caption').hidden,true);
});

test('gallery shows a direct sharing action and respects disabled QR codes',async t=>{
  let enabled=true;
  const f=galleryHarness(t,async path=>path.endsWith('gallery-qr')?{image:'data:image/gif;base64,R0lG',link:'https://t.me/fictional_bot?startapp=gallery_test'}:{title:'Club meetup',media:[],galleryUrl:'https://t.me/fictional_bot?startapp=gallery_test',qrEnabled:enabled});
  await f.openGallery('first');assert.equal(f.$('gallery-copy').hidden,false);assert.equal(f.$('gallery-qr').hidden,false);
  await f.$('gallery-qr').onclick();assert.equal(f.$('qr-title').textContent,'Shared media QR code');
  f.dismissPendingMedia();enabled=false;await f.openGallery('second');assert.equal(f.$('gallery-qr').hidden,true);assert.equal(f.$('gallery-copy').hidden,false);
});
function galleryHarness(t,api=async()=>({title:'Club meetup',media:[],canUpload:false}),renderAlbumDetails){
  class Node{
    constructor(tag='div',text=''){this.tagName=tag.toUpperCase();this.textContent=text;this.children=[];this.attributes={};this.isConnected=true;this.open=false;this.opens=0;this.pauses=0;this.loads=0;}
    append(...children){for(const child of children)child.parent=this;this.children.push(...children);}
    prepend(...children){this.children.unshift(...children);}
    replaceChildren(...children){for(const child of this.children)child.isConnected=false;this.children=children;}
    setAttribute(key,value){this.attributes[key]=value;}
    removeAttribute(key){delete this.attributes[key];delete this[key];}
    remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    insertBefore(child,before){child.parent=this;this.children.splice(this.children.indexOf(before),0,child);}
    showModal(){this.open=true;this.opens++;}
    close(){this.open=false;this.onclose?.();}
    pause(){this.pauses++;}
    load(){this.loads++;}
    click(){this.clicks=(this.clicks || 0)+1;}
  }
  const globals={document:globalThis.document,IntersectionObserver:globalThis.IntersectionObserver,fetch:globalThis.fetch};
  t.after(()=>{for(const [name,value] of Object.entries(globals)){if(value===undefined)delete globalThis[name];else globalThis[name]=value;}});
  globalThis.document={body:new Node('body'),createElement:tag=>new Node(tag)};
  const observers=[];
  globalThis.IntersectionObserver=class{
    constructor(callback){this.callback=callback;observers.push(this);}
    observe(node){this.node=node;}
    disconnect(){}
    intersect(){return this.callback([{isIntersecting:true,target:this.node}]);}
  };
  const fetches=[],calls=[],notices=[],routes=[],nodes=new Map();
  let fetchResult=()=>Promise.resolve(new Response(new Blob(['fictional media'],{type:'video/mp4'})));
  globalThis.fetch=(...args)=>{fetches.push(args);return fetchResult(...args);};
  const $=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
  const element=(tag,text='',className='')=>Object.assign(new Node(tag,text),{className});
  const action=new Function('element','notice','return ('+productionAction+');')(element,message=>notices.push(message));
  const controls=setupGallery({$,api:(...args)=>{calls.push(args);return api(...args);},element,action,go:route=>routes.push(route),notice:message=>notices.push(message),openTelegram(){},initData:'fictional-init-data',renderAlbumDetails});
  const descendants=node=>[node,...node.children.flatMap(descendants)];
  return {$,calls,notices,routes,fetches,observers,...controls,setFetch(fn){fetchResult=fn;},all:()=>[...nodes.values(),document.body].flatMap(descendants),button:text=>descendants($('gallery-list')).find(node=>node.tagName==='BUTTON' && node.textContent===text)};
}

test('opening another gallery clears the previous event upload action while loading and after failure',async()=>{
  const nodes=new Map();
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,onclick:null,children:[],replaceChildren(...children){this.children=children;}});
    return nodes.get(id);
  };
  let rejectSecond;
  const second=new Promise((resolve,reject)=>{rejectSecond=reject;});
  const opened=[];
  const {openGallery}=setupGallery({$,api:path=>path==='events/first/gallery' ? Promise.resolve({title:'First event',media:[],canUpload:true,uploadUrl:'https://t.me/test?start=upload_first'}) : second,element:(tag,text)=>({tag,text}),action(){},go(){},notice(){},openTelegram:url=>opened.push(url),initData:'test'});

  await openGallery('first');
  assert.equal($('gallery-title').textContent,'First event');
  assert.equal($('gallery-upload').hidden,false);
  $('gallery-upload').onclick();
  assert.deepEqual(opened,['https://t.me/test?start=upload_first']);

  const loading=openGallery('second');
  assert.equal($('gallery-upload').hidden,true);
  assert.equal($('gallery-upload').onclick,null);
  assert.equal($('gallery-title').textContent,'Shared media');
  assert.equal($('gallery-summary').textContent,'Loading files…');

  rejectSecond(new Error('Gallery unavailable.'));
  await loading;
  assert.equal($('gallery-upload').hidden,true);
  assert.equal($('gallery-upload').onclick,null);
  assert.equal($('gallery-summary').textContent,'');
  assert.equal($('gallery-error').hidden,false);
  assert.equal($('gallery-error').textContent,'Gallery unavailable.');
});

test('closing the page ignores a late gallery response and leaves its upload action disabled',async t=>{
  const pending=deferred(),f=galleryHarness(t,()=>pending.promise);
  const loading=f.openGallery('first');
  f.dismissPendingMedia();
  pending.resolve({title:'Late private event',media:[],canUpload:true,uploadUrl:'https://t.me/fictional_bot?start=late'});
  await loading;
  assert.equal(f.$('gallery-title').textContent,'Shared media');
  assert.equal(f.$('gallery-upload').hidden,true);assert.equal(f.$('gallery-upload').onclick,null);
  assert.equal(f.$('photo-dialog').opens,0);assert.equal(f.$('qr-dialog').opens,0);
  assert.deepEqual(f.routes,['gallery']);assert.deepEqual(f.notices,[]);
});

test('closing the page cancels a pending QR popup while a later explicit request still opens',async t=>{
  const pending=deferred(),qr={image:'data:image/gif;base64,R0lG',link:'https://t.me/fictional_bot?start=upload',anyone:false};
  const f=galleryHarness(t,path=>path.includes('/first/')?pending.promise:Promise.resolve(qr));
  const loading=f.showQr('first');f.dismissPendingMedia();pending.resolve(qr);await loading;
  assert.equal(f.$('qr-dialog').opens,0);assert.equal(f.$('qr-dialog').open,false);
  await f.showQr('second');assert.equal(f.$('qr-dialog').opens,1);assert.equal(f.$('qr-dialog').open,true);
  f.dismissPendingMedia();assert.equal(f.$('qr-dialog').open,false);
  assert.ok(f.calls.every(([,body])=>body===undefined),'Closing a QR popup must not write anything.');
});

test('a delayed video preview cannot reopen after leaving and closing a playing preview stops video',async t=>{
  const video={id:'111111111111',type:'video',filename:'club-video.mp4',name:'Fictional guest',hasThumbnail:false};
  const f=galleryHarness(t,async()=>({title:'Club meetup',media:[video],canUpload:false}));
  await f.openGallery('first');
  const pending=deferred();f.setFetch(()=>pending.promise);
  const loading=f.button('Play video').onclick();
  f.dismissPendingMedia();pending.resolve(new Response(new Blob(['fictional video'],{type:'video/mp4'})));await loading;
  assert.equal(f.$('photo-dialog').opens,0);
  await f.openGallery('second');
  f.setFetch(()=>Promise.resolve(new Response(new Blob(['fictional video'],{type:'video/mp4'}))));
  await f.button('Play video').onclick();
  assert.equal(f.$('photo-dialog').open,true);assert.ok(f.$('video-full').src);
  f.dismissPendingMedia();
  assert.equal(f.$('photo-dialog').open,false);assert.equal(f.$('video-full').src,undefined);
  assert.equal(f.$('video-full').pauses,1);assert.equal(f.$('video-full').loads,1);
  assert.ok(f.calls.every(([,body])=>body===undefined),'Closing a preview must not send or change event files.');
});

test('closing a photo popup suppresses an older pending preview without blocking a new click',async t=>{
  const photo={id:'222222222222',type:'photo',filename:'club-photo.jpg',name:'Fictional guest',hasThumbnail:true};
  const f=galleryHarness(t,async()=>({title:'Club meetup',media:[photo],canUpload:false}));
  await f.openGallery('first');await f.observers[0].intersect();
  const image=f.observers[0].node.children.find(node=>node.tagName==='IMG');
  await image.onclick();assert.equal(f.$('photo-dialog').opens,1);
  const pending=deferred();f.setFetch(()=>pending.promise);
  const loading=image.onclick();f.$('photo-close').onclick();
  pending.resolve(new Response(new Blob(['fictional photo'],{type:'image/jpeg'})));await loading;
  assert.equal(f.$('photo-dialog').opens,1);assert.equal(f.$('photo-dialog').open,false);
  f.setFetch(()=>Promise.resolve(new Response(new Blob(['fictional photo'],{type:'image/jpeg'}))));
  await image.onclick();assert.equal(f.$('photo-dialog').opens,2);assert.equal(f.$('photo-dialog').open,true);
  f.dismissPendingMedia();
});

test('previews show loading, recover from fetch and decode failures, and keep file actions available',async t=>{
  const f=galleryHarness(t,async()=>({title:'Fictional album',media:[{id:'111111111111',type:'photo',filename:'photo',at:'2026-10-26T01:00:00Z'}]}));
  await f.openGallery('first');
  const card=f.$('gallery-list').children[0],status=card.children[0],image=card.children.find(node=>node.tagName==='IMG');
  assert.equal(status.attributes.role,'status');assert.match(status.children[1].textContent,/Loading/);assert.equal(image.hidden,true);
  f.setFetch(async()=>{throw Error('Fictional fetch failure');});
  await f.observers[0].intersect();
  const refresh=f.button('↻ Refresh preview');assert.equal(refresh.hidden,false);assert.equal(refresh.disabled,false);
  assert.equal(f.button('Download'),undefined);assert.ok(f.button('Send to Telegram'));
  f.setFetch(async()=>new Response(new Blob(['fictional image'],{type:'image/jpeg'})));
  await refresh.onclick();assert.equal(refresh.disabled,false);assert.equal(status.children[0].hidden,false);
  image.onerror();assert.equal(refresh.hidden,false);
  await refresh.onclick();image.onload();assert.equal(status.hidden,true);assert.equal(image.hidden,false);
});

test('gallery defaults to the newest media first',async t=>{
  const f=galleryHarness(t,async()=>({title:'Fictional album',media:[{id:'old',type:'document',filename:'Old',at:'2026-10-01T00:00:00Z'},{id:'new',type:'document',filename:'New',at:'2026-10-26T00:00:00Z'}]}));
  await f.openGallery('first');
  assert.deepEqual(f.$('gallery-list').children.map(card=>card.children[0].children[0].textContent),['New','Old']);
});

test('visible previews use at most three concurrent downloads and duplicate requests share one fetch',async t=>{
  const files=Array.from({length:8},(_,index)=>({id:String(index),type:'photo',filename:'photo'}));
  const f=galleryHarness(t,async()=>({title:'Fictional album',media:files})),gate=deferred();
  let active=0,maximum=0;
  f.setFetch(async()=>{active++;maximum=Math.max(maximum,active);await gate.promise;active--;return new Response(new Blob(['fictional'],{type:'image/jpeg'}));});
  await f.openGallery('fictional');
  const previews=f.observers.map(observer=>observer.intersect());
  assert.equal(f.fetches.length,3);gate.resolve();await Promise.all(previews);
  assert.equal(maximum,3);assert.equal(f.fetches.length,8);
});

test('Send to Telegram disables repeated presses and reports queueing rather than delivery',async t=>{
  const send=deferred(),file={id:'fictional',type:'document',filename:'example.pdf'};
  const f=galleryHarness(t,path=>path.endsWith('/send')?send.promise:Promise.resolve({title:'Fictional album',media:[file]}));
  await f.openGallery('fictional');const button=f.button('Send to Telegram');
  const first=button.onclick();await button.onclick();assert.equal(button.disabled,true);
  assert.equal(f.calls.filter(([path])=>path.endsWith('/send')).length,1);assert.equal(f.notices.length,0);
  send.resolve({queued:true});await first;assert.equal(button.disabled,false);
  assert.match(f.notices[0],/Queued/);assert.doesNotMatch(f.notices[0],/sent/);
});





test('Mini App has no Download/Save controls and sent appears once only after a confirmed receipt',async t=>{
  const check=deferred(),file={id:'fictional',type:'document',filename:'example.pdf'};
  const f=galleryHarness(t,path=>path.endsWith('/send')?Promise.resolve({queued:true,status:'queued',request:'a'.repeat(16)}):path.includes('/delivery-status?')?check.promise:Promise.resolve({title:'Fictional',media:[file]}));
  await f.openGallery('fictional');assert.equal(f.button('Download'),undefined);
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/id="(?:media-save|qr-download)"/);
  const button=f.button('Send to Telegram'),sending=button.onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(!f.notices.includes('sent'));assert.equal(button.disabled,true);check.resolve({status:'sent'});await sending;
  assert.equal(f.notices.filter(text=>text==='sent').length,1);assert.equal(f.calls.filter(([path])=>path.endsWith('/send')).length,1);
});
test('status polling is bounded, serial, read-only and never retries Send automatically',async t=>{
  const delays=[];t.mock.method(globalThis,'setTimeout',(callback,ms)=>{delays.push(ms);queueMicrotask(callback);return 0;});
  const f=galleryHarness(t,async path=>path.endsWith('/send')?{queued:true,status:'queued',request:'a'.repeat(16)}:path.includes('/delivery-status?')?{status:'queued'}:{title:'Fictional',media:[{id:'fictional',type:'document',filename:'example.pdf'}]});
  await f.openGallery('fictional');await f.button('Send to Telegram').onclick();
  assert.equal(f.calls.filter(([path])=>path.endsWith('/send')).length,1);assert.equal(f.calls.filter(([path])=>path.includes('/delivery-status?')).length,20);
  assert.equal(delays.length,19);assert.ok(delays.every(ms=>ms===2000));assert.ok(!f.notices.includes('sent'));assert.match(f.notices.at(-1),/not confirmed/);
});
for(const status of ['partial','unconfirmed','failed','cancelled'])test(`Mini App reports ${status} without a sent notice or automatic resend`,async t=>{
  const f=galleryHarness(t,async path=>path.endsWith('/send')?{status,request:'a'.repeat(16)}:{title:'Fictional',media:[{id:'fictional',type:'document',filename:'example.pdf'}]});
  await f.openGallery('fictional');await f.button('Send to Telegram').onclick();
  assert.ok(!f.notices.includes('sent'));assert.equal(f.calls.filter(([path])=>path.endsWith('/send')).length,1);assert.equal(f.calls.filter(([path])=>path.includes('/delivery-status?')).length,0);
});

test('photo heart updates only after confirmation; repeated taps do not duplicate and count is noninteractive',async t=>{
 const pending=deferred(),file={id:'111111111111',type:'photo',filename:'photo',canLike:true,likeCount:2,liked:false,canLink:false};
 const f=galleryHarness(t,async(path)=>{if(path.endsWith('/likes'))return pending.promise;return {title:'Fictional album',socialFeatures:true,media:[file]};});
 await f.openGallery('0123456789abcdef');const like=f.all().find(n=>n.tagName==='BUTTON' && n.attributes['aria-label']==='Like photo');assert.equal(like.textContent,'\u2661');assert.equal(like.type,'button');assert.equal(like.attributes['aria-pressed'],'false');const clicked=like.onclick();assert.equal(like.disabled,true);assert.equal(like.attributes['aria-pressed'],'false');await like.onclick();assert.equal(f.calls.filter(([path])=>path.endsWith('/likes')).length,1);
 pending.resolve({liked:true,count:3});await clicked;assert.equal(like.attributes['aria-pressed'],'true');assert.equal(like.disabled,false);assert.equal(like.textContent,'\u2665');assert.equal(like.attributes['aria-label'],'Unlike photo');const count=f.all().find(n=>n.tagName==='SPAN' && n.textContent==='3 likes');assert.ok(count);assert.equal(count.onclick,undefined);assert.equal(count.attributes.tabindex,undefined);assert.ok(!f.calls.some(([path])=>path.includes('/likes?')));f.dismissPendingMedia();assert.equal(document.body.children.length,0);
});

test('heart errors preserve confirmed count and state, and unlike reveals no identities',async t=>{
 let denied=true;const f=galleryHarness(t,async(path,input)=>{if(path.endsWith('/likes')){assert.equal(input.liked,false);if(denied)throw Error('Fictional update denied');return {liked:false,count:9};}return {title:'Fictional',socialFeatures:true,media:[{id:'111111111111',type:'photo',filename:'photo',canLike:true,canLink:false,liked:true,likeCount:10}]};});await f.openGallery('0123456789abcdef');const heart=f.all().find(n=>n.attributes['aria-label']==='Unlike photo');await heart.onclick();assert.equal(heart.textContent,'\u2665');assert.equal(heart.attributes['aria-pressed'],'true');assert.ok(f.all().some(n=>n.tagName==='SPAN' && n.textContent==='10 likes'));assert.ok(f.notices.includes('Fictional update denied'));denied=false;await heart.onclick();assert.equal(heart.textContent,'\u2661');assert.equal(heart.attributes['aria-pressed'],'false');assert.ok(f.all().some(n=>n.tagName==='SPAN' && n.textContent==='9 likes'));assert.equal(document.body.children.length,0);
});

test('personal-album controls disable unauthorized imports and expose removable unavailable references only to owners',async t=>{
 const f=galleryHarness(t,async()=>({title:'Fictional',socialFeatures:true,isOwner:true,canRemove:true,mediaVersion:2,unavailable:[{id:'222222222222'}],media:[{id:'111111111111',type:'photo',filename:'photo',canLike:true,canLink:false}]}));await f.openGallery('0123456789abcdef');
 const add=f.all().find(n=>n.tagName==='BUTTON' && n.textContent==='Add to personal album');assert.equal(add.disabled,true);assert.ok(f.all().some(n=>n.textContent==='Remove unavailable link'));await f.button('Remove from album').onclick();assert.equal(f.calls.length,1);
 const create=f.all().find(n=>n.tagName==='BUTTON' && n.textContent.endsWith('New personal album'));await create.onclick();assert.ok(f.all().some(n=>n.textContent==='Create private album'));assert.ok(document.body.children.some(n=>n.open));f.dismissPendingMedia();assert.equal(document.body.children.length,0);
});
