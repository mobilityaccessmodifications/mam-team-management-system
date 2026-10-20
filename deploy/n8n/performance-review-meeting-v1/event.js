function safeNext(href, initial) {
  const base = 'https://graph.microsoft.com/v1.0/me/events?';
  const params = value => {
    if (typeof value !== 'string' || value.length > 16384 || !value.startsWith(base) || /[\s\u0000-\u001f\u007f#]/.test(value)) return null;
    const result = {};
    try {
      for (const part of value.slice(base.length).split('&')) {
        const equal = part.indexOf('=');
        if (equal < 1) return null;
        const decode = v => decodeURIComponent(v.replace(/\+/g, ' '));
        const key = decode(part.slice(0, equal)), entry = decode(part.slice(equal + 1));
        if (!['$filter','$select','$top','$skip','$skiptoken'].includes(key) || Object.hasOwn(result, key)
          || !entry || /[\u0000-\u001f\u007f]/.test(entry)) return null;
        result[key] = entry;
      }
    } catch {return null;}
    return result;
  };
  const expected = params(initial), actual = params(href);
  if (!expected || !actual || Object.keys(expected).length !== 3 || Object.keys(actual).length !== 4
    || !['$filter','$select','$top'].every(key => expected[key] && actual[key] === expected[key])) return false;
  return Object.hasOwn(actual, '$skip') ? /^[0-9]{1,12}$/.test(actual.$skip)
    : typeof actual.$skiptoken === 'string' && actual.$skiptoken.length <= 12000;
}

const reject = () => ({json: {valid: false}});
const parse = (pending, rows) => {
const tokens = value => typeof value === 'string' ? [...value.matchAll(/(?:^|[^A-Za-z0-9_-])(PR-[0-9]{4}-[1-9][0-9]*)(?=$|[^A-Za-z0-9_-])/g)].map(match => match[1]) : [];
const candidates = rows.filter(event => tokens(event?.subject).includes(pending.reviewCode));
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
};
const inputs = $input.all(), queries = $('Prepare Calendar Queries').all();
if (!Array.isArray(inputs) || inputs.length > 50 || !Array.isArray(queries) || queries.length > 10) return [];
const groups = new Map();
for (let index = 0; index < inputs.length; index++) {
  const item = inputs[index], pair = item.pairedItem;
  if (!pair || Array.isArray(pair) || !Number.isInteger(pair.item) || pair.item < 0 || pair.item >= queries.length) return [];
  if (!groups.has(pair.item)) groups.set(pair.item, []);
  groups.get(pair.item).push({item, index});
}
return [...groups].map(([queryIndex, pages]) => {
  const query = queries[queryIndex].json, rows = [], nextLinks = new Set(), ids = new Set();
  const result = value => ({...value, pairedItem: {item: pages[0].index}});
  if (!query || !query.request || pages.length > 5) return result(reject());
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index].item.json, b = page.body;
    if (page.statusCode !== 200 || b === null || typeof b !== 'object' || !Array.isArray(b.value) || b.value.length > 50) return result(reject());
    if (index === pages.length - 1) {
      if (Object.hasOwn(b, '@odata.nextLink')) return result(reject());
    } else {
      const next = b['@odata.nextLink'];
      if (!safeNext(next, query.queryUrl) || nextLinks.has(next)) return result(reject());
      nextLinks.add(next);
    }
    for (const event of b.value) {
      if (!event || typeof event !== 'object' || typeof event.id !== 'string' || ids.has(event.id)) return result(reject());
      ids.add(event.id); rows.push(event);
    }
  }
  return result(parse(query.request, rows));
});
