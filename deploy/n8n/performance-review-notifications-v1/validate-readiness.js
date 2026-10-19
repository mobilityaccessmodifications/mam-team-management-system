const b = $json.body;
const keys = b !== null && typeof b === 'object' && !Array.isArray(b) ? Reflect.ownKeys(b) : [];
const ready = $json.statusCode === 200 && keys.length === 2 && keys.includes('version') && keys.includes('ready')
  && b.version === 1 && b.ready === true;
return [{json: {ok: ready, ready}}];
