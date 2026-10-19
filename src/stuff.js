import {isManager} from './cohosts.js';
import {invitationAvailable} from './invitations.js';
import {responsesClosed,mediaRole} from './permissions.js';
import {eventGroup} from './reminders.js';
import {InputError} from './time.js';

export function visibleStuff(event,id,preference={}){
  if(isManager(event,id))return true;
  if(event.kind==='photos')return !!mediaRole(event,id,preference);
  return !preference.hiddenEvents?.[event.id] && !!event.guests[id] && invitationAvailable(event,id);
}

export function leaveAlbum(data,id,album){
  if(album?.kind!=='photos' || isManager(album,id))throw new InputError('Only guests can leave a media album. Owners can delete it.');
  const preference=data.preferences[id];
  if(preference?.mediaAccess)delete preference.mediaAccess[album.id];
  if(data.sessions[id]?.event===album.id)delete data.sessions[id];
}

export async function removeInvitation(bot,id,event,{notify=false,version}={}){
  if(!event || event.kind==='photos' || isManager(event,id) || !event.guests[id] || !invitationAvailable(event,id))throw new InputError('Only an invited guest can remove their invitation.');
  const guest=event.guests[id];
  if(notify && !event.cancelled && eventGroup(event)!=='Past events' && guest.status!=='no'){
    if(version!==(guest.responseVersion || 0))throw new InputError('Your RSVP changed. Refresh and confirm again.');
    if(['reported','processing','paid','refund_pending','refund_failed'].includes(guest.payment?.status))throw new InputError('Contact the organiser or payment support before cancelling this booking. You can still remove it from My stuff without changing your RSVP.');
    if(event.checkIns?.[guest.ticket])throw new InputError('You are already checked in. Contact the organiser to change your RSVP.');
    if(responsesClosed(event))throw new InputError('The response deadline has passed. Contact the organiser to cancel your RSVP.');
    await bot.saveResponse(id,event,{...guest,status:'no'});
    if(event.guests[id]?.status!=='no')throw new InputError('Your RSVP could not be cancelled. Refresh and try again.');
  }
  bot.db.preferences[id] ||= {};
  bot.db.preferences[id].hiddenEvents ||= {};
  bot.db.preferences[id].hiddenEvents[event.id]=true;
  if(event.reminders)delete event.reminders[id];
  event.reminderOverrides ||= {};event.reminderOverrides[id]=true;
  if(bot.db.sessions[id]?.event===event.id)bot.session(id);
}
