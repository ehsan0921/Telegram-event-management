import {markProgress,ownedProgress} from './media-progress-core.js';
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
    state?.cancelled?.[tracking.media]!==tracking.token && state?.pending?.[tracking.media]===tracking.token && (!tracking.follow || state.follow && state.followToken===tracking.follow) &&
    tracking.grant===(bot.db.preferences[tracking.user]?.mediaAccess?.[e.id] || `owner:${e.owner}`) && e.media.some(file=>file.id===tracking.media));
}
export function mediaDeliveryResult(data,tracking,success){
  const state=data.preferences[tracking.user]?.mediaDelivery?.[tracking.event];
  if(state?.pending?.[tracking.media]!==tracking.token)return;
  markProgress(data,tracking,success?'sent':state.cancelled?.[tracking.media]===tracking.token?'cancelled':'failed');
  state.results ||= {};state.results[tracking.media]={token:tracking.token,status:success?'sent':state.cancelled?.[tracking.media]===tracking.token?'cancelled':'failed'};
  delete state.pending[tracking.media];
  if(state.cancelled?.[tracking.media]===tracking.token)delete state.cancelled[tracking.media];
  if(state.uncertain)delete state.uncertain[tracking.media];
  if(state.uncertainReason)delete state.uncertainReason[tracking.media];
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
  if(!Object.keys(state.pending).length)state.deliveryGeneration=(state.deliveryGeneration || 0)+1;
  const tracking={event:e.id,media:file.id,user:id,token:randomBytes(8).toString('hex'),grant:bot.db.preferences[id]?.mediaAccess?.[e.id] || `owner:${e.owner}`,...(follow?{follow:state.followToken}:{})};
  state.pending[file.id]=tracking.token;state.results ||= {};state.results[file.id]={token:tracking.token,status:'queued'};
  try{
    await bot.api(mediaMethods[file.type],{...mediaDeliveryPayload(bot,tracking),__mediaDelivery:tracking});
    if(!bot.durableMediaDelivery)mediaDeliveryResult(bot.db,tracking,true);
  }catch(error){mediaDeliveryResult(bot.db,tracking,false);throw error;}
  return true;
}
export async function notifyMediaFollowers(bot,e,file){

  for(const [uid,preference] of Object.entries(bot.db.preferences)){
    const id=Number(uid),state=preference.mediaDelivery?.[e.id];
    if(!Number.isSafeInteger(id) || id===file.by || !state?.follow || state.received.includes(file.id))continue;
    await queueMedia(bot,id,e,file,{follow:true});
  }
}

// Photo/video albums contain 2–10 existing Telegram file IDs. Other types and
// single remainders retain their native individual delivery methods.
export async function queueMediaFiles(bot,id,e,files){
  let count=0,group=[],category=null;
  const groupKind=file=>['photo','video'].includes(file.type)?'visual':['document','audio'].includes(file.type)?file.type:null;
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
  if(!Object.keys(state.pending).length)state.deliveryGeneration=(state.deliveryGeneration || 0)+1;
  for(const file of files){
    if(state.pending[file.id])continue;
    const kind=groupKind(file);
    if(kind){if(category && category!==kind)await flush();category=kind;group.push(file);if(group.length===10)await flush();}
    else{await flush();if(await queueMedia(bot,id,e,file))count++;}
  }
  await flush();return count;
}

export async function refreshMedia(bot,id){
  const rows=[];let received=0,pending=0,uncertain=0,stopping=0;
  for(const [eid,state] of Object.entries(bot.db.preferences[id]?.mediaDelivery || {})){
    const e=bot.db.events[eid];if(!bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))continue;
    received+=state.received.length;
    const unknown=Object.entries(state.uncertain || {}).filter(([mid,token])=>state.pending[mid]===token).length;
    const stopped=Object.entries(state.cancelled || {}).filter(([mid,token])=>state.pending[mid]===token && state.uncertain?.[mid]!==token).length;
    stopping+=stopped;uncertain+=unknown;pending+=Math.max(0,Object.keys(state.pending).length-unknown-stopped);
    const active=Object.entries(state.pending).filter(([mid,token])=>state.uncertain?.[mid]!==token && state.cancelled?.[mid]!==token).length;

    if(unknown)rows.push([{text:`Review unconfirmed: ${e.title}`,callback_data:`media-retry:${eid}:review`}]);
  }
  return bot.send(id,`Media delivery: ${received} files confirmed, ${pending} queued, ${stopping} stopping, ${uncertain} unconfirmed. Refresh does not request or resend files.${uncertain?' Check your chat before choosing a retry; unconfirmed files may already be there.':''}`,{inline_keyboard:rows});
}

export function cancelMedia(bot,id,e,generation){
  if(!bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return bot.home(id,'This media link is unavailable.');
  const state=mediaDeliveryState(bot.db,id,e.id);
  if(String(state.deliveryGeneration || 0)!==generation)return refreshMedia(bot,id);
  state.cancelled ||= {};
  for(const [mid,token] of Object.entries(state.pending))if(state.uncertain?.[mid]!==token && !ownedProgress(bot.db,{user:id,event:e.id,media:mid,token}))state.cancelled[mid]=token;
  return bot.send(id,'Cancellation requested for your remaining delivery from this album. Files already sent stay in your chat. A request already in progress may still arrive. Use /refresh, then Get new to receive the remaining files once stopping has settled.');
}

export function deliveryStatus(state,media,request){
  if(state?.pending?.[media]===request){
    if(state.uncertain?.[media]===request)return state.uncertainReason?.[media]==='partial'?'partial':'unconfirmed';
    if(state.cancelled?.[media]===request)return 'stopping';
    return 'queued';
  }
  const result=state?.results?.[media];
  return result?.token===request && ['sent','failed','cancelled'].includes(result.status)?result.status:'unconfirmed';
}

export function clearResolvedMediaHold(data,user,persist){
  if(!Object.values(data.preferences[user]?.mediaDelivery || {}).some(state=>Object.keys(state.uncertain || {}).length))persist("UPDATE records SET data=json_set(data,'$.blocked',0) WHERE kind='media_chat_state' AND id=?",String(user));
}
