const prior = $('Validate Payload').first().json;
const status = $json.statusCode;
const outcome = status === 202 && $json.body === '' ? 'provider_accepted'
  : Number.isInteger(status) && status >= 400 && status < 500 ? 'rejected' : 'unknown';
const finishBody = {phase: 'finish', deliveryId: prior.beginBody.deliveryId, claimToken: prior.beginBody.claimToken, attachmentSha256: prior.beginBody.attachmentSha256, outcome};
return [{json: {binding: prior.binding, outcome, finishBody}}];
