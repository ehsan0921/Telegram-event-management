import {randomBytes,createHash} from 'node:crypto';
const stateFor=(data,id,eid)=>data.preferences[id]?.mediaDelivery?.[eid];
const active=item=>['queued','inflight','stopping'].includes(item.status);
export function progressStats(job){
  const values=Object.values(job.items),count=status=>values.filter(item=>item.status===status).length,sent=count('sent');
  return {total:values.length,sent,remaining:values.length-sent,queued:count('queued'),inflight:count('inflight'),stopping:count('stopping'),failed:count('failed'),cancelled:count('cancelled'),unknown:count('unconfirmed'),partial:count('partial')};
}
export function ownedProgress(data,t){return Object.values(stateFor(data,t.user,t.event)?.jobs || {}).find(job=>job.items[t.media]?.token===t.token);}
export const progressReady=(data,t)=>{const job=ownedProgress(data,t);return !job || !!job.notice?.keyboardConfirmed;};
export function markProgress(data,t,status,dirty=true){
  const job=ownedProgress(data,t),item=job?.items[t.media];if(!item || item.status===status)return;
  item.status=status;if(dirty){job.revision++;job.dirty=true;}
}
export function progressKeyboard(job){
  const s=progressStats(job);
  return {keyboard:[[{text:`✖ Cancel · ${s.sent}/${s.total}`}]],resize_keyboard:true,is_persistent:true};
}
const labelKey=text=>createHash('sha256').update(text).digest('hex').slice(0,24);
function rememberLabel(pref,job){
  const key=labelKey(progressKeyboard(job).keyboard[0][0].text);pref.mediaCancelLabels ||= {};
  if(!(key in pref.mediaCancelLabels)){
    if(Object.keys(pref.mediaCancelLabels).length>=4096){pref.mediaCancelLabelsFull=true;return;}
    pref.mediaCancelLabels[key]=job.id;
  }else if(pref.mediaCancelLabels[key]!==job.id)pref.mediaCancelLabels[key]=null;
}
function currentJob(bot,id){
  const pref=bot.db.preferences[id],pointer=pref?.mediaKeyboard;
  const current=pointer && stateFor(bot.db,id,pointer.event)?.jobs?.[pointer.job];
  if(current && !current.cancelRequested && Object.values(current.items).some(active))return current;
  const jobs=Object.entries(pref?.mediaDelivery || {}).flatMap(([event,state])=>Object.values(state.jobs || {}).map(job=>({event,job})));
  const next=jobs.filter(item=>!item.job.cancelRequested && Object.values(item.job.items).some(active)).sort((a,b)=>a.job.number-b.job.number).at(-1);
  if(next){pref.mediaKeyboard={event:next.event,job:next.job.id,number:next.job.number};return next.job;}
  if(pref)delete pref.mediaKeyboard;return null;
}
function reconcile(state,job){
  for(const [mid,item] of Object.entries(job.items))if(active(item)){
    const result=state?.results?.[mid];let status=result?.token===item.token && ['sent','failed','cancelled'].includes(result.status)?result.status:null;
    if(state?.uncertain?.[mid]===item.token)status=state.uncertainReason?.[mid]==='partial'?'partial':'unconfirmed';
    if(status && status!==item.status){item.status=status;job.revision++;job.dirty=true;}
  }
}
export function progressPayload(bot,id,eid,job,initial=false){
  reconcile(stateFor(bot.db,id,eid),job);
  const e=bot.db.events[eid];if(!e || !bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return null;
  const s=progressStats(job),current=initial?job:currentJob(bot,id);
  if(current)rememberLabel(bot.db.preferences[id],current);
  const text=job.cancelRequested?'Stopping. A batch already in flight may still arrive.':s.unknown+s.partial?`Sent ${s.sent}/${s.total} · ${s.unknown+s.partial} unconfirmed. Check chat before retry.`:s.failed?`Sent ${s.sent}/${s.total} · ${s.failed} failed.`:!s.total?'Nothing new to send.':s.remaining===0?`Sent ${s.sent}/${s.total}.`:'…';
  if(job.confirmRequested && job.notice?.keyboardConfirmed){
    const rows=Object.entries(bot.db.preferences[id].mediaDelivery || {}).flatMap(([event,state])=>Object.values(state.jobs || {}).filter(j=>!j.cancelRequested && Object.values(j.items).some(active) && bot.mediaAllowed(bot.db.events[event],id) && bot.mediaCan(bot.db.events[event],id,'viewMedia')).map(j=>[{text:`Stop: ${bot.db.events[event].title.slice(0,32)} · ${progressStats(j).sent}/${progressStats(j).total}`,callback_data:`media-stop:${event}:${j.id}`}]));
    if(rows.length)return {chat_id:id,text:'Which delivery should stop? An older button may have the same counts.',disable_notification:true,reply_markup:{inline_keyboard:rows}};
  }
  return {chat_id:id,text,disable_notification:true,reply_markup:current?progressKeyboard(current):bot.idleKeyboard(id)};
}
export function startProgress(bot,id,e,files){
  const pref=bot.db.preferences[id],state=stateFor(bot.db,id,e.id);if(!state)return null;state.jobs ||= {};
  const owned=new Set(Object.values(state.jobs).flatMap(job=>Object.values(job.items).map(item=>item.token)));
  const entries=files.filter(file=>state.pending[file.id] && !owned.has(state.pending[file.id]));
  if(!entries.length){
    const existing=Object.values(state.jobs).filter(job=>files.some(file=>job.items[file.id]?.token===state.pending[file.id])).at(-1);
    if(existing){pref.mediaKeyboard={event:e.id,job:existing.id,number:existing.number};existing.dirty=true;existing.urgent=true;existing.revision++;if(existing.notice?.disabled){existing.notice.disabled=false;existing.notice.keyboard=null;delete existing.notice.sendAttempted;}return existing;}
  }
  pref.mediaProgressSequence=(pref.mediaProgressSequence || 0)+1;
  const job={id:randomBytes(8).toString('hex'),number:pref.mediaProgressSequence,createdAt:Date.now(),items:Object.fromEntries(entries.map(file=>[file.id,{token:state.pending[file.id],status:'queued'}])),skipped:files.filter(file=>state.pending[file.id] && owned.has(state.pending[file.id])).length,revision:1,dirty:true,urgent:true,notice:{}};
  state.jobs[job.id]=job;pref.mediaKeyboard={event:e.id,job:job.id,number:job.number};
  const done=Object.values(state.jobs).filter(item=>item.id!==job.id && !Object.values(item.items).some(active));
  for(const old of done.slice(0,Math.max(0,done.length-20)))delete state.jobs[old.id];return job;
}
export async function flushProgress(bot){
  for(const [uid,pref] of Object.entries(bot.db.preferences))for(const [eid,state] of Object.entries(pref.mediaDelivery || {}))for(const job of Object.values(state.jobs || {})){
    reconcile(state,job);
    if(!job.dirty || job.notice?.pending || job.notice?.disabled)continue;
    const payload=progressPayload(bot,Number(uid),eid,job,!job.notice?.keyboardConfirmed && !job.cancelRequested);if(!payload)continue;
    job.notice ||= {};job.notice.pending=true;job.dirty=false;
    await bot.api('sendMessage',{...payload,__mediaProgress:{user:Number(uid),event:eid,job:job.id,initial:!job.notice.keyboardConfirmed}});
  }
}
export function parseProgressText(text){
  if(/^✖ Cancel · \d+\/\d+$/.test(text))return {label:text,cancel:true};
  // Recognize previously issued controls, but never infer a new job from them.
  let m=text.match(/^✖ Cancel #(\d+)$/);if(m)return {number:Number(m[1]),cancel:true};
  m=text.match(/^📊 \d+\/\d+ sent · \d+ left · #(\d+)$/);return m?{number:Number(m[1]),cancel:false}:null;
}
export function progressTextAction(bot,id,command){
  const pref=bot.db.preferences[id],pointer=pref?.mediaKeyboard;
  let target=command.job;
  if(command.label){
    const owner=pref?.mediaCancelLabels?.[labelKey(command.label)];
    if(!pref?.mediaCancelLabelsFull && owner && owner===pointer?.job)target=owner;
    else if(pointer){const current=stateFor(bot.db,id,pointer.event)?.jobs?.[pointer.job];if(current){current.confirmRequested=true;current.dirty=true;current.urgent=true;current.revision++;return;}}
  }
  if(command.number!==undefined && pointer?.number===command.number)target=pointer.job;
  const event=command.event || pointer?.event,state=stateFor(bot.db,id,event),job=state?.jobs?.[target],e=bot.db.events[event];
  if(!job || !bot.mediaAllowed(e,id) || !bot.mediaCan(e,id,'viewMedia'))return bot.send(id,'That delivery control has expired. Use Get new to continue.',bot.idleKeyboard(id));
  if(!Object.values(job.items).some(active))return bot.send(id,'That delivery has already finished.');
  if(command.cancel){
    job.cancelRequested=true;state.cancelled ||= {};
    for(const [mid,item] of Object.entries(job.items))if(state.pending[mid]===item.token && !['unconfirmed','partial'].includes(item.status)){
      state.cancelled[mid]=item.token;if(item.status!=='inflight')item.status='stopping';
    }
    for(const delivery of Object.values(pref.mediaDelivery || {}))for(const other of Object.values(delivery.jobs || {}))delete other.confirmRequested;
  }
  job.revision++;job.dirty=true;job.urgent=true;if(job.notice?.disabled){job.notice.disabled=false;delete job.notice.sendAttempted;}
}
