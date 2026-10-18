import {mediaRole} from './permissions.js';

export function albumMembers(album,preferences,users={}){
  const members=[];
  for(const [uid,preference] of Object.entries(preferences)){
    if(!/^[1-9]\d*$/.test(uid))continue;
    const role=mediaRole(album,Number(uid),preference);
    if(!['viewer','contributor'].includes(role))continue;
    const user=users[uid];
    const name=[user?.firstName,user?.lastName].filter(Boolean).join(' ').trim() || album.media?.find(file=>String(file.by)===uid)?.name || 'Telegram user';
    members.push({name,role});
  }
  return members.sort((a,b)=>a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
}

export async function readAlbumMembers(env,album){
  const {results}=await env.DB.prepare("SELECT p.id,p.data,u.data AS userData FROM records p LEFT JOIN records u ON u.kind='users' AND u.id=p.id WHERE p.kind='preferences' AND json_extract(p.data,?) IS NOT NULL").bind(`$.mediaAccess."${album.id}"`).all();
  const preferences={},users={};
  for(const row of results){preferences[row.id]=JSON.parse(row.data);if(row.userData)users[row.id]=JSON.parse(row.userData);}
  return albumMembers(album,preferences,users);
}
