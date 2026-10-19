const prior = $('Validate Payload').first().json;
const status = $json.statusCode;
const outcome = status === 202 && $json.body === '' ? 'provider_accepted'
  : Number.isInteger(status) && status >= 400 && status < 500 ? 'rejected' : 'unknown';
const finishBody = {...prior.beginBody, phase: 'finish', outcome};
return [{json: {binding: prior.binding, outcome, finishBody}}];
