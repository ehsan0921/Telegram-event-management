import {mediaCan,mediaRole,mediaRevoked,showsUploaders} from './permissions.js';
import {isManager} from './cohosts.js';
import {invitationAvailable} from './invitations.js';

export function canViewMedia(data,event,id){
  if(!event || event.cancelled || mediaRevoked(event,id))return false;
  const pref=data.preferences[id] || {};
  return !!((isManager(event,id) || event.guests?.[id] && invitationAvailable(event,id) || mediaRole(event,id,pref)) && mediaCan(event,id,'viewMedia',pref));
}
export const referenceKey=file=>file?.reference?JSON.stringify([file.reference.event,file.reference.media,file.reference.accessVersion,file.reference.policyVersion]):null;
export function resolveMedia(data,album,file,id){
  if(!file || !canViewMedia(data,album,id))return null;
  if(!file.reference)return {...file,canonicalEvent:album.id,canonicalMedia:file.id};
  const ref=file.reference,source=data.events[ref.event],original=source?.media?.find(item=>item.id===ref.media);
  if(!original || original.reference || !canViewMedia(data,source,id) || !canViewMedia(data,source,album.owner))return null;
  if(ref.accessVersion!==(source.albumAccessVersion || 0))return null;
  if(source.owner!==album.owner && (source.allowMediaReshare!==true || ref.policyVersion!==(source.mediaReshareVersion || 0)))return null;
  return {...original,id:file.id,reference:ref,at:file.at || original.at,name:showsUploaders(source)?original.name:null,canonicalEvent:source.id,canonicalMedia:original.id};
}
export const visibleMedia=(data,album,id)=>(album?.media || []).map(file=>resolveMedia(data,album,file,id)).filter(Boolean);
export function mayLinkMedia(data,source,file,id){
  return !!(file && !file.reference && canViewMedia(data,source,id) && (source.owner===id || source.allowMediaReshare===true));
}
export async function readMediaGraph(env,album,id,pref){
  const data={events:{[album.id]:album},preferences:{[id]:pref || {}}};
  const sources=[...new Set((album.media || []).map(file=>file.reference?.event).filter(value=>/^[a-f0-9]{16}$/.test(value)))];
  if(!sources.length)return data;
  const users=album.owner===id?[]:[String(album.owner)];
  const {results}=await env.DB.prepare("SELECT kind,id,data FROM records WHERE (kind='events' AND id IN (SELECT value FROM json_each(?))) OR (kind='preferences' AND id IN (SELECT value FROM json_each(?)))").bind(JSON.stringify(sources),JSON.stringify(users)).all();
  for(const row of results)data[row.kind][row.id]=JSON.parse(row.data);
  return data;
}
