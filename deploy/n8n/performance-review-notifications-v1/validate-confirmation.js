const prior = $('Validate Notification Payload').first().json;
const b = $json.body;
const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const provider = value => closed(value, ['accepted','messageId','requestId','statusCode'])
  && value.accepted === true && value.messageId === null && value.requestId === null && value.statusCode === 202;
const valid = $json.statusCode === 200 && closed(b, ['ok','sent','alreadySent','eventKey','actualRecipient','actualCcRecipients','providerReceipt'])
  && b.ok === true && b.sent === true && b.alreadySent === false && b.eventKey === prior.eventKey
  && b.actualRecipient === prior.recipient && b.actualCcRecipients === prior.cc && provider(b.providerReceipt);
return [{json: valid ? {ok: true, sent: true, alreadySent: false, eventKey: prior.eventKey,
  actualRecipient: prior.recipient, actualCcRecipients: prior.cc, providerReceipt: {accepted: true, messageId: null, requestId: null, statusCode: 202}}
  : {ok: false, sent: false, alreadySent: false}}];
