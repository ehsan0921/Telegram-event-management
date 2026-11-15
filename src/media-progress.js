import {mutateState} from './worker-store.js';
import {progressPayload} from './media-progress-core.js';
const jobFor=(data,t)=>data.preferences[t.user]?.mediaDelivery?.[t.event]?.jobs?.[t.job];
async function deliverProgress(env,row,telegram){
  const t=JSON.parse(row.params).__mediaProgress;
  const snapshot=await mutateState(env,(_data,bot)=>{
    const job=jobFor(bot.db,t);if(!job)return null;
    const payload=progressPayload(bot,t.user,t.event,job,!job.notice?.keyboardConfirmed && !job.cancelRequested);if(!payload)return null;
    return {payload,notice:{...job.notice},urgent:job.urgent,revision:job.revision};
  });
  const remove=persist=>persist('DELETE FROM outbox WHERE id=?',row.id);
  if(!snapshot){await env.DB.prepare('DELETE FROM outbox WHERE id=?').bind(row.id).run();return;}
  const {payload,notice}=snapshot,fingerprint=JSON.stringify(payload.reply_markup),send=true;
  // Telegram only edits messages without reply markup or with inline keyboards.
  // Updating a bottom reply keyboard requires a replacement sendMessage.
  if(!snapshot.urgent && Date.now()-(notice.lastUpdate || 0)<1000){await env.DB.prepare('UPDATE outbox SET due=? WHERE id=?').bind(Math.ceil((notice.lastUpdate+1000)/1000),row.id).run();return;}
  if(send && notice.sendAttempted){await mutateState(env,(data,_bot,{persist})=>{const job=jobFor(data,t);if(job){job.notice.pending=false;job.notice.disabled=true;job.dirty=false;}remove(persist);});return;}
  if(send)await mutateState(env,data=>{const job=jobFor(data,t);if(job)job.notice.sendAttempted=true;});
  const method='sendMessage';
  const params=payload;
  console.log(JSON.stringify({event:'media_progress_control',method,replyKeyboard:send,stage:'attempt'}));
  const result=await telegram(env,method,params,1500);
  if(result.error_code===429){
    if(send)await mutateState(env,data=>{const job=jobFor(data,t);if(job)delete job.notice.sendAttempted;});
    await env.DB.prepare('UPDATE outbox SET due=unixepoch()+? WHERE id=?').bind(Math.max(1,Math.min(Number(result.parameters?.retry_after) || 5,3600)),row.id).run();return;
  }
  const messageId=result.result?.message_id;
  const accepted=result.ok && Number.isSafeInteger(messageId) && messageId>0 && (!result.result?.chat || result.result.chat.id===t.user);
  await mutateState(env,(data,_bot,{persist})=>{
    const job=jobFor(data,t);if(job){
      job.notice.pending=false;
      if(accepted){
        const wasInitial=!job.notice.keyboardConfirmed;
        job.notice.messageId=messageId;job.notice.keyboard=fingerprint;job.notice.keyboardConfirmed=true;job.notice.lastUpdate=Date.now();delete job.notice.sendAttempted;job.urgent=false;
        job.dirty=job.revision>snapshot.revision;
        if(wasInitial && !Object.values(job.items).some(item=>['queued','inflight','stopping'].includes(item.status))){job.revision++;job.dirty=true;}
      }else{job.notice.disabled=true;job.dirty=false;}
    }
    remove(persist);
  });
  console.log(JSON.stringify({event:'media_progress_control',method,replyKeyboard:send,stage:accepted?'accepted':'unconfirmed'}));
  if(accepted && send && notice.messageId && notice.messageId!==messageId)await telegram(env,'deleteMessage',{chat_id:t.user,message_id:notice.messageId},1000);
}
export async function drainProgress(env,user,telegram){
  const query="SELECT params FROM outbox WHERE due<=unixepoch() AND json_type(params,'$.__mediaProgress') IS NOT NULL";
  if(user===undefined){
    const rows=await env.DB.prepare(query+' ORDER BY rowid LIMIT 20').all();
    const users=[...new Set(rows.results.map(row=>JSON.parse(row.params).__mediaProgress.user))].slice(0,4);
    await Promise.all(users.map(id=>drainProgress(env,id,telegram)));return;
  }
  const ready=await env.DB.prepare(query+" AND json_extract(params,'$.__mediaProgress.user')=? LIMIT 1").bind(user).first();if(!ready)return;
  const owner=crypto.randomUUID(),lease=JSON.stringify({owner,expires:Math.floor(Date.now()/1000)+30});
  const locked=await env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_ui_lease',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE json_extract(records.data,'$.expires')<unixepoch() RETURNING id").bind(String(user),lease).first();if(!locked)return;
  const deadline=Date.now()+5500;
  try{
    for(let count=0;count<8 && Date.now()<deadline;count++){
      const next=await env.DB.prepare("SELECT id FROM outbox WHERE due<=unixepoch() AND json_extract(params,'$.__mediaProgress.user')=? ORDER BY CASE WHEN json_extract(params,'$.__mediaProgress.initial') THEN 0 ELSE 1 END,rowid LIMIT 1").bind(user).first();
      if(!next)break;
      const row=await env.DB.prepare('UPDATE outbox SET due=unixepoch()+30,attempts=attempts+1 WHERE id=? AND due<=unixepoch() RETURNING *').bind(next.id).first();if(row)try{await deliverProgress(env,row,telegram);}catch{await env.DB.prepare('UPDATE outbox SET due=unixepoch()+1 WHERE id=?').bind(row.id).run();}
    }
  }finally{await env.DB.prepare("DELETE FROM records WHERE kind='media_ui_lease' AND id=? AND json_extract(data,'$.owner')=?").bind(String(user),owner).run();}
}
