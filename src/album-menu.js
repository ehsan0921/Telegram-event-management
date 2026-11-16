import {visibleMedia} from './media-reference.js';
import {photoLinks,showsUploaders,uploadLink} from './permissions.js';
import {mediaDeliveryState} from './media-delivery.js';
import {isManager} from './cohosts.js';
const button=(text,callback_data)=>({text,callback_data});
const keyboard=rows=>({inline_keyboard:rows});
const linksFor=(bot,e)=>e.kind==='photos'?photoLinks(e,bot.username):e.cancelled?null:{viewer:`https://t.me/${bot.username}?startapp=gallery_${e.id}`,contributor:uploadLink(e,bot.username)};
const canShareUploads=(bot,id,e)=>!!linksFor(bot,e)?.contributor && bot.mediaCan(e,id,'uploadMedia');
export function albumMain(bot,id,e){
  const state=mediaDeliveryState(bot.db,id,e.id),received=new Set(state.received);
  const available=visibleMedia(bot.db,e,id);
  const rows=[
    [bot.appUrl?bot.miniButton('📂 Open album app',`?gallery=${e.id}`):button('📂 Open album app',`m:${e.id}:0`)],
    [button(`📥 Get all (${available.length})`,`media-get:${e.id}:all`),button(`🆕 Get new (${available.filter(file=>!received.has(file.id)).length})`,`media-get:${e.id}:new`)],
    [button('➕ Add media',`media-add:${e.id}`),button('🔗 Share',`album-share:${e.id}`)],
    [button(`${state.follow?'🔔':'🔕'} Follow:${state.follow?'ON':'OFF'}`,`media-follow:${e.id}:${state.follow?'off':'on'}`),button('⋯ More',`album-more:${e.id}`)]
  ];
  if(e.kind!=='photos' && e.banner)return bot.api('sendPhoto',{chat_id:id,photo:e.banner,caption:e.title,reply_markup:keyboard(rows)});
  return bot.send(id,e.title,keyboard(rows));
}
export function albumShare(bot,id,e){
  const links=linksFor(bot,e),capable=canShareUploads(bot,id,e);
  const on=capable && bot.db.preferences[id]?.albumShare?.[e.id]!==false;
  const rows=[];
  if(links){
    rows.push([button(`Allow others to add photos: ${on?'ON':'OFF'}`,`album-share-set:${e.id}:${on?'off':'on'}`)]);
    const link=on?links.contributor:links.viewer;
    if(link)rows.push([{text:'Copy link',copy_text:{text:link}}]);
  }
  rows.push([button('Back',`album-open:${e.id}`)]);
  const description=e.kind==='photos'?`Share an ${on?'upload and viewing':'viewing-only'} link.`:on?'Share an upload link. Gallery access still follows the event settings.':'Share a gallery link. Existing invitation and gallery permissions still apply.';
  return bot.send(id,`${e.title}\n${description} This choice changes the link you copy; existing links and access stay unchanged.${!capable?'\nYour current access or the album settings allow sharing a viewing-only link.':''}${!links?'\nSharing is disabled for this album.':''}`,keyboard(rows));
}
export function albumMore(bot,id,e){
  const state=mediaDeliveryState(bot.db,id,e.id),rows=[];
  const unknown=Object.entries(state.uncertain || {}).filter(([mid,token])=>state.pending[mid]===token).length;
  if(unknown)rows.push([button(`Review unconfirmed (${unknown})`,`media-retry:${e.id}:review`)]);
  if(e.kind!=='photos'){
    rows.push([button('↩️ Back to event',`v:${e.id}`)]);
    if(!isManager(e,id) && e.guests[id])rows.push([button('🎟 Invitation options',`invite-leave:${e.id}`)]);
  }else if(e.owner===id){
    rows.push([button(showsUploaders(e)?'👤 Uploader names: shown':'👤 Uploader names: hidden',`photo-names:${e.id}`)]);
    rows.push([button('👥 Viewers & contributors',`album-members:${e.id}`)]);
    rows.push([button('⚠️ Danger zone',`album-danger:${e.id}`)]);
  }else if(!isManager(e,id))rows.push([button('🚪 Leave album',`album-leave:${e.id}`)]);
  rows.push([button('🏠 Main menu','nav:home')],[button('⬅️ Back',`album-open:${e.id}`)]);
  return bot.send(id,e.title,keyboard(rows));
}
export function albumMenuCallback(bot,id,e,action,arg){
  if(!['album-open','album-share','album-share-set','album-more'].includes(action))return null;
  if(!e || e.cancelled || !bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return bot.home(id,'This media link is unavailable.');
  if(action==='album-open')return bot.mediaCard(id,e);
  if(action==='album-more')return albumMore(bot,id,e);
  if(action==='album-share-set'){
    if(!['on','off'].includes(arg))return albumShare(bot,id,e);
    if(arg==='on' && !canShareUploads(bot,id,e))return albumShare(bot,id,e);
    bot.db.preferences[id] ||= {};bot.db.preferences[id].albumShare ||= {};
    bot.db.preferences[id].albumShare[e.id]=arg==='on';
  }
  return albumShare(bot,id,e);
}
