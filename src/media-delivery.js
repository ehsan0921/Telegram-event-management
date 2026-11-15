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
  if(state.uncertain)delete state.uncertain[tracking.media];
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

// Photo/video albums contain 2–10 existing Telegram file IDs. Other types and
// single remainders retain their native individual delivery methods.
export async function queueMediaFiles(bot,id,e,files){
  let count=0,group=[];
  async function flush(){
    if(!group.length)return;
    const selected=group;group=[];
    if(selected.length===1 || !bot.durableMediaDelivery){for(const file of selected)if(await queueMedia(bot,id,e,file))count++;return;}
    const state=mediaDeliveryState(bot.db,id,e.id),items=selected.map(file=>({event:e.id,media:file.id,user:id,token:randomBytes(8).toString('hex'),grant:bot.db.preferences[id]?.mediaAccess?.[e.id] || `owner:${e.owner}`}));
    for(const item of items)state.pending[item.media]=item.token;
    const media=items.map(item=>{const file=e.media.find(file=>file.id===item.media),payload=mediaDeliveryPayload(bot,item);return {type:file.type,media:file.fileId,...(payload.caption?{caption:payload.caption}:{})};});
    try{await bot.api('sendMediaGroup',{chat_id:id,media,__mediaGroup:items});count+=items.length;}
    catch(error){for(const item of items)mediaDeliveryResult(bot.db,item,false);throw error;}
  }
  if(!e || e.cancelled || !bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return 0;
  const state=mediaDeliveryState(bot.db,id,e.id);
  for(const file of files){
    if(state.pending[file.id])continue;
    if(['photo','video'].includes(file.type)){group.push(file);if(group.length===10)await flush();}
    else{await flush();if(await queueMedia(bot,id,e,file))count++;}
  }
  await flush();return count;
}

export async function refreshMedia(bot,id){
  const rows=[];let received=0,pending=0,uncertain=0;
  for(const [eid,state] of Object.entries(bot.db.preferences[id]?.mediaDelivery || {})){
    const e=bot.db.events[eid];if(!bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))continue;
    received+=state.received.length;
    const unknown=Object.entries(state.uncertain || {}).filter(([mid,token])=>state.pending[mid]===token).length;
    uncertain+=unknown;pending+=Math.max(0,Object.keys(state.pending).length-unknown);
    if(unknown)rows.push([{text:`Review unconfirmed: ${e.title}`,callback_data:`media-retry:${eid}:review`}]);
  }
  return bot.send(id,`Media delivery: ${received} files confirmed, ${pending} queued, ${uncertain} unconfirmed. Refresh does not request or resend files.${uncertain?' Check your chat before choosing a retry; unconfirmed files may already be there.':''}`,{inline_keyboard:rows});
}
