export const permissionLabels = { guestList: 'See other guests', uploadMedia: 'Send photos, videos & files', viewMedia: 'See shared media' };
export function permissions(event) {
  return Object.fromEntries(Object.keys(permissionLabels).map(key => [key, event.permissions?.[key] === true]));
}
export function can(event, userId, key) { return event.owner === userId || permissions(event)[key]; }
export function guests(event) { return Object.entries(event.guests).filter(([id]) => Number(id) !== event.owner).map(([, guest]) => guest); }
export function confirmed(event, guest) { return guest?.status === 'yes' && (!event.requireApproval || guest.approval === 'approved'); }
export function canSeeLocation(event, userId) { return event.owner === userId || (!(event.hideLocation || event.requireApproval) || confirmed(event, event.guests[userId])); }
export function responsesClosed(event, now = Date.now()) { return !!event.responseDeadline && new Date(event.responseDeadline).getTime() <= now; }
export function responseCounts(event) {
  const list = guests(event);
  return { yes: list.filter(g => confirmed(event, g)).length, pending: list.filter(g => g.status === 'yes' && !confirmed(event, g)).length, no: list.filter(g => g.status === 'no').length, maybe: list.filter(g => g.status === 'maybe').length, later: list.filter(g => g.status === 'later').length };
}
