const hub = $('Check Meeting API Readiness').first().json;
const identity = $('Verify Readiness AI Identity').first().json;
const b = $json.body;
const ready = hub.statusCode === 200 && hub.body !== null && typeof hub.body === 'object'
  && Object.keys(hub.body).sort().join(',') === 'ok,ready' && hub.body.ok === true && hub.body.ready === true
  && identity.valid === true && $json.statusCode === 200 && b !== null && typeof b === 'object'
  && Array.isArray(b.value) && b.value.length === 0 && !Object.hasOwn(b, '@odata.nextLink');
return [{json: {ok: ready, ready}}];
