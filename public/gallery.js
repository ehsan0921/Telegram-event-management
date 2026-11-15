export function setupGallery({ $, api, element, action, go, notice, openTelegram, initData, renderAlbumDetails }) {
  let galleryEvent = null;
  let generation=0;
  let popupGeneration=0,qrGeneration=0;
  const urls = new Set();
  const downloads=new Map(),sends=new Map(),waiting=[];
  let activeDownloads=0,mediaController=new AbortController();
  function resetDownloads(){mediaController.abort();mediaController=new AbortController();downloads.clear();}
  function sendFile(id,file){
    const key=`${id}/${file.id}`;
    if(!sends.has(key))sends.set(key,api(`events/${id}/media/${file.id}/send`,{}).finally(()=>sends.delete(key)));
    return sends.get(key);
  }
  const filename = file => file.filename==='photo'?'photo.jpg':file.filename==='video'?'video.mp4':file.filename;
  function iconAction(icon,label,onclick){
    const button=action(label,onclick),symbol=element('span',icon+' ');
    symbol.setAttribute('aria-hidden','true');button.prepend(symbol);return button;
  }
  function showMedia(id,file,blob,url) {
    $('media-uploader').textContent=file.name ? 'Uploaded by '+file.name : '';
    $('media-uploader').hidden=!file.name;
    $('media-caption').textContent=file.caption || '';
    $('media-caption').hidden=!file.caption;
    $('photo-full').hidden=file.type!=='photo'; $('video-full').hidden=file.type!=='video';
    if(file.type==='photo') { $('photo-full').src=url; $('photo-full').alt=file.caption || 'Shared photo'; }
    else { $('video-full').src=url; }
    $('media-popup-status').textContent='';
    $('media-save').onclick=()=>saveBlob(blob,filename(file));
    const showing=popupGeneration;
    $('media-send').onclick=async()=>{ if($('media-send').disabled)return;$('media-send').disabled=true; try { await sendFile(id,file); if(showing===popupGeneration)$('media-popup-status').textContent='Queued for your Telegram chat. Please wait for delivery.'; } catch(error) { if(showing===popupGeneration)$('media-popup-status').textContent=error.message; } finally { if(showing===popupGeneration)$('media-send').disabled=false; } };
    $('media-send').disabled=false;
    $('photo-dialog').showModal();
  }
  async function saveBlob(blob, filename) {
    // An already-open preview has the bytes ready during the user's gesture,
    // which lets supported iPhone/Android webviews open their native save/share UI.
    if(typeof navigator!=='undefined' && typeof File!=='undefined' && navigator.canShare && navigator.share){
      const files=[new File([blob],filename,{type:blob.type})];
      if(navigator.canShare({files}))try{await navigator.share({files});return;}catch(error){if(error.name==='AbortError')return;}
    }
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=filename;document.body?.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    notice('Download opened. If your phone does not offer Save, use Send to Telegram and save from the chat.');
  }
  function mediaBlob(eventId, fileId,thumbnail=false) {
    const key=`${generation}/${eventId}/${fileId}/${thumbnail}`,signal=mediaController.signal;
    if(downloads.has(key))return downloads.get(key);
    const task=(async()=>{
      if(activeDownloads>=3)await new Promise(resolve=>waiting.push(resolve));
      activeDownloads++;
      try{
        signal.throwIfAborted();
        const response=await fetch(`/api/events/${eventId}/media/${fileId}${thumbnail?'/thumbnail':''}`,{headers:{Authorization:'tma '+initData},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
        if(!response.ok){const data=await response.json();throw new Error(data.error || 'Could not download this file.');}return await response.blob();
      }finally{activeDownloads--;waiting.shift()?.();}
    })().finally(()=>downloads.delete(key));
    downloads.set(key,task);return task;
  }
  async function openGallery(id) {
    const current=++generation;
    resetDownloads();
    galleryEvent=id;go('gallery');$('gallery-error').hidden=true;
    $('gallery-settings').replaceChildren();$('gallery-settings').hidden=true;
    $('gallery-title').textContent='Shared media';$('gallery-summary').textContent='Loading files…';
    $('gallery-upload').hidden=true;$('gallery-upload').onclick=null;
    for(const name of ['gallery-copy','gallery-qr']){$(name).hidden=true;$(name).onclick=null;}
    $('gallery-list').replaceChildren(element('p','Loading files…','muted'));
    for(const url of urls) URL.revokeObjectURL(url);urls.clear();
    try {
      const gallery=await api(`events/${id}/gallery`);if(current!==generation)return;
      renderAlbumDetails?.(id,$('gallery-settings'));
      $('gallery-title').textContent=gallery.title;$('gallery-summary').textContent=`${gallery.media.length} shared files. Download here or send a file to your Telegram chat.`;
      $('gallery-upload').hidden=!gallery.canUpload;$('gallery-upload').onclick=()=>openTelegram(gallery.uploadUrl);
      $('gallery-copy').hidden=!gallery.galleryUrl;
      $('gallery-copy').onclick=async()=>{try{await navigator.clipboard.writeText(gallery.galleryUrl);notice('Shared media link copied.');}catch{notice('Could not copy. Use Share in the QR code window.');}};
      $('gallery-qr').hidden=!gallery.galleryUrl || gallery.qrEnabled===false;
      $('gallery-qr').onclick=()=>showQr(id,true);
      const list=$('gallery-list');list.replaceChildren();if(!gallery.media.length)list.append(element('p','No files have been shared yet.','muted'));
      const sortedMedia=gallery.media.map((file,index)=>({file,index})).sort((a,b)=>(Date.parse(b.file.at) || 0)-(Date.parse(a.file.at) || 0) || b.index-a.index).map(item=>item.file);
      for(const file of sortedMedia) {
        const kind=file.previewKind || (['photo','video'].includes(file.type)?file.type:null),previewFile={...file,type:kind};
        const card=element('article','','gallery-item');const body=element('div','','gallery-item-body');
        if(kind==='photo' || (kind==='video' && file.hasThumbnail)) {
          const img=document.createElement('img');img.alt=file.caption || `${kind==='video'?'Video preview':'Photo'}${file.name?' shared by '+file.name:''}`;card.append(img);
          const load=previewLoader(card,img,current,async()=>{const blob=await mediaBlob(id,file.id,file.hasThumbnail);if(!img.isConnected || current!==generation)return;const url=URL.createObjectURL(blob);urls.add(url);img.src=url;img.onclick=async()=>{const pending=++popupGeneration;try{const full=file.hasThumbnail?await mediaBlob(id,file.id):blob;if(!img.isConnected || current!==generation || pending!==popupGeneration)return;const fullUrl=file.hasThumbnail?URL.createObjectURL(full):url;urls.add(fullUrl);showMedia(id,previewFile,full,fullUrl);}catch(error){if(current===generation && pending===popupGeneration)notice(error.message);}};});
          const observer=new IntersectionObserver(entries=>{if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();return load();});observer.observe(card);
        }else if(kind==='video'){
          const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='metadata';video.setAttribute('aria-label',file.caption || 'Video preview');card.append(video);
          const load=previewLoader(card,video,current,async()=>{const blob=await mediaBlob(id,file.id);if(!video.isConnected || current!==generation)return;const url=URL.createObjectURL(blob);urls.add(url);video.src=url;video.onclick=()=>{if(current!==generation)return;++popupGeneration;showMedia(id,previewFile,blob,url);};});
          const observer=new IntersectionObserver(entries=>{if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();return load();});observer.observe(card);
        }
        body.append(element('strong',file.filename==='photo'?'Photo':file.filename),element('p',[file.name?'Shared by '+file.name:'',file.caption].filter(Boolean).join('\n'),'small muted'));
        const buttons=element('div','','event-actions');
        const downloadButton=iconAction('⬇','Download',async()=>{if(downloadButton.disabled)return;downloadButton.disabled=true;try{await saveBlob(await mediaBlob(id,file.id),filename(file));}catch(error){notice(error.message);}finally{downloadButton.disabled=false;}});
        const sendButton=iconAction('✈','Send to Telegram',async()=>{if(sendButton.disabled)return;sendButton.disabled=true;try{await sendFile(id,file);notice('Queued for your Telegram chat. Please wait for delivery.');}catch(error){notice(error.message);}finally{sendButton.disabled=false;}});
        buttons.append(downloadButton,sendButton);
        if(kind==='video')buttons.append(iconAction('▶','Play video',async()=>{const pending=++popupGeneration;try{const blob=await mediaBlob(id,file.id);if(current!==generation || pending!==popupGeneration)return;const url=URL.createObjectURL(blob);urls.add(url);showMedia(id,previewFile,blob,url);}catch(error){if(current===generation && pending===popupGeneration)notice(error.message);}}));
        body.append(buttons);card.append(body);list.append(card);
      }
    }catch(error){if(current!==generation)return;$('gallery-list').replaceChildren();$('gallery-summary').textContent='';$('gallery-error').textContent=error.message;$('gallery-error').hidden=false;}
  }
  function previewLoader(card,preview,current,fetchPreview){
    const status=element('div','','media-preview-status'),spinner=element('span','','media-spinner'),label=element('p','Loading preview…','small muted');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');spinner.setAttribute('aria-hidden','true');
    const retry=action('↻ Refresh preview',()=>load());retry.hidden=true;
    status.append(spinner,label,retry);card.prepend(status);preview.hidden=true;
    let loading=false;
    const valid=()=>current===generation && preview.isConnected;
    const failed=()=>{if(!valid())return;loading=false;preview.hidden=true;status.hidden=false;spinner.hidden=true;label.textContent='Could not load this preview. Tap Refresh to try again.';retry.hidden=false;retry.disabled=false;};
    const ready=()=>{if(!valid())return;loading=false;status.hidden=true;preview.hidden=false;retry.disabled=false;};
    preview.onload=ready;preview.onloadeddata=()=>{ready();if(preview.tagName==='VIDEO')try{preview.currentTime=.1;}catch{}};preview.onerror=failed;
    async function load(){
      if(loading || !valid())return;loading=true;retry.disabled=true;retry.hidden=true;spinner.hidden=false;label.textContent='Loading preview…';status.hidden=false;preview.hidden=true;
      try{await fetchPreview();}catch{failed();}
    }
    return load;
  }
  async function showQr(id,shared=false) {
    const pending=++qrGeneration;
    try{const qr=await api(`events/${id}/${shared?'gallery-qr':'upload-qr'}`);if(pending!==qrGeneration)return;$('upload-qr').src=qr.image;
      $('qr-title').textContent=shared?'Shared media QR code':'Upload link & QR code';
      $('upload-qr').alt=shared?'QR code for shared media':'QR code for event uploads';
      $('qr-share').textContent=shared?'Share shared media link':'Share upload link';
      const shareIcon=element('span','✈ ');shareIcon.setAttribute('aria-hidden','true');$('qr-share').prepend(shareIcon);
      $('qr-description').textContent=shared?'Scan to open Shared media. Event access and viewing permissions still apply.':qr.anyone ? 'Anyone with this link can add media without an RSVP. They can view Shared media if you enable viewing. Private event details stay hidden.' : 'Existing event guests can scan this code to add media. Enable uploads by link in event settings to let anyone contribute without an RSVP.';
      $('qr-share').onclick=()=>openTelegram(`https://t.me/share/url?url=${encodeURIComponent(qr.link)}&text=${encodeURIComponent('Share your event photos and files')}`);
      $('qr-download').onclick=()=>{const bytes=Uint8Array.from(atob(qr.image.split(',')[1]),character=>character.charCodeAt(0));saveBlob(new Blob([bytes],{type:'image/gif'}),'event-upload-qr.gif');};$('qr-dialog').showModal();
    }catch(error){if(pending===qrGeneration)notice(error.message);}
  }
  $('gallery-back').onclick=()=>go('events');$('gallery-refresh').onclick=()=>galleryEvent && openGallery(galleryEvent);
  $('qr-close').onclick=()=>$('qr-dialog').close();$('photo-close').onclick=()=>$('photo-dialog').close();
  $('qr-dialog').onclose=()=>{qrGeneration++;};
  $('photo-dialog').onclose=()=>{ popupGeneration++;$('video-full').pause(); $('video-full').removeAttribute('src'); $('video-full').load(); };
  function dismissPendingMedia(){
    generation++;popupGeneration++;qrGeneration++;
    resetDownloads();
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();
    for(const id of ['photo-dialog','qr-dialog'])if($(id).open)$(id).close();
  }
  return {openGallery,showQr,dismissPendingMedia};
}
