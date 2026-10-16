const previous = $('Validate Payload').first().json;
const b = $json.body;
const keys = b && typeof b === 'object' && !Array.isArray(b) ? Reflect.ownKeys(b) : [];
const allowed = $json.statusCode === 200 && keys.length === 2 && keys.includes('ok') && keys.includes('allowed') && b.ok === true && b.allowed === true;
return [{json: {allowed, binding: previous.binding}}];
