export function mediaPreview(file){
  const mime=file.mimeType || file.mime_type || '',filename=(file.filename || file.file_name || '').toLowerCase();
  const image=/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(mime) || /\.(jpe?g|png|webp|gif|bmp|avif)$/.test(filename);
  const video=/^video\/(mp4|webm|quicktime)$/.test(mime) || /\.(mp4|webm|mov)$/.test(filename);
  return file.type==='photo' || image ? 'photo':['video','video_note'].includes(file.type) || video ? 'video':null;
}
export function previewMime(file){
  const mime=file.mimeType || file.mime_type;
  if(['image/jpeg','image/png','image/webp','image/gif','image/bmp','image/avif','video/mp4','video/webm','video/quicktime'].includes(mime))return mime;
  const ext=(file.filename || '').toLowerCase().split('.').pop();
  return {png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif',webm:'video/webm',mov:'video/quicktime'}[ext] || (mediaPreview(file)==='photo'?'image/jpeg':mediaPreview(file)==='video'?'video/mp4':'application/octet-stream');
}
export const mediaMethods={photo:'sendPhoto',video:'sendVideo',document:'sendDocument',audio:'sendAudio',voice:'sendVoice',animation:'sendAnimation',video_note:'sendVideoNote',sticker:'sendSticker'};
export function uploadedMedia(message){
  if(message.photo?.length)return {type:'photo',file:message.photo.at(-1)};
  // Animations may also include a document field; retain their native Telegram type.
  for(const type of ['animation','video','audio','voice','video_note','sticker','document'])if(message[type]?.file_id)return {type,file:message[type]};
  return null;
}
export function mediaPayload(file,chatId,caption=file.caption){
  return {chat_id:chatId,[file.type]:file.fileId,...(!['sticker','video_note'].includes(file.type) && caption ? {caption}: {})};
}
