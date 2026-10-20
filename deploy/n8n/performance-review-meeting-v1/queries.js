const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const b = $json.body;
if ($json.statusCode !== 200 || !closed(b, ['ok','requests']) || b.ok !== true
  || !Array.isArray(b.requests) || b.requests.length > 1000) return [];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const email = value => typeof value === 'string' && value.length <= 254 && value === value.trim().toLowerCase()
  && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const seen = new Set();
for (const p of b.requests) {
  if (!closed(p, ['requestToken','reviewId','reviewCode','expectedRevision','requestedAt','managerEmail','employeeEmail'])
    || !uuid(p.requestToken) || !uuid(p.reviewId) || seen.has(p.requestToken)
    || typeof p.reviewCode !== 'string' || !/^PR-[0-9]{4}-[1-9][0-9]*$/.test(p.reviewCode) || p.reviewCode.length > 64
    || typeof p.expectedRevision !== 'string' || !/^manager:(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(p.expectedRevision)
    || !timestamp(p.requestedAt) || !email(p.managerEmail) || !email(p.employeeEmail)
    || p.managerEmail === p.employeeEmail) return [];
  seen.add(p.requestToken);
}
if (!b.requests.length) return [];
const requests = [...b.requests].sort((a,b) => a.requestToken < b.requestToken ? -1 : a.requestToken > b.requestToken ? 1 : 0);
const offset = (Math.floor(Date.now() / 300000) * 10) % requests.length;
const fields = 'id,subject,type,isOrganizer,organizer,attendees,start,end,isCancelled,isAllDay,isDraft,isOnlineMeeting,onlineMeeting,onlineMeetingProvider,location,iCalUId,lastModifiedDateTime,createdDateTime,recurrence';
return Array.from({length: Math.min(10, requests.length)}, (_, index) => {
  const request = requests[(offset + index) % requests.length];
  const contains = code => "contains(subject,'" + code + "')";
  const filter = contains(request.reviewCode) + ' and not(' + Array.from({length: 10}, (_, digit) => contains(request.reviewCode + digit)).join(' or ') + ')';
  const queryUrl = 'https://graph.microsoft.com/v1.0/me/events?$filter='
    + encodeURIComponent(filter) + '&$select=' + fields + '&$top=25';
  return {json: {request, queryUrl}, pairedItem: {item: 0}};
});
