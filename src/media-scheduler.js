import {prepareMediaGroup,deliverMediaGroup} from './media-group.js';
import {mediaDeliveryResult,clearResolvedMediaHold,mediaDeliveryPayload} from './media-delivery.js';
import {mutateMediaState,BusyError} from './worker-store.js';

const userSql="coalesce(json_extract(o.params,'$.__mediaGroup[0].user'),json_extract(o.params,'$.__mediaDelivery.user'))";
const tracked="(json_type(o.params,'$.__mediaGroup') IS NOT NULL OR json_type(o.params,'$.__mediaDelivery') IS NOT NULL)";
const nowDefault=()=>Date.now(),waitDefault=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function record(env,kind,id){const row=await env.DB.prepare('SELECT data FROM records WHERE kind=? AND id=?').bind(kind,String(id)).first();return row?JSON.parse(row.data):{};}
async function defer(env,id,until){await env.DB.prepare('UPDATE outbox SET due=? WHERE id=?').bind(Math.ceil(until/1000),id).run();}

export async function mediaBackoff(env,chat,seconds,now=Date.now()){
  const until=now+Math.max(1,Math.min(Number(seconds) || 5,3600))*1000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_budget','global',json_object('until',?)) ON CONFLICT(kind,id) DO UPDATE SET data=json_set(records.data,'$.until',max(coalesce(json_extract(records.data,'$.until'),0),?))").bind(until,until),
    env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_chat_state',?,json_object('nextAt',?)) ON CONFLICT(kind,id) DO UPDATE SET data=json_set(records.data,'$.nextAt',max(coalesce(json_extract(records.data,'$.nextAt'),0),?))").bind(String(chat),until,until)
  ]);
}

// One admission coordinator, at most three independent chat lanes per round.
// Appointments are durable and 500ms apart globally (at most ten files each).
// Each chat waits at least one second between appointments. Never hold state
// mutation ownership during a Telegram call or a pacing wait.
export async function drainMediaRound(env,owner,telegram,afterBatch,{now=nowDefault,wait=waitDefault,budgetMs=8000}={}){
  const deadline=now()+Math.max(0,Math.min(budgetMs,24000));if(budgetMs<=0)return false;
  let worked=false;
  const select=()=>env.DB.prepare(`WITH heads AS (SELECT min(o.rowid) AS rid,${userSql} AS chat FROM outbox o WHERE ${tracked} GROUP BY chat)
    SELECT o.*,h.chat FROM heads h JOIN outbox o ON o.rowid=h.rid
    LEFT JOIN records s ON s.kind='media_chat_state' AND s.id=CAST(h.chat AS TEXT) LEFT JOIN records l ON l.kind='media_chat_lease' AND l.id=CAST(h.chat AS TEXT)
    WHERE o.due<=? AND max(coalesce(json_extract(s.data,'$.nextAt'),0),coalesce(json_extract(s.data,'$.emitAt'),0),coalesce(json_extract(l.data,'$.expires'),0))<=? AND (coalesce(json_extract(s.data,'$.blocked'),0)=0 OR json_type(o.params,'$.__mediaGroupDelivered') IS NOT NULL OR json_type(o.params,'$.__mediaDelivered') IS NOT NULL)
    ORDER BY coalesce(json_extract(s.data,'$.lastServed'),0),o.rowid LIMIT 3`).bind(Math.floor(now()/1000),now()).all();
  async function serve(head,holder){
    const chat=String(head.chat);
    let row;const selectedAt=now();
    try{
      const recorded=JSON.parse(head.params);
      if(recorded.__mediaGroupDelivered || recorded.__mediaDelivered){
        row=await env.DB.prepare('UPDATE outbox SET due=?,attempts=attempts+1 WHERE id=? AND due<=? RETURNING *').bind(Math.ceil((now()+120000)/1000),head.id,Math.floor(now()/1000)).first();if(!row)return;
        if(recorded.__mediaGroupDelivered)await deliverMediaGroup(env,row,()=>{throw Error('Recorded receipt cannot invoke Telegram');});
        else await mutateMediaState(env,[recorded.__mediaDelivery],(data,_bot,{persist})=>{mediaDeliveryResult(data,recorded.__mediaDelivery,true);clearResolvedMediaHold(data,recorded.__mediaDelivery.user,persist);persist('DELETE FROM outbox WHERE id=?',row.id);});
        await afterBatch(Number(chat));return;
      }
      const budget=await env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_budget','global',json_object('startAt',?,'nextAt',?,'until',0)) ON CONFLICT(kind,id) DO UPDATE SET data=json_set(records.data,'$.startAt',max(coalesce(json_extract(records.data,'$.nextAt'),0),?),'$.nextAt',max(coalesce(json_extract(records.data,'$.nextAt'),0),?)+500) WHERE coalesce(json_extract(records.data,'$.until'),0)<=? RETURNING data").bind(now(),now()+500,now(),now(),now()).first();
      if(!budget){const pause=await record(env,'media_budget','global');await defer(env,head.id,Math.max(now()+1000,pause.until || 0));return;}
      const appointment=JSON.parse(budget.data).startAt;
      // No remote API call is made while waiting. Cancel is rechecked below.
      if(appointment-now()>2500){await defer(env,head.id,appointment);return;}
      await env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_chat_state',?,json_object('lastServed',0,'nextAt',?)) ON CONFLICT(kind,id) DO UPDATE SET data=json_set(records.data,'$.nextAt',?)").bind(chat,appointment+1000,appointment+1000).run();
      row=await env.DB.prepare('UPDATE outbox SET due=?,attempts=attempts+1 WHERE id=? AND due<=? RETURNING *').bind(Math.ceil((now()+120000)/1000),head.id,Math.floor(now()/1000)).first();
      if(!row)return;
      if(appointment>now())await wait(appointment-now());
      const pause=await record(env,'media_budget','global');
      if(pause.until>now()){await defer(env,row.id,pause.until);return;}
      const valid=await env.DB.prepare("SELECT id FROM records WHERE kind='media_chat_lease' AND id=? AND json_extract(data,'$.owner')=? AND json_extract(data,'$.expires')>?").bind(chat,holder,now()+15000).first();
      const coordinator=await env.DB.prepare('UPDATE delivery_lease SET expires=unixepoch()+60 WHERE owner=? AND expires>unixepoch() RETURNING owner').bind(owner).first();
      if(!valid || !coordinator){await defer(env,row.id,now()+1000);return;}
      const grouped=await prepareMediaGroup(env,row);
      if(grouped==='deferred')return;
      // Old persisted single-file receipts are committed without resending.
      if(!grouped){const saved=JSON.parse(row.params);if(!saved.__mediaDelivered || !saved.__mediaDelivery)throw Error('Unexpected tracked delivery shape');await mutateMediaState(env,[saved.__mediaDelivery],(data,_bot,{persist})=>{mediaDeliveryResult(data,saved.__mediaDelivery,true);clearResolvedMediaHold(data,saved.__mediaDelivery.user,persist);persist('DELETE FROM outbox WHERE id=?',row.id);});await afterBatch(Number(chat));return;}
      await deliverMediaGroup(env,row,async(env,method,params)=>{
        let admitted=false;
        for(let turn=0;turn<40 && now()<deadline;turn++){
          const [localState,globalState]=await Promise.all([record(env,'media_chat_state',chat),record(env,'media_budget','global')]);
          if(localState.blocked || globalState.until>now())return {ok:false,error_code:429,parameters:{retry_after:Math.max(1,Math.ceil(((globalState.until || now()+1000)-now())/1000))},schedulerDeferred:true};
          const until=Math.max(localState.emitAt || 0,globalState.emitAt || 0);
          if(until>now()){await wait(Math.min(200,until-now()));continue;}
          const current=await env.DB.prepare("SELECT id FROM records WHERE kind='media_chat_lease' AND id=? AND json_extract(data,'$.owner')=? AND json_extract(data,'$.expires')>?").bind(chat,holder,now()+15000).first();
          const admission=await env.DB.prepare('UPDATE delivery_lease SET expires=unixepoch()+60 WHERE owner=? AND expires>unixepoch() RETURNING owner').bind(owner).first();
          if(!current || !admission)return {ok:false,error_code:429,parameters:{retry_after:1},schedulerDeferred:true};
          const global=await env.DB.prepare("UPDATE records SET data=json_set(data,'$.emitAt',?) WHERE kind='media_budget' AND id='global' AND coalesce(json_extract(data,'$.emitAt'),0)<=? AND coalesce(json_extract(data,'$.until'),0)<=? RETURNING id").bind(now()+500,now(),now()).first();
          if(!global){await wait(50);continue;}
          const local=await env.DB.prepare("UPDATE records SET data=json_set(data,'$.emitAt',?,'$.lastServed',?) WHERE kind='media_chat_state' AND id=? AND coalesce(json_extract(data,'$.emitAt'),0)<=? AND coalesce(json_extract(data,'$.blocked'),0)=0 RETURNING id").bind(now()+1000,now(),chat,now()).first();
          if(!local)return {ok:false,error_code:429,parameters:{retry_after:1},schedulerDeferred:true};
          // Cancel/access may have changed during the pacing wait. A known local
          // deferral is safe to retry; it has not invoked Telegram at all.
          const currentRow=await env.DB.prepare('SELECT params FROM outbox WHERE id=?').bind(row.id).first(),items=currentRow && JSON.parse(currentRow.params).__mediaGroup;
          const allowed=items && await mutateMediaState(env,items,(_data,bot)=>items.every(item=>!!mediaDeliveryPayload(bot,item)));
          if(!allowed)return {ok:false,error_code:429,parameters:{retry_after:1},schedulerDeferred:true};
          admitted=true;break;
        }
        if(!admitted || now()>=deadline)return {ok:false,error_code:429,parameters:{retry_after:1},schedulerDeferred:true};
        const transportAt=now();console.log(JSON.stringify({event:'media_scheduler_admitted',method,files:params.media?.length || 1,admissionMs:transportAt-selectedAt}));
        const result=await telegram(env,method,params);
        console.log(JSON.stringify({event:'media_transport_result',method,files:params.media?.length || 1,ok:!!result.ok,code:result.error_code || null,elapsedMs:now()-transportAt}));
        if(result.error_code===429)await mediaBackoff(env,chat,result.parameters?.retry_after,now());
        return result;
      });
      await afterBatch(Number(chat));
    }catch(error){
      if(row && error instanceof BusyError){await defer(env,row.id,now()+1000);return;}
      throw error;
    }finally{await env.DB.prepare("DELETE FROM records WHERE kind='media_chat_lease' AND id=? AND json_extract(data,'$.owner')=?").bind(chat,holder).run();}
  }
  async function lane(){
    for(let turns=0;turns<100 && now()<deadline;turns++){
      const ready=await select();let selected;
      for(const head of ready.results){
        const holder=crypto.randomUUID(),chat=String(head.chat);
        const lease=await env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('media_chat_lease',?,json_object('owner',?,'expires',?)) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE json_extract(records.data,'$.expires')<? RETURNING id").bind(chat,holder,now()+120000,now()).first();
        if(lease){selected={head,holder};break;}
      }
      if(selected){worked=true;await serve(selected.head,selected.holder);continue;}
      const due=await nextMediaTime(env);
      if(due && due<=now()+1200 && now()+200<deadline){await wait(200);continue;}
      return;
    }
  }
  // Each lane takes the next fair eligible chat as soon as its own call settles;
  // it does not wait for a slow chat in another lane to finish a whole round.
  const results=await Promise.allSettled(Array.from({length:3},()=>lane()));
  const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
  return worked;
}
export async function nextMediaTime(env){
  const result=await env.DB.prepare(`WITH heads AS (SELECT min(o.rowid) AS rid,${userSql} AS chat FROM outbox o WHERE ${tracked} GROUP BY chat)
    SELECT min(max(o.due*1000,coalesce(json_extract(s.data,'$.nextAt'),0),coalesce(json_extract(s.data,'$.emitAt'),0),coalesce(json_extract(l.data,'$.expires'),0))) AS due FROM heads h JOIN outbox o ON o.rowid=h.rid LEFT JOIN records s ON s.kind='media_chat_state' AND s.id=CAST(h.chat AS TEXT) LEFT JOIN records l ON l.kind='media_chat_lease' AND l.id=CAST(h.chat AS TEXT) WHERE (coalesce(json_extract(s.data,'$.blocked'),0)=0 OR json_type(o.params,'$.__mediaGroupDelivered') IS NOT NULL OR json_type(o.params,'$.__mediaDelivered') IS NOT NULL)`).first();
  return result?.due;
}
