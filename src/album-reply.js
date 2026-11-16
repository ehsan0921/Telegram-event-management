import {visibleMedia} from './media-reference.js';

export function currentAlbum(bot,id){const e=bot.db.events[bot.db.preferences[id]?.activeAlbum];return e && !e.cancelled && bot.mediaAllowed(e,id) && bot.mediaCan(e,id,'viewMedia')?e:null;}
export function albumBottomRow(bot,id){const e=currentAlbum(bot,id);if(!e)return null;const state=bot.db.preferences[id]?.mediaDelivery?.[e.id];return [{text:`${state?.follow?'🔔':'🔕'} Follow:${state?.follow?'ON':'OFF'}`},{text:'⋯ More'},{text:'🔄 Refresh'}];}
export function albumReplyMarkup(bot,id){
  const e=currentAlbum(bot,id);if(!e)return null;const state=bot.db.preferences[id]?.mediaDelivery?.[e.id] || {},received=new Set(state.received || []),files=visibleMedia(bot.db,e,id);
  const open=bot.appUrl?bot.miniButton('📂 Open album app',`?gallery=${e.id}`):{text:'📂 Open album app'};
  const pointer=bot.db.preferences[id]?.mediaKeyboard,job=pointer && bot.db.preferences[id]?.mediaDelivery?.[pointer.event]?.jobs?.[pointer.job],cancel=job && !job.cancelRequested && Object.values(job.items).some(item=>['queued','inflight','stopping'].includes(item.status))?[[{text:`✖ Cancel · ${Object.values(job.items).filter(item=>item.status==='sent').length}/${Object.keys(job.items).length}`}]]:[];
  return {keyboard:[...cancel,[open],[{text:`📥 Get all (${files.length})`},{text:`🆕 Get new (${files.filter(file=>!received.has(file.id)).length})`}],[{text:'➕ Add media'},{text:'🔗 Share'}],albumBottomRow(bot,id)],resize_keyboard:true,is_persistent:true};
}
export function albumTextAction(text){
  if(text==='🔄 Refresh')return {action:'refresh'};if(text==='⋯ More')return {action:'album-more'};if(text==='🔗 Share')return {action:'album-share'};if(text==='➕ Add media')return {action:'media-add'};if(text==='📂 Open album app')return {action:'m',arg:'0'};
  if(/^📥 Get all \(\d+\)$/.test(text))return {action:'media-get',arg:'all'};if(/^🆕 Get new \(\d+\)$/.test(text))return {action:'media-get',arg:'new'};
  const follow=text.match(/^[🔔🔕]+ Follow:(ON|OFF)$/u);return follow?{action:'media-follow',arg:follow[1]==='ON'?'off':'on'}:null;
}
