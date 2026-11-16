import {markProgress,progressReady} from './media-progress-core.js';
import {mediaMethods} from './media-preview.js';
import {mutateMediaState} from './worker-store.js';
import {mediaDeliveryPayload,mediaDeliveryResult,mediaDeliveryState,clearResolvedMediaHold} from './media-delivery.js';

export async function prepareMediaGroup(env,row){
  const saved=JSON.parse(row.params),first=saved.__mediaGroup?.[0] || saved.__mediaDelivery;
  if(!first || saved.__mediaDelivered)return false;
  const scope=saved.__mediaGroup || [saved.__mediaDelivery];
  const held=await mutateMediaState(env,scope,(data,bot)=>(saved.__mediaGroup || [saved.__mediaDelivery]).some(item=>data.preferences[item.user]?.mediaDelivery?.[item.event]?.cancelled?.[item.media]!==item.token && !progressReady(data,item) && !!mediaDeliveryPayload(bot,item)));
  if(held){await env.DB.prepare('UPDATE outbox SET due=unixepoch()+1 WHERE id=?').bind(row.id).run();return 'deferred';}
  const previous=await env.DB.prepare("SELECT due FROM outbox WHERE rowid<(SELECT rowid FROM outbox WHERE id=?) AND coalesce(json_extract(params,'$.__mediaGroup[0].user'),json_extract(params,'$.__mediaDelivery.user'))=? ORDER BY rowid LIMIT 1").bind(row.id,first.user).first();
  if(previous){await env.DB.prepare('UPDATE outbox SET due=? WHERE id=?').bind(Math.max(previous.due,Math.floor(Date.now()/1000)+1),row.id).run();return 'deferred';}
  if(saved.__mediaGroup)return true;
  const items=[saved.__mediaDelivery],ids=[];
  const next=await env.DB.prepare("SELECT id,method,params,due FROM outbox WHERE rowid>(SELECT rowid FROM outbox WHERE id=?) AND coalesce(json_extract(params,'$.__mediaGroup[0].user'),json_extract(params,'$.__mediaDelivery.user'))=? ORDER BY rowid LIMIT 9").bind(row.id,first.user).all();
  const candidates=[row,...next.results];
  const types=await mutateMediaState(env,scope,(_data,bot)=>candidates.map(candidate=>{const tracking=JSON.parse(candidate.params).__mediaDelivery,payload=tracking && mediaDeliveryPayload(bot,tracking);return payload && progressReady(bot.db,tracking)?Object.keys(mediaMethods).find(type=>payload[type]):null;}));
  const category=type=>['photo','video'].includes(type)?'visual':['document','audio'].includes(type)?type:null;
  if(category(types[0]))for(let index=1;index<candidates.length;index++){
    const candidate=candidates[index],params=JSON.parse(candidate.params);
    if(candidate.due>Math.floor(Date.now()/1000) || !params.__mediaDelivery || params.__mediaDelivery.event!==first.event || params.__mediaDelivered || category(types[index])!==category(types[0]))break;
    items.push(params.__mediaDelivery);ids.push(candidate.id);
  }
  row.params=JSON.stringify({chat_id:first.user,__mediaGroup:items});
  await env.DB.batch([
    env.DB.prepare('UPDATE outbox SET params=? WHERE id=?').bind(row.params,row.id),
    ...ids.map(id=>env.DB.prepare('DELETE FROM outbox WHERE id=?').bind(id))
  ]);
  return true;
}

// A persisted attempt is deliberately not replayed after an uncertain outcome.
// A process interruption between sending and receipt persistence cannot prove
// that Telegram did not already deliver the album.
export async function deliverMediaGroup(env,row,telegram){
  let saved=JSON.parse(row.params),items=saved.__mediaGroup;
  if(!Array.isArray(items))return false;
  const scope=items;
  const remove=persist=>persist('DELETE FROM outbox WHERE id=?',row.id);
  if(saved.__mediaGroupDelivered){
    await mutateMediaState(env,scope,(data,_bot,{persist})=>{for(const item of items)mediaDeliveryResult(data,item,true);clearResolvedMediaHold(data,items[0].user,persist);remove(persist);});
    return true;
  }
  async function uncertain(reason='unknown'){
    await mutateMediaState(env,scope,async(data,bot,{persist})=>{
      for(const item of items){
        const state=mediaDeliveryState(data,item.user,item.event);
        if(state.pending[item.media]===item.token){state.uncertain ||= {};state.uncertain[item.media]=item.token;state.uncertainReason ||= {};state.uncertainReason[item.media]=reason;markProgress(data,item,reason==='partial'?'partial':'unconfirmed');}
      }
      const first=items[0],e=data.events[first.event];
      // A recovered/ambiguous send cannot be proven finished. Hold later batches
      // for this chat until its user explicitly reviews and requests a retry.
      persist("INSERT INTO records(kind,id,data) VALUES ('media_chat_state',?,json_object('blocked',1)) ON CONFLICT(kind,id) DO UPDATE SET data=json_set(records.data,'$.blocked',1)",String(first.user));
      if(bot.mediaAllowed(e,first.user) && bot.mediaCan(e,first.user,'viewMedia'))await bot.send(first.user,`Delivery of ${items.length} files could not be confirmed. Check your Telegram chat before retrying; they may already be there. Use /refresh to review unconfirmed deliveries.`);
      remove(persist);
    });
  }
  if(saved.__mediaGroupAttempted){await uncertain();return true;}
  const prepared=await mutateMediaState(env,scope,(data,bot,{persist})=>{
    const valid=[],payloads=[];
    for(const item of items){const payload=mediaDeliveryPayload(bot,item);if(payload){valid.push(item);payloads.push(payload);markProgress(data,item,'inflight',false);}else mediaDeliveryResult(data,item,false);}
    if(!valid.length)remove(persist);
    return {valid,payloads};
  });
  if(!prepared.valid.length)return true;
  items=prepared.valid;
  const params=items.length===1 ? prepared.payloads[0] : {
    chat_id:items[0].user,
    media:prepared.payloads.map(payload=>{
      const type=Object.keys(mediaMethods).find(type=>payload[type]);
      return {type,media:payload[type],...(payload.caption?{caption:payload.caption}:{})};
    })
  };
  const method=items.length===1 ? mediaMethods[Object.keys(mediaMethods).find(type=>params[type])] : 'sendMediaGroup';
  saved={...params,__mediaGroup:items,__mediaGroupAttempted:true};
  await env.DB.prepare('UPDATE outbox SET method=?,params=? WHERE id=?').bind(method,JSON.stringify(saved),row.id).run();
  const started=Date.now();
  console.log(JSON.stringify({event:'media_delivery_attempt',method,files:items.length}));
  const result=await telegram(env,method,params);
  console.log(JSON.stringify({event:'media_delivery_result',method,files:items.length,ok:!!result.ok,code:result.error_code || null,elapsedMs:Date.now()-started,receipts:Array.isArray(result.result)?result.result.length:result.result?.message_id?1:0}));
  if(result.ok){
    const receipts=items.length===1?[result.result]:result.result;
    const valid=Array.isArray(receipts) && receipts.length===items.length && receipts.every(message=>Number.isSafeInteger(message?.message_id) && message.message_id>0 && (!message.chat || message.chat.id===items[0].user)) && new Set(receipts.map(message=>message.message_id)).size===items.length;
    if(!valid){await uncertain(Array.isArray(receipts) && receipts.length>0 && receipts.length<items.length?'partial':'unknown');return true;}
    saved.__mediaGroupDelivered=receipts.map(message=>message.message_id);
    await env.DB.prepare('UPDATE outbox SET params=? WHERE id=?').bind(JSON.stringify(saved),row.id).run();
    await mutateMediaState(env,scope,(data,_bot,{persist})=>{for(const item of items)mediaDeliveryResult(data,item,true);clearResolvedMediaHold(data,items[0].user,persist);remove(persist);});
    return true;
  }
  if(result.error_code===429){
    await mutateMediaState(env,scope,data=>{for(const item of items)markProgress(data,item,'queued');});
    delete saved.__mediaGroupAttempted;
    const seconds=Math.max(1,Math.min(Number(result.parameters?.retry_after) || 5,3600));
    await env.DB.prepare('UPDATE outbox SET params=?,due=unixepoch()+? WHERE id=?').bind(JSON.stringify(saved),seconds,row.id).run();
    return 'retry';
  }
  if([400,403].includes(result.error_code)){
    await mutateMediaState(env,scope,async(data,bot,{persist})=>{
      for(const item of items)mediaDeliveryResult(data,item,false);
      if(!result.snapshotBlocked)await bot.send(items[0].user,`${items.length} files could not be delivered. They have not been marked as received. Use Get new media to try again.`);
      remove(persist);
    });
    return true;
  }
  await uncertain();return true;
}
