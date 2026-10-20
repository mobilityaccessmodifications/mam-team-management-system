const accepted = $json.statusCode === 202 && $json.body === '';
if (!accepted) return [{json: {accepted: false}}];
const prior = $('Validate Notification Payload').first().json;
const reserved = $('Gate Notification Reservation').first().json;
return [{json: {accepted: true, confirmBody: {action: 'confirm', eventKey: prior.eventKey, recipient: prior.recipient,
  cc: prior.cc, deliveryToken: reserved.deliveryToken,
  providerReceipt: {accepted: true, messageId: null, requestId: null, statusCode: 202}}}}];
