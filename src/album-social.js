import {cohostEntries} from './cohosts.js';
import {rememberUser} from './admin.js';
import {randomBytes} from 'node:crypto';
import {mutateState,BusyError} from './worker-store.js';
import {TestAccessError} from './test-access.js';
import {mediaRole,mediaCan,mediaRevoked} from './permissions.js';
import {mediaPreview} from './media-preview.js';
import {canViewMedia,resolveMedia,mayLinkMedia,readMediaGraph} from './media-reference.js';
import {notifyMediaFollowers} from './media-delivery.js';

class MediaError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const fail=(message,status=400)=>{throw new MediaError(message,status);};
const own=(event,id)=>{if(!event || event.owner!==id || event.cancelled)fail('Only the album creator can manage this media.',403);};
const likeKey=file=>file.canonicalEvent+':'+file.canonicalMedia;
const parse=async request=>{const raw=await request.text();if(raw.length>12000)fail('Too much text.',413);let input;try{input=JSON.parse(raw);}catch{fail('Invalid request.');}if(!input || typeof input!=='object' || Array.isArray(input))fail('Invalid request.');return input;};
function stopAccess(data,album,id){
 const pref=data.preferences[id];if(pref?.mediaAccess)delete pref.mediaAccess[album.id];
 const state=pref?.mediaDelivery?.[album.id];
 if(state){state.cancelled ||= {};for(const [mid,token] of Object.entries(state.pending || {}))if(state.uncertain?.[mid]!==token)state.cancelled[mid]=token;}
 if(data.sessions[id]?.event===album.id && (album.kind==='photos' || ['media','upload'].includes(data.sessions[id].step)))delete data.sessions[id];
}
export async function readLikes(env,key,id){
 const row=await env.DB.prepare("SELECT data FROM records WHERE kind='media_likes' AND id=?").bind(key).first();
 const users=row?JSON.parse(row.data).users || {}:{};
 return {users,count:Object.keys(users).length,liked:!!users[String(id)]};
}
export async function galleryLikes(env,files,id){
 const keys=[...new Set(files.filter(file=>mediaPreview(file)==='photo').map(likeKey))];
 if(!keys.length)return new Map();
 const {results}=await env.DB.prepare("SELECT id,data FROM records WHERE kind='media_likes' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys)).all();
 return new Map(results.map(row=>{const users=JSON.parse(row.data).users || {};return [row.id,{likeCount:Object.keys(users).length,liked:!!users[String(id)]}];}));
}
export const likeIdentity=likeKey;

async function managedMembers(env,event){
 const {results}=await env.DB.prepare("SELECT id,data FROM records WHERE kind='preferences' AND json_extract(data,?) IS NOT NULL").bind(`$.mediaAccess."${event.id}"`).all();
 const prefs=Object.fromEntries(results.map(row=>[row.id,JSON.parse(row.data)]));
 const ids=[...new Set([...Object.keys(prefs),...Object.keys(event.guests || {}),...Object.keys(event.mediaRevokedUsers || {}),...cohostEntries(event).filter(entry=>entry.status==='active' && entry.cohost).map(entry=>String(entry.cohost.id))])].filter(value=>/^[1-9]\d*$/.test(value) && Number(value)!==event.owner);
 const profiles=await env.DB.prepare("SELECT id,data FROM records WHERE kind='users' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all(),names=new Map(profiles.results.map(row=>{const u=JSON.parse(row.data);return [row.id,[u.firstName,u.lastName].filter(Boolean).join(' ')];}));
 return ids.map(uid=>({id:Number(uid),name:names.get(uid) || event.guests?.[uid]?.name || 'Telegram user',blocked:mediaRevoked(event,Number(uid)),role:mediaRole(event,Number(uid),prefs[uid]) || (event.kind!=='photos' && event.guests?.[uid] && canViewMedia({preferences:prefs},event,Number(uid))?'guest':null)})).filter(person=>person.blocked || person.role).sort((a,b)=>a.name.localeCompare(b.name));
}

export async function albumSocialApi(request,env,user){
 const url=new URL(request.url),path=url.pathname,id=user.id;
 const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 const likes=path.match(/^\/api\/events\/([a-f0-9]{16})\/media\/([a-f0-9]{12})\/likes$/),manage=path.match(/^\/api\/albums\/([a-f0-9]{16})\/(manage|members|reshare|references|remove)$/);
 if(!likes && !manage && path!=='/api/albums/owned')return null;
 if(env.ALBUM_SOCIAL_ENABLED==='false' && request.method!=='GET')return response({error:'Album changes are temporarily paused. Your media and access settings are preserved.'},503);
 try{
  if(path==='/api/albums/owned'){
   if(request.method!=='GET')return response({error:'Not found.'},404);
   const rows=await env.DB.prepare("SELECT data FROM records WHERE kind='events' AND json_extract(data,'$.owner')=? AND json_extract(data,'$.kind')='photos'").bind(id).all();
   return response({albums:rows.results.map(row=>JSON.parse(row.data)).filter(e=>!e.cancelled).map(e=>({id:e.id,title:e.title,private:e.sharingDisabled===true}))});
  }
  const eid=(likes || manage)[1],row=await env.DB.prepare("SELECT data FROM records WHERE kind='events' AND id=?").bind(eid).first(),event=row && JSON.parse(row.data);
  if(likes){
   const prefRow=await env.DB.prepare("SELECT data FROM records WHERE kind='preferences' AND id=?").bind(String(id)).first(),pref=prefRow?JSON.parse(prefRow.data):{};
   if(!event)fail('This photo is unavailable.',403);
   const data=await readMediaGraph(env,event,id,pref),file=resolveMedia(data,event,event.media?.find(f=>f.id===likes[2]),id);
   if(!file || mediaPreview(file)!=='photo')fail('This photo is unavailable.',403);
   if(request.method==='GET'){
    const offset=Number(url.searchParams.get('offset') || 0);if(!Number.isSafeInteger(offset) || offset<0 || offset>100000)fail('Invalid page.');
    const state=await readLikes(env,likeKey(file),id);
    return response({count:state.count,liked:state.liked});
   }
   if(request.method!=='POST')return response({error:'Not found.'},404);
   const input=await parse(request);if(typeof input.liked!=='boolean')fail('Choose Like or Unlike.');
   await rememberUser(env,user);
   const result=await mutateState(env,async(data,_bot,{persist})=>{
    const e=data.events[eid],file=resolveMedia(data,e,e?.media?.find(f=>f.id===likes[2]),id);
    if(!file || mediaPreview(file)!=='photo')fail('This photo is unavailable.',403);
    const state=await readLikes(env,likeKey(file),id),users=state.users;
    if(input.liked)users[String(id)] ||= new Date().toISOString();else delete users[String(id)];
    persist("INSERT INTO records(kind,id,data) VALUES ('media_likes',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",likeKey(file),JSON.stringify({users}));
    return {count:Object.keys(users).length,liked:!!users[String(id)]};
   });
   return response(result);
  }
  own(event,id);
  if(manage[2]==='manage' && request.method==='GET')return response({id:event.id,allowMediaReshare:event.allowMediaReshare===true,shareVersion:event.mediaReshareVersion || 0,memberVersion:event.mediaMemberVersion || 0,mediaVersion:event.mediaEditVersion || 0,members:await managedMembers(env,event)});
  if(request.method!=='POST')return response({error:'Not found.'},404);
  const input=await parse(request),operation=manage[2];
  const result=await mutateState(env,async(data,bot,{persist})=>{
   const album=data.events[eid];own(album,id);
   if(operation==='members'){
    if(input.confirm!==true || !Number.isSafeInteger(input.userId) || input.userId<=0 || input.userId===id || typeof input.blocked!=='boolean')fail('Confirm the selected user access change.');
    if(input.version!==(album.mediaMemberVersion || 0))fail('The access list changed. Refresh and confirm again.',409);
    album.mediaRevokedUsers ||= {};if(input.blocked)album.mediaRevokedUsers[String(input.userId)]={at:new Date().toISOString()};else delete album.mediaRevokedUsers[String(input.userId)];
    if(input.blocked)stopAccess(data,album,input.userId);
    album.mediaMemberVersion=(album.mediaMemberVersion || 0)+1;return {saved:true,version:album.mediaMemberVersion};
   }
   if(operation==='reshare'){
    if(input.confirm!==true || typeof input.allowed!=='boolean')fail('Confirm the linking permission change.');
    if(input.version!==(album.mediaReshareVersion || 0))fail('Linking permissions changed. Refresh and confirm again.',409);
    if(album.allowMediaReshare!==input.allowed){album.allowMediaReshare=input.allowed;album.mediaReshareVersion=(album.mediaReshareVersion || 0)+1;}
    return {saved:true,allowed:album.allowMediaReshare===true,version:album.mediaReshareVersion || 0};
   }
   if(album.kind!=='photos')fail('Use a personal media album for linked items.');
   if(operation==='references'){
    if(!/^[a-f0-9-]{36}$/.test(input.requestId || '') || !/^[a-f0-9]{16}$/.test(input.sourceEvent || '') || !Array.isArray(input.mediaIds) || !input.mediaIds.length || input.mediaIds.length>50 || input.mediaIds.some(mid=>!/^[a-f0-9]{12}$/.test(mid)))fail('Choose valid source media and refresh before adding.');
    if(input.sourceEvent===eid)fail('This media is already in this album.');
    const mids=[...new Set(input.mediaIds)],signature=JSON.stringify([eid,input.sourceEvent,mids]),key=id+':'+input.requestId,prior=await env.DB.prepare("SELECT data FROM records WHERE kind='media_import' AND id=?").bind(key).first();
    if(prior){const saved=JSON.parse(prior.data);if(saved.signature!==signature)fail('That request was already used. Refresh and try again.',409);return {saved:true,alreadyHandled:true,ids:saved.ids.filter(mid=>album.media.some(file=>file.id===mid))};}
    const source=data.events[input.sourceEvent];
    const originals=mids.map(mid=>{const file=source?.media?.find(f=>f.id===mid);if(!mayLinkMedia(data,source,file,id))fail('The source owner has not allowed linking this media, or your access changed.',403);return file;});
    const ids=[];let added=0;
    for(const original of originals){
     const existing=album.media.find(file=>file.reference?.event===source.id && file.reference.media===original.id);if(existing){ids.push(existing.id);continue;}
     const linked={id:randomBytes(6).toString('hex'),type:original.type,at:new Date().toISOString(),reference:{event:source.id,media:original.id,accessVersion:source.albumAccessVersion || 0,policyVersion:source.mediaReshareVersion || 0}};
     album.media.push(linked);ids.push(linked.id);added++;await notifyMediaFollowers(bot,album,{...linked,by:id});
    }
    if(added){album.mediaUpdatedAt=new Date().toISOString();album.mediaEditVersion=(album.mediaEditVersion || 0)+1;}
    persist("INSERT INTO records(kind,id,data) VALUES ('media_import',?,?)",key,JSON.stringify({signature,ids}));
    return {saved:true,added,ids};
   }
   if(operation==='remove'){
    if(input.confirm!==true || !/^[a-f0-9]{12}$/.test(input.mediaId || ''))fail('Confirm the media item to remove.');
    if(input.version!==(album.mediaEditVersion || 0))fail('The album changed. Refresh and confirm again.',409);
    const file=album.media.find(file=>file.id===input.mediaId);if(!file)return {saved:true};
    album.media=album.media.filter(file=>file.id!==input.mediaId);album.mediaEditVersion=(album.mediaEditVersion || 0)+1;album.mediaUpdatedAt=new Date().toISOString();
    for(const pref of Object.values(data.preferences)){const state=pref.mediaDelivery?.[eid],token=state?.pending?.[file.id];if(token && state.uncertain?.[file.id]!==token){state.cancelled ||= {};state.cancelled[file.id]=token;}}
    return {saved:true,version:album.mediaEditVersion};
   }
   fail('Not found.',404);
  });
  return response(result);
 }catch(error){if(error instanceof TestAccessError)throw error;return response({error:error instanceof MediaError || error instanceof BusyError?error.message:'Could not update media. Refresh and try again.'},error instanceof BusyError?503:error.status || 400);}
}
