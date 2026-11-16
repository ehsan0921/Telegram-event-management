import {mediaPreview} from './media-preview.js';

// Only independent stored media counts as saved. Legacy source-dependent
// references retain their existing behavior and are never silently converted.
export const photoIdentity=file=>file && !file.reference && mediaPreview(file)==='photo' && typeof file.fileId==='string' && file.fileId?file.fileId:null;
export async function ownedPhotoAlbums(env,id){
  const {results}=await env.DB.prepare("SELECT data FROM records WHERE kind='events' AND json_extract(data,'$.owner')=? AND json_extract(data,'$.kind')='photos'").bind(id).all();
  return results.map(row=>JSON.parse(row.data)).filter(album=>!album.cancelled);
}
export const hasPhoto=(album,file)=>{const identity=photoIdentity(file);return !!identity && album.media?.some(item=>photoIdentity(item)===identity);};
