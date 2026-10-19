const b = $json.body;
const keys = b && typeof b === 'object' && !Array.isArray(b) ? Reflect.ownKeys(b) : [];
const ready = $json.statusCode === 200 && keys.length === 2 && keys.includes('ok') && keys.includes('ready') && b.ok === true && b.ready === true;
return [{json: {ok: ready, ready}}];
