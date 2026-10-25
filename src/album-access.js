import {randomBytes} from 'node:crypto';
import {InputError} from './time.js';

export function changeAlbumAccess(data,id,album,{action,confirm,version}={}){
  if(album?.kind!=='photos' || album.owner!==id || album.cancelled)throw new InputError('Only the creator can change album sharing.');
  if(confirm!==true || !['disable','regenerate'].includes(action))throw new InputError('Confirm the album sharing action.');
  if(version!==(album.albumAccessVersion || 0))throw new InputError('Album sharing changed. Refresh and confirm again.');
  album.sharingDisabled=action==='disable';
  album.viewToken=randomBytes(16).toString('hex');album.uploadToken=randomBytes(16).toString('hex');
  album.albumAccessVersion=(album.albumAccessVersion || 0)+1;
  album.mediaUpdatedAt=new Date().toISOString();
  for(const preference of Object.values(data.preferences)){
    if(preference.mediaAccess)delete preference.mediaAccess[album.id];
    if(preference.mediaDelivery)delete preference.mediaDelivery[album.id];
  }
  for(const [uid,session] of Object.entries(data.sessions))if(session.event===album.id){
    if(Number(uid)!==album.owner)delete data.sessions[uid];
    else if(session.step==='upload')session.uploadToken=null;
  }
  return album;
}
