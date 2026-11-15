import {mediaMethods} from './media-preview.js';
import {mutateState} from './worker-store.js';
import {mediaDeliveryPayload,mediaDeliveryResult,mediaDeliveryState} from './media-delivery.js';

export async function prepareMediaGroup(env,row){
  const saved=JSON.parse(row.params),first=saved.__mediaGroup?.[0] || saved.__mediaDelivery;
  if(!first || saved.__mediaDelivered)return false;
  const previous=await env.DB.prepare("SELECT due FROM outbox WHERE rowid<(SELECT rowid FROM outbox WHERE id=?) AND coalesce(json_extract(params,'$.__mediaGroup[0].user'),json_extract(params,'$.__mediaDelivery.user'))=? AND coalesce(json_extract(params,'$.__mediaGroup[0].event'),json_extract(params,'$.__mediaDelivery.event'))=? ORDER BY rowid LIMIT 1").bind(row.id,first.user,first.event).first();
  if(previous){await env.DB.prepare('UPDATE outbox SET due=? WHERE id=?').bind(Math.max(previous.due,Math.floor(Date.now()/1000)+1),row.id).run();return 'deferred';}
  if(saved.__mediaGroup)return true;
  const items=[saved.__mediaDelivery],ids=[];
  const next=await env.DB.prepare("SELECT id,method,params,due FROM outbox WHERE rowid>(SELECT rowid FROM outbox WHERE id=?) AND coalesce(json_extract(params,'$.__mediaGroup[0].user'),json_extract(params,'$.__mediaDelivery.user'))=? AND coalesce(json_extract(params,'$.__mediaGroup[0].event'),json_extract(params,'$.__mediaDelivery.event'))=? ORDER BY rowid LIMIT 9").bind(row.id,first.user,first.event).all();
  const candidates=[row,...next.results];
  const types=await mutateState(env,(_data,bot)=>candidates.map(candidate=>{const tracking=JSON.parse(candidate.params).__mediaDelivery,payload=tracking && mediaDeliveryPayload(bot,tracking);return payload?Object.keys(mediaMethods).find(type=>payload[type]):null;}));
  const category=type=>['photo','video'].includes(type)?'visual':['document','audio'].includes(type)?type:null;
  if(category(types[0]))for(let index=1;index<candidates.length;index++){
    const candidate=candidates[index],params=JSON.parse(candidate.params);
    if(candidate.due>Math.floor(Date.now()/1000) || !params.__mediaDelivery || params.__mediaDelivered || category(types[index])!==category(types[0]))break;
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
  const remove=persist=>persist('DELETE FROM outbox WHERE id=?',row.id);
  if(saved.__mediaGroupDelivered){
    await mutateState(env,(data,_bot,{persist})=>{for(const item of items)mediaDeliveryResult(data,item,true);remove(persist);});
    return true;
  }
  async function uncertain(reason='unknown'){
    await mutateState(env,async(data,bot,{persist})=>{
      for(const item of items){
        const state=mediaDeliveryState(data,item.user,item.event);
        if(state.pending[item.media]===item.token){state.uncertain ||= {};state.uncertain[item.media]=item.token;state.uncertainReason ||= {};state.uncertainReason[item.media]=reason;}
      }
      const first=items[0],e=data.events[first.event];
      if(bot.mediaAllowed(e,first.user) && bot.mediaCan(e,first.user,'viewMedia'))await bot.send(first.user,`Delivery of ${items.length} files could not be confirmed. Check your Telegram chat before retrying; they may already be there. Use /refresh to review unconfirmed deliveries.`);
      remove(persist);
    });
  }
  if(saved.__mediaGroupAttempted){await uncertain();return true;}
  const prepared=await mutateState(env,(data,bot,{persist})=>{
    const valid=[],payloads=[];
    for(const item of items){const payload=mediaDeliveryPayload(bot,item);if(payload){valid.push(item);payloads.push(payload);}else mediaDeliveryResult(data,item,false);}
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
    await mutateState(env,(data,_bot,{persist})=>{for(const item of items)mediaDeliveryResult(data,item,true);remove(persist);});
    return true;
  }
  if(result.error_code===429){
    delete saved.__mediaGroupAttempted;
    const seconds=Math.max(1,Math.min(Number(result.parameters?.retry_after) || 5,3600));
    await env.DB.prepare('UPDATE outbox SET params=?,due=unixepoch()+? WHERE id=?').bind(JSON.stringify(saved),seconds,row.id).run();
    return 'retry';
  }
  if([400,403].includes(result.error_code)){
    await mutateState(env,async(data,bot,{persist})=>{
      for(const item of items)mediaDeliveryResult(data,item,false);
      if(!result.snapshotBlocked)await bot.send(items[0].user,`${items.length} files could not be delivered. They have not been marked as received. Use Get new media to try again.`);
      remove(persist);
    });
    return true;
  }
  await uncertain();return true;
}
