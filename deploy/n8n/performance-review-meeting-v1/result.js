const b = $json.body;
const ok = $json.statusCode === 200 && b !== null && typeof b === 'object' && !Array.isArray(b)
  && Object.keys(b).sort().join(',') === 'ok,status' && b.ok === true
  && ['imported','already_imported','skipped'].includes(b.status);
return {json: {ok, status: ok ? b.status : 'unavailable'}};
