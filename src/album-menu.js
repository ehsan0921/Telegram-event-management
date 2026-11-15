import {photoLinks,showsUploaders} from './permissions.js';
import {mediaDeliveryState} from './media-delivery.js';
import {isManager} from './cohosts.js';
const button=(text,callback_data)=>({text,callback_data});
const keyboard=rows=>({inline_keyboard:rows});
const canShareUploads=(bot,id,e)=>!!photoLinks(e,bot.username)?.contributor && bot.mediaCan(e,id,'uploadMedia');
export function albumMain(bot,id,e){
  const state=mediaDeliveryState(bot.db,id,e.id),received=new Set(state.received);
  const rows=[
    [bot.appUrl?bot.miniButton('Open album app',`?gallery=${e.id}`):button('Open album app',`m:${e.id}:0`)],
    [button(`Get all (${e.media.length})`,`media-get:${e.id}:all`),button(`Get new (${e.media.filter(file=>!received.has(file.id)).length})`,`media-get:${e.id}:new`)],
    [button('Add media',`media-add:${e.id}`),button('Share',`album-share:${e.id}`)],
    [button(`Follow ${state.follow?'On':'Off'}`,`media-follow:${e.id}:${state.follow?'off':'on'}`),button('More',`album-more:${e.id}`)]
  ];
  if(Object.entries(state.pending).some(([mid,token])=>state.cancelled?.[mid]!==token && state.uncertain?.[mid]!==token))rows.push([button('Cancel delivery',`media-cancel:${e.id}:${state.deliveryGeneration || 0}`)]);
  return bot.send(id,e.title,keyboard(rows));
}
export function albumShare(bot,id,e){
  const links=photoLinks(e,bot.username),capable=canShareUploads(bot,id,e);
  const on=capable && bot.db.preferences[id]?.albumShare?.[e.id]!==false;
  const rows=[];
  if(links){
    rows.push([button(`Allow others to add photos: ${on?'ON':'OFF'}`,`album-share-set:${e.id}:${on?'off':'on'}`)]);
    const link=on?links.contributor:links.viewer;
    if(link)rows.push([{text:'Copy link',copy_text:{text:link}}]);
  }
  rows.push([button('Back',`v:${e.id}`)]);
  return bot.send(id,`${e.title}\nShare an ${on?'upload and viewing':'viewing-only'} link. This choice changes the link you copy; existing links and access stay unchanged.${!capable?'\nYour current access or the album settings allow sharing a viewing-only link.':''}${!links?'\nSharing is disabled for this album.':''}`,keyboard(rows));
}
export function albumMore(bot,id,e){
  const state=mediaDeliveryState(bot.db,id,e.id),rows=[];
  const unknown=Object.entries(state.uncertain || {}).filter(([mid,token])=>state.pending[mid]===token).length;
  if(unknown)rows.push([button(`Review unconfirmed (${unknown})`,`media-retry:${e.id}:review`)]);
  if(e.owner===id){
    rows.push([button(showsUploaders(e)?'Uploader names: shown':'Uploader names: hidden',`photo-names:${e.id}`)]);
    rows.push([button('Viewers & contributors',`album-members:${e.id}`)]);
    rows.push([button('Danger zone',`album-danger:${e.id}`)]);
  }else if(!isManager(e,id))rows.push([button('Leave album',`album-leave:${e.id}`)]);
  rows.push([button('Main menu','nav:home')],[button('Back',`v:${e.id}`)]);
  return bot.send(id,e.title,keyboard(rows));
}
export function albumMenuCallback(bot,id,e,action,arg){
  if(!['album-share','album-share-set','album-more'].includes(action))return null;
  if(e?.kind!=='photos' || !bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return bot.home(id,'This media link is unavailable.');
  if(action==='album-more')return albumMore(bot,id,e);
  if(action==='album-share-set'){
    if(!['on','off'].includes(arg))return albumShare(bot,id,e);
    if(arg==='on' && !canShareUploads(bot,id,e))return albumShare(bot,id,e);
    bot.db.preferences[id] ||= {};bot.db.preferences[id].albumShare ||= {};
    bot.db.preferences[id].albumShare[e.id]=arg==='on';
  }
  return albumShare(bot,id,e);
}
