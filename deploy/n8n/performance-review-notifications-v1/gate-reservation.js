const prior = $('Validate Notification Payload').first().json;
const b = $json.body;
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const provider = value => closed(value, ['accepted','messageId','requestId','statusCode'])
  && value.accepted === true && value.messageId === null && value.requestId === null && value.statusCode === 202;
const allowed = $json.statusCode === 200 && closed(b, ['outcome','eventKey','deliveryToken'])
  && b.outcome === 'send' && b.eventKey === prior.eventKey && typeof b.deliveryToken === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.deliveryToken);
const duplicate = $json.statusCode === 200 && closed(b, ['outcome','ok','sent','alreadySent','eventKey','actualRecipient','actualCcRecipients','providerReceipt'])
  && b.outcome === 'duplicate' && b.ok === true && b.sent === false && b.alreadySent === true
  && b.eventKey === prior.eventKey && b.actualRecipient === prior.recipient && b.actualCcRecipients === prior.cc && provider(b.providerReceipt);
const response = duplicate ? {ok: true, sent: false, alreadySent: true, eventKey: prior.eventKey,
  actualRecipient: prior.recipient, actualCcRecipients: prior.cc, providerReceipt: {accepted: true, messageId: null, requestId: null, statusCode: 202}}
  : {ok: false, sent: false, alreadySent: false};
return [{json: {allowed, deliveryToken: allowed ? b.deliveryToken : null, response}}];
