import {randomBytes} from 'node:crypto';
import {mediaMethods,mediaPayload} from './media-preview.js';
import {showsUploaders} from './permissions.js';

export function mediaDeliveryState(data,id,eid){
  const preference=data.preferences[id] ||= {};
  preference.mediaDelivery ||= {};
  if(!preference.mediaDelivery[eid]){
    const follow=data.events[eid]?.kind==='photos';
    preference.mediaDelivery[eid]={received:[],pending:{},follow,...(follow?{followToken:randomBytes(8).toString('hex')}:{})};
  }
  return preference.mediaDelivery[eid];
}
export function mediaDeliveryAllowed(bot,tracking){
  const e=bot.db.events[tracking.event],state=bot.db.preferences[tracking.user]?.mediaDelivery?.[tracking.event];
  return !!(e && !e.cancelled && bot.mediaAllowed(e,tracking.user) && bot.mediaCan(e,tracking.user,'viewMedia') &&
    state?.pending?.[tracking.media]===tracking.token && (!tracking.follow || state.follow && state.followToken===tracking.follow) &&
    tracking.grant===(bot.db.preferences[tracking.user]?.mediaAccess?.[e.id] || `owner:${e.owner}`) && e.media.some(file=>file.id===tracking.media));
}
export function mediaDeliveryResult(data,tracking,success){
  const state=data.preferences[tracking.user]?.mediaDelivery?.[tracking.event];
  if(state?.pending?.[tracking.media]!==tracking.token)return;
  delete state.pending[tracking.media];
  if(success && !state.received.includes(tracking.media))state.received.push(tracking.media);
}
export function mediaDeliveryPayload(bot,tracking){
  if(!mediaDeliveryAllowed(bot,tracking))return null;
  const e=bot.db.events[tracking.event],file=e.media.find(item=>item.id===tracking.media);
  const caption=[tracking.follow?`New media · ${e.title}`:e.title,showsUploaders(e)?`Shared by ${file.name}`:'Shared media',file.caption].filter(Boolean).join('\n').slice(0,1024);
  return mediaPayload(file,tracking.user,caption);
}
export async function queueMedia(bot,id,e,file,{follow=false}={}){
  if(!bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia') || !mediaMethods[file.type])return false;
  const state=mediaDeliveryState(bot.db,id,e.id);
  if(state.pending[file.id])return false;
  const tracking={event:e.id,media:file.id,user:id,token:randomBytes(8).toString('hex'),grant:bot.db.preferences[id]?.mediaAccess?.[e.id] || `owner:${e.owner}`,...(follow?{follow:state.followToken}:{})};
  state.pending[file.id]=tracking.token;
  try{
    await bot.api(mediaMethods[file.type],{...mediaDeliveryPayload(bot,tracking),__mediaDelivery:tracking});
    if(!bot.durableMediaDelivery)mediaDeliveryResult(bot.db,tracking,true);
  }catch(error){mediaDeliveryResult(bot.db,tracking,false);throw error;}
  return true;
}
export async function notifyMediaFollowers(bot,e,file){
  if(e.kind!=='photos')return;
  for(const [uid,preference] of Object.entries(bot.db.preferences)){
    const id=Number(uid),state=preference.mediaDelivery?.[e.id];
    if(!Number.isSafeInteger(id) || id===file.by || !state?.follow || state.received.includes(file.id))continue;
    await queueMedia(bot,id,e,file,{follow:true});
  }
}
