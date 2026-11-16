import {readMediaGraph,resolveMedia,visibleMedia,mayLinkMedia} from './media-reference.js';
import {galleryLikes,likeIdentity} from './album-social.js';
import qrcode from 'qrcode-generator';
import {mediaPreview,previewMime} from './media-preview.js';
import {mediaCan,mediaRole,photoLinks,showsUploaders,shareUploadLink} from './permissions.js';
import { mutateState } from './worker-store.js';
import {isManager} from './cohosts.js';
import {invitationAvailable} from './invitations.js';
import {queueMedia,deliveryStatus,resumeMediaForExplicitRequest} from './media-delivery.js';


export async function mediaApi(request, env, user) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/events\/([a-f0-9]{16})\/(gallery|gallery-qr|upload-qr|media\/([a-f0-9]{12})(?:\/(send|thumbnail|delivery-status))?)$/);
  if (!match) return null;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const json = (value, status = 200) => Response.json(value, { status, headers });
  const row = await env.DB.prepare("SELECT data FROM records WHERE kind='events' AND id=?").bind(match[1]).first();
  const e = row && JSON.parse(row.data);
  const preference = await env.DB.prepare("SELECT data FROM records WHERE kind='preferences' AND id=?").bind(String(user.id)).first();
  const pref=preference ? JSON.parse(preference.data) : {};
  const grant = !!mediaRole(e,user.id,pref);
  if (!e || (!isManager(e,user.id) && !(e.guests[user.id] && invitationAvailable(e,user.id)) && !grant)) return json({ error: 'Open a valid event or media link first.' }, 403);
  if (match[2] === 'upload-qr') {
    if (request.method !== 'GET' || !isManager(e,user.id)) return json({ error: 'Only an organiser can view the upload QR code.' }, 403);
    if (e.qrEnabled === false) return json({ error: 'QR codes are disabled for this event.' }, 400);
    const link = shareUploadLink(e, env.BOT_USERNAME);
    if (!link) return json({ error: 'Enable guest uploads first.' }, 400);
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    return json({ link, anyone: !!e.allowLinkUploads, image: qr.createDataURL(6, 24) });
  }
  if (!mediaCan(e, user.id, 'viewMedia',pref)) return json({ error: 'The organiser has not enabled the gallery for guests.' }, 403);
  const galleryUrl=e.kind==='photos' ? photoLinks(e,env.BOT_USERNAME)?.viewer : `https://t.me/${env.BOT_USERNAME}?startapp=gallery_${e.id}`;
  if(match[2]==='gallery-qr' && request.method==='GET'){
    if(!galleryUrl)return json({error:'Album sharing is disabled.'},400);
    if(e.qrEnabled===false)return json({error:'QR codes are disabled for this event.'},400);
    const qr=qrcode(0,'M');qr.addData(galleryUrl);qr.make();
    return json({link:galleryUrl,image:qr.createDataURL(6,24)});
  }
  const graph=await readMediaGraph(env,e,user.id,pref);
  if (match[2] === 'gallery' && request.method === 'GET'){
    const files=visibleMedia(graph,e,user.id),likes=await galleryLikes(env,files,user.id),shown=new Set(files.map(file=>file.id)),owned=await ownedPhotoAlbums(env,user.id),saved=new Set(owned.flatMap(album=>(album.media || []).map(photoIdentity).filter(Boolean)));
    return json({socialFeatures:env.ALBUM_SOCIAL_ENABLED!=='false',id:e.id,title:e.title,galleryUrl,qrEnabled:e.qrEnabled!==false,cancelled:!!e.cancelled,isOwner:e.owner===user.id,canRemove:env.ALBUM_SOCIAL_ENABLED!=='false' && e.owner===user.id && e.kind==='photos',mediaVersion:e.mediaEditVersion || 0,canUpload:!e.cancelled && mediaCan(e,user.id,'uploadMedia',pref),uploadUrl:`https://t.me/${env.BOT_USERNAME}?start=a_${e.id}`,
      copySharingNote:'People who can view a photo can save and share it from their own album. Revoking a source link does not recall existing saved copies.',
      linkedAccessNote:(e.media || []).some(file=>file.reference)?'Older linked items still require current source access. New saved photo copies follow this album’s access.':null,
      unavailable:e.owner===user.id?(e.media || []).filter(file=>file.reference && !shown.has(file.id)).map(file=>({id:file.id})):[],
      media:files.map(file=>({id:file.id,type:file.type,previewKind:mediaPreview(file),hasThumbnail:!!file.thumbnail,filename:file.filename,caption:file.caption,name:showsUploaders(e)?file.name:null,at:file.at,size:file.size || null,reference:!!file.reference,savedCopy:!!file.savedFrom,isSaved:saved.has(file.fileId),canSave:env.ALBUM_SOCIAL_ENABLED!=='false' && mediaPreview(file)==='photo',canLink:mayLinkMedia(graph,e,e.media.find(item=>item.id===file.id),user.id),canLike:env.ALBUM_SOCIAL_ENABLED!=='false' && mediaPreview(file)==='photo',...(likes.get(likeIdentity(file)) || {likeCount:0,liked:false})}))});
  }
  const rawFile=e.media?.find(item=>item.id===match[3]);
  const f=resolveMedia(graph,e,rawFile,user.id);
  if(rawFile && !f)return json({error:'This media is unavailable. Source access or linking permission changed.'},403);
  if (!f) return json({ error: 'This file is no longer in the event.' }, 404);
  if(match[4]==='delivery-status' && request.method==='GET'){
    const reference=url.searchParams.get('request');
    if(!/^[a-f0-9]{16}$/.test(reference || ''))return json({error:'A valid delivery request reference is required.'},400);
    return json({status:deliveryStatus(pref.mediaDelivery?.[e.id],f.id,reference)});
  }
  if (match[4] === 'send' && request.method === 'POST') {
    if(e.cancelled)return json({error:'This event is no longer available for media delivery.'},409);
    const queued=await mutateState(env, async (data, bot) => {
      const current = data.events[e.id];
      if (!bot.mediaAllowed(current, user.id) || !bot.mediaCan(current, user.id, 'viewMedia')) return {denied:true};
      const file=resolveMedia(data,current,current.media.find(item=>item.id===f.id),user.id);if(!file)return {denied:true};
      let state=bot.db.preferences[user.id]?.mediaDelivery?.[current.id];
      if(state?.uncertain?.[file.id] && state.pending[file.id]===state.uncertain[file.id])return {queued:false,alreadyQueued:true,request:state.pending[file.id],status:deliveryStatus(state,file.id,state.pending[file.id])};
      resumeMediaForExplicitRequest(bot,user.id);
      const started=await queueMedia(bot,user.id,current,file);
      state=bot.db.preferences[user.id]?.mediaDelivery?.[current.id];
      const reference=state?.pending?.[file.id] || state?.results?.[file.id]?.token;
      return {queued:true,alreadyQueued:!started,request:reference,status:deliveryStatus(state,file.id,reference)};
    });
    if(queued.denied)return json({error:'Media access changed. Refresh the album.'},403);
    return json(queued);
  }
  if (request.method !== 'GET' || (match[4] && match[4]!=='thumbnail')) return json({ error: 'Not found.' }, 404);
  const thumbnail=match[4]==='thumbnail';if(thumbnail && !f.thumbnail)return json({error:'No thumbnail.'},404);
  if (!thumbnail && f.size > 20 * 1024 * 1024) return json({ error: 'This file is larger than 20 MB. Use Send to Telegram to download it in chat.' }, 413);
  const lookup = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: thumbnail ? f.thumbnail:f.fileId }), signal: AbortSignal.timeout(10000) });
  const result = await lookup.json();
  if (!result.ok || !result.result?.file_path) return json({ error: 'Could not load the file. Use Send to Telegram instead.' }, 502);
  const download = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${result.result.file_path}`, { signal: AbortSignal.timeout(15000) });
  if (!download.ok) return json({ error: 'Could not load this file. Try again.' }, 502);
  const mime=thumbnail || f.type==='photo' ? 'image/jpeg':previewMime(f);
  return new Response(download.body, { headers: { ...headers, 'Content-Type': mime, ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.filename === 'photo' ? 'photo.jpg' : f.filename === 'video' ? 'video.mp4' : f.filename)}` } : {}) } });
}
import {ownedPhotoAlbums,photoIdentity} from './photo-saved-state.js';
