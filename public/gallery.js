export function setupGallery({ $, api, element, action, go, notice, openTelegram, initData, renderAlbumDetails, confirmMediaAction=async()=>false, refreshAlbums }) {
  let galleryEvent = null;
  let generation=0;
  let popupGeneration=0,qrGeneration=0;
  const urls = new Set();
  const downloads=new Map(),sends=new Map(),waiting=[];
  let activeDownloads=0,mediaController=new AbortController();
  function resetDownloads(){mediaController.abort();mediaController=new AbortController();downloads.clear();}
  const sendStatusText=status=>({sent:'sent',partial:'Batch delivery was incomplete. This file is not confirmed sent; check your chat before retrying.',queued:'Queued for your Telegram chat. Delivery is not confirmed yet.',stopping:'Cancellation is settling. An in-flight file may still arrive.',cancelled:'Delivery cancelled. Files already sent remain in your chat.',failed:'Delivery failed. This file has not been confirmed sent.',unconfirmed:'Delivery could not be confirmed. Check your chat or /refresh before requesting a retry.'}[status] || 'Delivery is not confirmed.');
  function sendFile(id,file,progress){
    const key=`${id}/${file.id}`,current=generation;
    if(sends.has(key))return sends.get(key);
    const task=(async()=>{
      const result=await api(`events/${id}/media/${file.id}/send`,{});
      let status=result.status || (result.queued?'queued':'unconfirmed');if(['queued','stopping'].includes(status))progress?.(status);
      if(!result.request || !['queued','stopping'].includes(status))return {status};
      for(let attempt=0;attempt<20;attempt++){
        if(current!==generation)return {status:'unconfirmed'};
        const checked=await api(`events/${id}/media/${file.id}/delivery-status?request=${encodeURIComponent(result.request)}`);
        status=checked.status || 'unconfirmed';if(['queued','stopping'].includes(status))progress?.(status);
        if(!['queued','stopping'].includes(status))return {status};
        if(attempt<19)await new Promise(resolve=>setTimeout(resolve,2000));
      }
      return {status};
    })().finally(()=>sends.delete(key));
    sends.set(key,task);return task;
  }
  const socialDialogs=new Set(),reactionStates=new Map();
  function closeSocial(){for(const dialog of socialDialogs){dialog.close();dialog.remove();}socialDialogs.clear();reactionStates.clear();bookmarkStates.clear();}
  function socialDialog(title){
    const dialog=document.createElement('dialog'),heading=element('h2',title),content=element('div'),status=element('p','','small muted'),close=action('Close',()=>dialog.close(),'secondary');
    status.setAttribute('role','status');dialog.setAttribute('aria-label',title);dialog.append(heading,content,status,close);document.body.append(dialog);socialDialogs.add(dialog);
    dialog.onclose=()=>{socialDialogs.delete(dialog);dialog.remove();};dialog.showModal();return {dialog,content,status,close};
  }
  function reactions(id,file,parent){
    if(!file.canLike)return;
    const key=id+'/'+file.id;let state=reactionStates.get(key);
    if(!state){state={liked:!!file.liked,count:file.likeCount || 0,busy:false,buttons:[],lists:[]};reactionStates.set(key,state);}
    const like=element('button','','media-like-heart');like.type='button';like.onclick=async()=>{
      if(state.busy)return;state.busy=true;paint();const current=generation;
      try{const result=await api(`events/${id}/media/${file.id}/likes`,{liked:!state.liked});if(current!==generation)return;state.liked=result.liked;state.count=result.count;}
      catch(error){if(current===generation)notice(error.message);}
      finally{state.busy=false;if(current===generation)paint();}
    };
    const list=element('span','','media-like-count');state.buttons.push(like);state.lists.push(list);parent.append(like,list);
    function paint(){for(const button of state.buttons){button.textContent=state.liked?'\u2665':'\u2661';button.disabled=state.busy;button.setAttribute('aria-label',state.liked?'Unlike photo':'Like photo');button.setAttribute('aria-pressed',String(state.liked));}for(const count of state.lists){count.textContent=`${state.count} ${state.count===1?'like':'likes'}`;count.setAttribute('aria-live','polite');}}
    paint();
  }
  const bookmarkStates=new Map();
  function bookmark(id,file,parent){
    const key=id+'/'+file.id;let state=bookmarkStates.get(key);if(!state){state={saved:!!file.isSaved,buttons:[]};bookmarkStates.set(key,state);}
    const button=element('button','','media-save-bookmark');button.type='button';button.setAttribute('aria-haspopup','dialog');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');
    for(const [name,value] of Object.entries({viewBox:'0 0 24 24',width:'20',height:'20','aria-hidden':'true'}))svg.setAttribute(name,value);
    for(const [name,value] of Object.entries({d:'M6 3h12v18l-6-4-6 4V3Z',stroke:'currentColor','stroke-width':'1.8','stroke-linejoin':'round'}))path.setAttribute(name,value);
    svg.append(path);button.append(svg);button.disabled=file.canSave!==true;button.onclick=()=>{if(!button.disabled)return choosePhotoAlbum(id,file,state);};state.buttons.push({button,path});parent.append(button);paintBookmark(state);
  }
  function paintBookmark(state){for(const {button,path} of state.buttons){path.setAttribute('fill',state.saved?'currentColor':'none');button.setAttribute('aria-pressed',String(state.saved));button.setAttribute('aria-label',state.saved?'Saved photo: choose album':'Save photo to album');button.title=state.saved?'Saved in your albums':'Save photo';}}
  async function choosePhotoAlbum(sourceId,file,state){
    const {dialog,content,status,close}=socialDialog('Save photo'),current=generation;
    const select=element('select'),selectLabel=element('label','Album'),createOption=element('option','Create new'),title=element('input'),titleLabel=element('label','New album name'),save=element('button','Save','secondary');
    createOption.value='__new__';select.append(createOption);select.value='__new__';selectLabel.append(select);title.type='text';title.maxLength=100;titleLabel.append(title);save.type='button';
    content.append(selectLabel,titleLabel,element('p','A saved copy follows destination album access. Revoking source access does not recall it.','small muted'));dialog.insertBefore(save,close);
    let busy=false,loading=true,createRequest=null,copyRequest=null;const albums=new Map();
    function paint(){const creating=select.value==='__new__';titleLabel.hidden=!creating;title.hidden=!creating;title.disabled=busy || loading || !creating;select.disabled=busy || loading;save.disabled=busy || loading;close.disabled=busy;}
    function option(album){if(albums.has(album.id))return;albums.set(album.id,album);const node=element('option',album.title+(album.containsPhoto?' (already saved)':''));node.value=album.id;select.append(node);}
    select.onchange=()=>{paint();status.textContent=albums.get(select.value)?.containsPhoto?'This photo is already in that album.':'';};
    dialog.oncancel=event=>{if(busy)event.preventDefault();};paint();
    save.onclick=async()=>{
      if(busy || loading || !dialog.isConnected)return;const creating=select.value==='__new__',name=title.value?.trim() || '';if(creating && !name){status.textContent='Enter an album name.';title.focus?.();return;}
      busy=true;paint();let target=select.value,created=false;
      try{
        if(creating){if(!createRequest || createRequest.title!==name)createRequest={title:name,id:crypto.randomUUID()};status.textContent='Creating private album.';const result=await api('collections',{title:name,personal:true,requestId:createRequest.id});if(!dialog.isConnected || current!==generation)return;target=result.event.id;created=true;option({id:target,title:result.event.title,private:true});select.value=target;paint();}
        if(!copyRequest || copyRequest.target!==target)copyRequest={target,id:crypto.randomUUID()};status.textContent='Saving photo.';
        const result=await api(`albums/${target}/copies`,{sourceEvent:sourceId,mediaId:file.id,requestId:copyRequest.id});if(!dialog.isConnected || current!==generation)return;
        if(result.ids?.length){state.saved=true;paintBookmark(state);const album=albums.get(target);if(album)album.containsPhoto=true;status.textContent=result.added?'Photo saved.':'This photo is already in that album.';}
        else status.textContent='This earlier save was removed. Close and reopen to request a new save.';
        try{await refreshAlbums?.();}catch{notice('Album list could not refresh. The save result above is unchanged.');}
      }catch(error){if(dialog.isConnected)status.textContent=(created?'Album created. Photo save was not confirmed. ':'')+error.message;}
      finally{busy=false;if(dialog.isConnected)paint();}
    };
    try{status.textContent='Loading albums.';const result=await api(`albums/owned?sourceEvent=${encodeURIComponent(sourceId)}&mediaId=${encodeURIComponent(file.id)}`);if(!dialog.isConnected || current!==generation)return;for(const album of result.albums)option(album);state.saved=result.albums.some(album=>album.containsPhoto);paintBookmark(state);loading=false;status.textContent='Choose an album, or create a new one.';paint();}
    catch(error){if(dialog.isConnected){status.textContent=error.message;save.disabled=true;}}
  }

  async function choosePersonalAlbum(sourceId,file=null){
    const {dialog,content,status,close}=socialDialog(file?'Add to personal album':'New personal album'),current=generation;
    const photo=!!file && (file.previewKind==='photo' || file.type==='photo');
    content.append(element('p',file?(photo?'Save this one photo as a copy. People with access to your destination album can view and share it without source access. Revoking the source link will not recall this saved copy.':'This creates a source-dependent link. Source permission and current source access are still required for every viewer.'):'Your personal album starts private. Use album sharing controls when you are ready.','small muted'));
    const select=element('select'),selectLabel=element('label','Your album'),title=element('input'),titleLabel=element('label','New personal album name');title.maxLength=100;title.type='text';titleLabel.append(title);selectLabel.append(select);
    const create=action(file?(photo?'Create album & add photo':'Create album & add item'):'Create private album',createAlbum),add=action(photo?'Add photo':'Add selected media',addMedia);let busy=false,createRequest=null,addRequest=null,addedTarget=null;
    create.onclick=createAlbum;add.onclick=addMedia;
    if(file)content.append(selectLabel);content.append(titleLabel,create);if(file)content.append(add);
    dialog.oncancel=event=>{if(busy)event.preventDefault();};
    function lock(value){busy=value;for(const control of [select,title,create,add,close])control.disabled=value;add.disabled=value || !select.children.length || addedTarget===select.value;}select.onchange=()=>lock(false);
    function option(album){if([...select.children].some(entry=>entry.value===album.id))return;const entry=element('option',album.title+(album.private?' (private)':''));entry.value=album.id;select.append(entry);}
    async function load(){if(!file)return;lock(true);status.textContent='Loading your albums.';try{const result=await api('albums/owned');if(!dialog.isConnected)return;select.replaceChildren();for(const album of result.albums.filter(album=>album.id!==sourceId))option(album);status.textContent=select.children.length?'Choose an album, or create a private one.':'Create a private album first.';}catch(error){status.textContent=error.message;}finally{lock(false);add.disabled=!select.children.length;}}
    async function createAlbum(){
      if(busy)return;const name=title.value.trim();if(!name){status.textContent='Enter an album name.';return;}
      if(!createRequest || createRequest.title!==name)createRequest={title:name,id:crypto.randomUUID()};lock(true);status.textContent='Creating private album.';
      let created=false;try{const result=await api('collections',{title:name,personal:true,requestId:createRequest.id});if(!dialog.isConnected || current!==generation)return;
        if(file){created=true;option({id:result.event.id,title:result.event.title,private:true});select.value=result.event.id;await linkToAlbum(result.event.id);}
        else{await refreshAlbums?.();dialog.close();await openGallery(result.event.id);}
      }catch(error){if(dialog.isConnected)status.textContent=created?'Private album created. Adding this item was not confirmed: '+error.message+' Use Add photo to retry the same request.':error.message;}
      finally{lock(false);}
    }
    async function linkToAlbum(target){
      if(!addRequest || addRequest.target!==target)addRequest={target,id:crypto.randomUUID()};status.textContent=photo?'Adding this photo.':'Adding linked media.';
      const result=await api(`albums/${target}/${photo?'copies':'references'}`,photo?{sourceEvent:sourceId,mediaId:file.id,requestId:addRequest.id}:{sourceEvent:sourceId,mediaIds:[file.id],requestId:addRequest.id});if(!dialog.isConnected || current!==generation)return;
      status.textContent=result.added?(photo?'Photo added to your album. The original is unchanged.':'Linked to your album. The original is unchanged.'):result.ids?.length?(photo?'This photo was already saved. Destination album permissions apply.':'This item was already linked. Source permissions still apply.'):'This earlier request was already handled; removed items stay removed.';addedTarget=target;try{await refreshAlbums?.();}catch{notice('Album list could not refresh. The item result above is unchanged.');}
    }
    async function addMedia(){
      if(busy || !select.value || addedTarget===select.value)return;lock(true);
      try{await linkToAlbum(select.value);}
      catch(error){if(dialog.isConnected)status.textContent=error.message;}
      finally{lock(false);}
    }
    await load();
  }
  async function removeAlbumMedia(id,file,version){
    const message=file.reference?'Remove this linked item from your album? Its original and source album are unchanged. Previously delivered copies cannot be recalled.':file.savedCopy?'Remove this saved photo from your album? Its original source and other saved copies are unchanged. Previously delivered copies cannot be recalled.':'Remove this original item from your album? Older source-dependent links may lose access. Independent saved copies and previously delivered files remain.';
    if(!await confirmMediaAction(message,'album-media-remove'))return;
    await api(`albums/${id}/remove`,{mediaId:file.id,version,confirm:true});await refreshAlbums?.();await openGallery(id);notice(file.reference || file.savedCopy?'Removed from this album. The original source is unchanged.':'Removed from this album. Previously delivered copies remain.');
  }
  function mediaManagement(id,parent,current){
    const panel=element('details','','album-access'),heading=element('summary','Media access & linking'),body=element('div');panel.append(heading,body);parent.append(panel);let busy=false;
    async function load(){
      body.replaceChildren(element('p','Loading media controls.','small muted'));
      try{const data=await api(`albums/${id}/manage`);if(!panel.isConnected || current!==generation)return;body.replaceChildren();
        const label=element('label','','check-option'),toggle=element('input');toggle.type='checkbox';toggle.checked=data.allowMediaReshare;label.append(toggle,element('span','Allow source-dependent linked media'));body.append(label,element('p','This controls source-dependent links, including older photo links. Those viewers still need source access. Turning it off invalidates links created by others; turning it on does not revive them. New saved photo copies follow destination permissions and are not recalled by this switch.','small muted'));
        toggle.onchange=async()=>{if(busy)return;const allowed=toggle.checked;toggle.checked=data.allowMediaReshare;
          if(!await confirmMediaAction(allowed?'Allow source-dependent media links? Those viewers still need source access. Saved photo copies are unaffected.':'Stop source-dependent links and invalidate those created by others? Originals and independent saved photo copies remain.','album-reshare'))return;
          busy=true;toggle.disabled=true;try{await api(`albums/${id}/reshare`,{allowed,version:data.shareVersion,confirm:true});await load();notice('Linking permission updated.');}catch(error){notice(error.message);}finally{busy=false;toggle.disabled=false;}
        };
        body.append(element('h3','People with media access'),element('p','Revoking media access does not change event RSVPs or affect other albums. Existing copies and in-flight requests cannot be recalled.','small muted'));
        if(!data.members.length)body.append(element('p','No joined viewers or contributors yet.','small muted'));
        for(const person of data.members){const row=element('div','','album-danger-row');row.append(element('p',`${person.name} · ${person.blocked?'blocked':person.role} · Telegram ID ${person.id}`));const control=action(person.blocked?'Restore media access':'Revoke media access',async()=>{
          if(busy || !await confirmMediaAction(`${person.blocked?'Restore':'Revoke'} media access for ${person.name} (Telegram ID ${person.id})? ${person.blocked?'A valid link or event access will still be required.':'Their old links will not bypass this block. Other users keep access; event RSVPs are unchanged.'}`,'album-member-access'))return;
          busy=true;control.disabled=true;try{await api(`albums/${id}/members`,{userId:person.id,blocked:!person.blocked,version:data.memberVersion,confirm:true});await load();notice('Media access updated.');}catch(error){notice(error.message);}finally{busy=false;control.disabled=false;}
        },'secondary');row.append(control);body.append(row);}
      }catch(error){if(panel.isConnected)body.replaceChildren(element('p',error.message,'error'));}
    }
    panel.ontoggle=()=>{if(panel.open)load();};
  }

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
    const showing=popupGeneration;
    $('media-send').onclick=async()=>{
      if($('media-send').disabled)return;$('media-send').disabled=true;
      const update=status=>{if(showing===popupGeneration)$('media-popup-status').textContent=sendStatusText(status);};
      try{const result=await sendFile(id,file,update);update(result.status);}catch(error){if(showing===popupGeneration)$('media-popup-status').textContent=error.message+' Delivery is not confirmed; check your chat before trying again.';}finally{if(showing===popupGeneration)$('media-send').disabled=false;}
    };
    $('media-send').disabled=false;
    let social=$('photo-dialog').querySelector?.('.media-reactions');if(social)social.remove();
    if(file.canLike || file.canSave){social=element('div','','event-actions media-reactions');reactions(id,file,social);if(file.canSave)bookmark(id,file,social);$('photo-dialog').append(social);}
    $('photo-dialog').showModal();
  }
  function mediaBlob(eventId, fileId,thumbnail=false) {
    const key=`${generation}/${eventId}/${fileId}/${thumbnail}`,signal=mediaController.signal;
    if(downloads.has(key))return downloads.get(key);
    const task=(async()=>{
      if(activeDownloads>=3)await new Promise(resolve=>waiting.push(resolve));
      activeDownloads++;
      try{
        signal.throwIfAborted();
        const response=await fetch(`/api/events/${eventId}/media/${fileId}${thumbnail?'/thumbnail':''}`,{cache:'no-store',headers:{Authorization:'tma '+initData},signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
        if(!response.ok){const data=await response.json();throw new Error(data.error || 'Could not load this preview. Use Send to Telegram.');}return await response.blob();
      }finally{activeDownloads--;waiting.shift()?.();}
    })().finally(()=>downloads.delete(key));
    downloads.set(key,task);return task;
  }
  async function openGallery(id) {
    closeSocial();if($('photo-dialog').open)$('photo-dialog').close();
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
      if(gallery.socialFeatures){const tools=element('div','','event-actions');tools.append(action('＋ New personal album',()=>choosePersonalAlbum(id)));$('gallery-settings').prepend(tools);$('gallery-settings').hidden=false;
      if(gallery.linkedAccessNote)$('gallery-settings').append(element('p',gallery.linkedAccessNote,'small muted'));
      if(gallery.copySharingNote)$('gallery-settings').append(element('p',gallery.copySharingNote,'small muted'));
      if(gallery.isOwner)mediaManagement(id,$('gallery-settings'),current);}
      $('gallery-title').textContent=gallery.title;$('gallery-summary').textContent=`${gallery.media.length} shared files. Send a file to your Telegram chat.`;
      $('gallery-upload').hidden=!gallery.canUpload;$('gallery-upload').onclick=()=>openTelegram(gallery.uploadUrl);
      $('gallery-copy').hidden=!gallery.galleryUrl;
      $('gallery-copy').onclick=async()=>{try{await navigator.clipboard.writeText(gallery.galleryUrl);notice('Shared media link copied.');}catch{notice('Could not copy. Use Share in the QR code window.');}};
      $('gallery-qr').hidden=!gallery.galleryUrl || gallery.qrEnabled===false;
      $('gallery-qr').onclick=()=>showQr(id,true);
      const list=$('gallery-list');list.replaceChildren();if(!gallery.media.length)list.append(element('p','No files have been shared yet.','muted'));
      if(gallery.canRemove)for(const file of gallery.unavailable || []){const row=element('article','','gallery-item');row.append(element('p','Linked media unavailable: source access or linking permission changed.','small muted'),action('Remove unavailable link',()=>removeAlbumMedia(id,{...file,reference:true},gallery.mediaVersion).catch(error=>notice(error.message)),'secondary'));list.append(row);}
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
        const sendButton=iconAction('✈','Send to Telegram',async()=>{const current=generation,update=status=>{if(current===generation)notice(sendStatusText(status));};try{const result=await sendFile(id,file,update);update(result.status);}catch(error){if(current===generation)notice(error.message+' Delivery is not confirmed; check your chat before trying again.');}});
        buttons.append(sendButton);reactions(id,file,buttons);
        if(gallery.socialFeatures && kind==='photo')bookmark(id,file,buttons);
        if(gallery.socialFeatures && kind!=='photo'){const addToAlbum=iconAction('+','Add to personal album',()=>choosePersonalAlbum(id,file));addToAlbum.setAttribute('aria-label',kind==='photo'?'Add this photo to a personal album':'Add this item to a personal album');addToAlbum.disabled=kind==='photo'?file.canSave!==true:file.canLink!==true;addToAlbum.title=kind==='photo'?'Save this one photo using your current access. The saved copy follows destination album permissions.':file.reference?'Open the original source album to link this item.':'The source owner must allow linking; current source access is still required.';buttons.append(addToAlbum);}
        if(gallery.canRemove)buttons.append(action('Remove from album',()=>removeAlbumMedia(id,file,gallery.mediaVersion).catch(error=>notice(error.message)),'secondary'));
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
      $('qr-dialog').showModal();
    }catch(error){if(pending===qrGeneration)notice(error.message);}
  }
  $('gallery-back').onclick=()=>go('events');$('gallery-refresh').onclick=()=>galleryEvent && openGallery(galleryEvent);
  $('qr-close').onclick=()=>$('qr-dialog').close();$('photo-close').onclick=()=>$('photo-dialog').close();
  $('qr-dialog').onclose=()=>{qrGeneration++;};
  $('photo-dialog').onclose=()=>{ popupGeneration++;$('photo-full').removeAttribute('src');$('video-full').pause(); $('video-full').removeAttribute('src'); $('video-full').load(); };
  function dismissPendingMedia(){
    closeSocial();
    generation++;popupGeneration++;qrGeneration++;
    resetDownloads();
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();
    for(const id of ['photo-dialog','qr-dialog'])if($(id).open)$(id).close();
  }
  return {openGallery,showQr,dismissPendingMedia};
}
