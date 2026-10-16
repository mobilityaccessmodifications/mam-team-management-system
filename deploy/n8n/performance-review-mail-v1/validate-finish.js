const prior = $('Classify Send').first().json;
const b = $json.body;
const keys = b && typeof b === 'object' && !Array.isArray(b) ? Reflect.ownKeys(b) : [];
const recorded = $json.statusCode === 200 && keys.length === 2 && keys.includes('ok') && keys.includes('recorded') && b.ok === true && b.recorded === true;
const accepted = recorded && prior.outcome === 'provider_accepted';
return [{json: {ok: accepted, status: accepted ? 'provider_accepted' : 'held', ...prior.binding}}];
