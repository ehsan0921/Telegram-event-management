export function setupGallery({ $, api, element, action, go, notice, openTelegram, initData, renderAlbumDetails }) {
  let galleryEvent = null;
  let generation=0;
  let popupGeneration=0,qrGeneration=0;
  const urls = new Set();
  const filename = file => file.filename==='photo'?'photo.jpg':file.filename==='video'?'video.mp4':file.filename;
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
    $('media-send').onclick=async()=>{ $('media-send').disabled=true; try { await api(`events/${id}/media/${file.id}/send`,{}); if(showing===popupGeneration)$('media-popup-status').textContent='Sent to your Telegram chat.'; } catch(error) { if(showing===popupGeneration)$('media-popup-status').textContent=error.message; } finally { $('media-send').disabled=false; } };
    $('photo-dialog').showModal();
  }
  function saveBlob(blob, filename) { const url=URL.createObjectURL(blob); const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000); }
  async function mediaBlob(eventId, fileId,thumbnail=false) {
    const response=await fetch(`/api/events/${eventId}/media/${fileId}${thumbnail?'/thumbnail':''}`,{headers:{Authorization:'tma '+initData},signal:AbortSignal.timeout(30000)});
    if(!response.ok){const data=await response.json();throw new Error(data.error || 'Could not download this file.');}return response.blob();
  }
  async function openGallery(id) {
    const current=++generation;
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
        buttons.append(action('Download',async()=>{try{saveBlob(await mediaBlob(id,file.id),file.filename==='photo'?'photo.jpg':file.filename==='video'?'video.mp4':file.filename);}catch(error){notice(error.message);}}));
        buttons.append(action('Send to Telegram',async()=>{try{await api(`events/${id}/media/${file.id}/send`,{});notice('File sent to your Telegram chat.');}catch(error){notice(error.message);}}));
        if(kind==='video')buttons.append(action('Play video',async()=>{const pending=++popupGeneration;try{const blob=await mediaBlob(id,file.id);if(current!==generation || pending!==popupGeneration)return;const url=URL.createObjectURL(blob);urls.add(url);showMedia(id,previewFile,blob,url);}catch(error){if(current===generation && pending===popupGeneration)notice(error.message);}}));
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
    for(const id of ['photo-dialog','qr-dialog'])if($(id).open)$(id).close();
  }
  return {openGallery,showQr,dismissPendingMedia};
}
