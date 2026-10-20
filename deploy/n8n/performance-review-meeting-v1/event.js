const reject = () => ({json: {valid: false}});
const pending = $('Prepare Calendar Queries').item.json.request;
const b = $json.body;
if ($json.statusCode !== 200 || b === null || typeof b !== 'object' || !Array.isArray(b.value)
  || Object.hasOwn(b, '@odata.nextLink') || b.value.length > 25) return reject();
const tokens = value => typeof value === 'string' ? [...value.matchAll(/(?:^|[^A-Za-z0-9_-])(PR-[0-9]{4}-[1-9][0-9]*)(?=$|[^A-Za-z0-9_-])/g)].map(match => match[1]) : [];
const candidates = b.value.filter(event => tokens(event?.subject).includes(pending.reviewCode));
if (candidates.length !== 1) return reject();
const e = candidates[0], found = tokens(e.subject);
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
if (found.length !== 1 || found[0] !== pending.reviewCode || !bounded(e.subject, 1024)
  || !bounded(e.id, 1024) || !bounded(e.iCalUId, 1024) || e.type !== 'singleInstance' || e.recurrence !== null
  || e.isOrganizer !== (pending.managerEmail === 'ai@mobilityaccess.com.au') || e.isCancelled !== false || e.isAllDay !== false || e.isDraft !== false
  || e.organizer?.emailAddress?.address?.toLowerCase() !== pending.managerEmail || !Array.isArray(e.attendees)) return reject();
const attendees = e.attendees.map(value => value?.emailAddress?.address?.toLowerCase());
const email = value => typeof value === 'string' && value.length <= 254 && value === value.trim().toLowerCase()
  && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
if (attendees.length < 1 || attendees.length > 32 || new Set(attendees).size !== attendees.length || attendees.some(value => !email(value))
  || !attendees.includes('ai@mobilityaccess.com.au') || !attendees.includes(pending.employeeEmail)) return reject();
const instant = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,19) === value.slice(0,19) ? date : null;
};
const minute = value => value?.timeZone === 'UTC' && typeof value.dateTime === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0{1,7})?Z?$/.test(value.dateTime)
  ? instant(value.dateTime.replace(/Z$/, '') + 'Z') : null;
const start = minute(e.start), end = minute(e.end), created = instant(e.createdDateTime), modified = instant(e.lastModifiedDateTime);
if (!start || !end || !created || !modified || created.getTime() < Date.parse(pending.requestedAt)
  || modified < created || (end - start) < 5 * 60000 || (end - start) > 480 * 60000) return reject();
let mode, location;
if (e.isOnlineMeeting === true) {
  mode = 'teams'; location = e.onlineMeeting?.joinUrl;
  if (e.onlineMeetingProvider !== 'teamsForBusiness' || !bounded(location, 8000)
    || !/^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\//.test(location)) return reject();
} else if (e.isOnlineMeeting === false) {
  mode = 'in_person'; location = e.location?.displayName;
  if (e.onlineMeeting?.joinUrl || !bounded(location, 8000) || !location.trim()) return reject();
} else return reject();
return {json: {valid: true, importBody: {requestToken: pending.requestToken, expectedRevision: pending.expectedRevision, event: {
  id: e.id, uid: e.iCalUId, subject: e.subject, organizer: pending.managerEmail, attendees: [...attendees].sort(),
  start: start.toISOString().slice(0,19) + 'Z', end: end.toISOString().slice(0,19) + 'Z',
  createdAt: created.toISOString(), modifiedAt: modified.toISOString(), mode, location,
  isCancelled: false, isAllDay: false, type: 'singleInstance',
}}}};
