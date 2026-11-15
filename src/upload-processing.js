import {uploadedMedia} from './media-preview.js';
import {BusyError} from './worker-store.js';

export const uploadWaitMessage='⏳ Finish uploads received. Your photos and files are being saved. Please wait for confirmation before sending more files or choosing another action. Saving will retry automatically if needed; Refresh checks the saved count.';
export const isUploadFinish=update=>/^(?:✅ Finish uploads|\/done(?:@\w+)?(?:\s.*)?)$/.test(update.message?.text?.trim() || '');
const read=async(env,kind,id)=>{
  const row=await env.DB.prepare('SELECT data FROM records WHERE kind=? AND id=?').bind(kind,String(id)).first();
  return row ? JSON.parse(row.data) : null;
};

// These coordination records are outside the event-state lease. Register ingress
// before waiting for that lease, so a finish cannot overtake a failed media save.
// No photo contents or Telegram file identifiers are stored here.
export async function registerUpload(env,update,user,sendReceipt){
  if(!user || user.is_bot || !Number.isSafeInteger(update.update_id))return null;
  if(update.pre_checkout_query || update.message?.successful_payment || update.message?.refunded_payment)return null;
  const id=String(user.id),finish=isUploadFinish(update);
  const media=update.message?.chat?.type==='private' && uploadedMedia(update.message);
  if(!finish && !media)return {id,finish,media,callback:update.callback_query,updateId:update.update_id};
  if(await env.DB.prepare('SELECT id FROM processed WHERE id=?').bind(update.update_id).first())return null;
  if(media){
    await env.DB.prepare("INSERT INTO records(kind,id,data) SELECT 'upload_pending',?,json_object('user',?,'batch',coalesce(json_extract(data,'$.uploadBatch'),'legacy:'||json_extract(data,'$.event'))) FROM records WHERE kind='sessions' AND id=? AND json_extract(data,'$.step')='upload' AND NOT EXISTS (SELECT id FROM processed WHERE id=?) ON CONFLICT(kind,id) DO NOTHING").bind(String(update.update_id),id,id,update.update_id).run();
  }
  const session=await read(env,'sessions',id);
  let job=await read(env,'upload_finish',id);
  if(finish && session?.step==='upload'){
    const batch=session.uploadBatch || `legacy:${session.event}`;
    const value={batch,event:session.event,updateId:update.update_id,closed:false};
    await env.DB.prepare("INSERT INTO records(kind,id,data) VALUES ('upload_finish',?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE json_extract(records.data,'$.batch')<>json_extract(excluded.data,'$.batch')").bind(id,JSON.stringify(value)).run();
    job=await read(env,'upload_finish',id);
  }
  if(finish && job && !job.closed){
    // Claim once before network I/O. A timeout has an uncertain delivery outcome;
    // repeating sendMessage could duplicate the receipt. The durable completion
    // remains a separate, retryable outbox operation.
    const claim=await env.DB.prepare("UPDATE records SET data=json_set(data,'$.receiptClaimed',1) WHERE kind='upload_finish' AND id=? AND json_extract(data,'$.receiptClaimed') IS NULL RETURNING id").bind(id).first();
    if(claim){
      const receipt=await sendReceipt(user.id,uploadWaitMessage);
      if(receipt?.ok && receipt.result?.message_id){
        await env.DB.prepare("UPDATE records SET data=json_set(data,'$.receipt',json(?)) WHERE kind='upload_finish' AND id=? AND json_extract(data,'$.updateId')=?").bind(JSON.stringify(receipt.result),id,job.updateId).run();
      }
    }
    job=await read(env,'upload_finish',id);
  }
  return {id,finish,media,job,callback:update.callback_query,updateId:update.update_id};
}

export async function guardUpload(env,context,bot,persist){
  if(!context)return false;
  const {id,finish,media,updateId}=context;
  if(media)persist("DELETE FROM records WHERE kind='upload_pending' AND id=?",String(updateId));
  // Re-read under the state lease: another ingress may have registered Finish.
  const job=await read(env,'upload_finish',id);
  if(job && !job.closed){
    if(finish){
      const pending=await env.DB.prepare("SELECT id FROM records WHERE kind='upload_pending' AND json_extract(data,'$.user')=? AND json_extract(data,'$.batch')=? AND CAST(id AS INTEGER)<? LIMIT 1").bind(id,job.batch,job.updateId).first();
      if(pending)throw new BusyError('Uploads are still being saved.');
      bot.uploadReceipt=job.receipt;
      persist("UPDATE records SET data=json_set(data,'$.closed',1) WHERE kind='upload_finish' AND id=?",id);
    }else if(updateId>job.updateId || !media){
      if(context.callback?.data?.startsWith('upload-status')){
        await bot.api('answerCallbackQuery',{callback_query_id:context.callback.id});
        const count=bot.db.events[job.event]?.media?.filter(file=>file.by===Number(id)).length || 0;
        await bot.send(Number(id),`⏳ Uploads are still being saved. ${count} of your files are currently saved in this collection. Please wait for confirmation; saving will retry automatically.`);
        return true;
      }
      await bot.send(Number(id),'⏳ Your uploads are still being saved. Please wait for confirmation before choosing another action. Any files sent after Finish uploads must be sent again using Add media.');
      return true;
    }
  }else if(finish && job && bot.db.sessions[id]?.step!=='upload'){
    // A second Finish message is not a second completion operation.
    return true;
  }
  return false;
}
