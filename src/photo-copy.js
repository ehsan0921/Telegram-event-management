import {randomBytes} from 'node:crypto';
import {resolveMedia} from './media-reference.js';
import {mediaPreview} from './media-preview.js';
import {showsUploaders} from './permissions.js';
import {notifyMediaFollowers} from './media-delivery.js';

// Called inside the existing state transaction. Source access is checked at
// save time; a saved photo thereafter belongs to the destination's access model.
export async function savePhotoCopy({data,bot,env,album,id,input,persist,fail}){
  if(!/^[a-f0-9-]{36}$/.test(input.requestId || '') || !/^[a-f0-9]{16}$/.test(input.sourceEvent || '') || !/^[a-f0-9]{12}$/.test(input.mediaId || '') || input.mediaIds!==undefined)fail('Choose one photo to save.');
  if(input.sourceEvent===album.id)fail('This photo is already in this album.');
  const key=id+':'+input.requestId,signature=JSON.stringify(['photo-copy',album.id,input.sourceEvent,input.mediaId]);
  const prior=await env.DB.prepare("SELECT data FROM records WHERE kind='media_import' AND id=?").bind(key).first();
  if(prior){const saved=JSON.parse(prior.data);if(saved.signature!==signature)fail('That request was already used. Refresh and try again.',409);return {saved:true,alreadyHandled:true,copied:true,ids:saved.ids.filter(mid=>album.media.some(file=>file.id===mid))};}
  const source=data.events[input.sourceEvent],file=resolveMedia(data,source,source?.media?.find(item=>item.id===input.mediaId),id);
  if(!file || mediaPreview(file)!=='photo' || typeof file.fileId!=='string' || !file.fileId)fail('This photo is unavailable. Your source access may have changed.',403);
  const existing=album.media.find(item=>item.savedFrom?.event===source.id && item.savedFrom.media===input.mediaId);
  let copied=existing;
  if(!copied){
    copied={id:randomBytes(6).toString('hex'),at:new Date().toISOString(),savedFrom:{event:source.id,media:input.mediaId},savedBy:id};
    for(const field of ['type','fileId','thumbnail','filename','caption','mimeType','mime_type','size','by'])if(file[field]!==undefined)copied[field]=file[field];
    copied.name=showsUploaders(source)?file.name || null:null;
    album.media.push(copied);album.mediaUpdatedAt=copied.at;album.mediaEditVersion=(album.mediaEditVersion || 0)+1;
    await notifyMediaFollowers(bot,album,{...copied,by:id});
  }
  const ids=[copied.id];persist("INSERT INTO records(kind,id,data) VALUES ('media_import',?,?)",key,JSON.stringify({signature,ids}));
  return {saved:true,copied:true,added:existing?0:1,ids};
}
