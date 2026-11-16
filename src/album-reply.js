
export function currentAlbum(bot,id){const e=bot.db.events[bot.db.preferences[id]?.activeAlbum];return e && !e.cancelled && bot.mediaAllowed(e,id) && bot.mediaCan(e,id,'viewMedia')?e:null;}
export function albumReplyMarkup(bot,id){
  if(!currentAlbum(bot,id))return null;
  const pointer=bot.db.preferences[id]?.mediaKeyboard,job=pointer && bot.db.preferences[id]?.mediaDelivery?.[pointer.event]?.jobs?.[pointer.job],cancel=job && !job.cancelRequested && Object.values(job.items).some(item=>['queued','inflight','stopping'].includes(item.status))?[[{text:`✖ Cancel · ${Object.values(job.items).filter(item=>item.status==='sent').length}/${Object.keys(job.items).length}`}]]:[];
  return cancel.length?{keyboard:cancel,resize_keyboard:true,is_persistent:true}:null;
}
export function albumTextAction(text){
  if(text==='🔄 Refresh')return {action:'refresh'};if(text==='⋯ More')return {action:'album-more'};if(text==='🔗 Share')return {action:'album-share'};if(text==='➕ Add media')return {action:'media-add'};if(text==='📂 Open album app')return {action:'album-app'};
  if(/^📥 Get all \(\d+\)$/.test(text))return {action:'media-get',arg:'all'};if(/^🆕 Get new \(\d+\)$/.test(text))return {action:'media-get',arg:'new'};
  const follow=text.match(/^[🔔🔕]+ Follow:(ON|OFF)$/u);return follow?{action:'media-follow',arg:follow[1]==='ON'?'off':'on'}:null;
}
