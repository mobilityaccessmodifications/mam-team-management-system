const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({ id, name, type, typeVersion, position, parameters, ...extra });
const validator = `const p = $input.first().json.body ?? $input.first().json;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
const normal = value => typeof value === 'string' && email.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
const work = normal(p?.workEmail);
const personal = normal(p?.personalEmail);
const recipients = [...new Set([work,personal].filter(Boolean))];
const login = normal(p?.login);
const valid = p?.version === 1 && uuid.test(p?.deliveryId) && login && recipients.includes(login)
  && Array.isArray(p?.recipients) && JSON.stringify(p.recipients) === JSON.stringify(recipients)
  && typeof p?.temporaryPassword === 'string' && p.temporaryPassword.length >= 20 && p.temporaryPassword.length <= 128;
return [{ json: valid ? { valid: true, deliveryId: p.deliveryId, login, temporaryPassword: p.temporaryPassword,
  actualRecipient: [...recipients].sort().join(','), toRecipient: work ?? personal, bccRecipient: work && personal && work !== personal ? personal : '' }
  : { valid: false, deliveryId: 'invalid', code: 'invalid_payload' } }];`;
const emailCode = `const source = $input.first().json;
const escape = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot',"'":'&#39;'}[char]));
return [{ json: { ...source, subject: 'Your MAM/Equipsy portal login', bodyContent: '<p>Your login: ' + escape(source.login) + '</p><p>Temporary password: ' + escape(source.temporaryPassword) + '</p><p>Change your password after signing in.</p>' } }];`;
export function buildOnboardingCredentialWorkflow({ webhookCredential, receiptCredential = { id: 'tGtpwegru8OxtdCt', name: 'MAM Team Management - Notification Webhook Header' } } = {}) {
  if (!webhookCredential?.id || !webhookCredential?.name) throw new Error('Verified webhook credential required');
  if (!receiptCredential?.id || !receiptCredential?.name) throw new Error('Verified receipt credential required');
  const receiptUrl = 'https://mam-team-management-system-ten.vercel.app/api/internal/integrations/notifications/receipts';
  const receiptOptions = { redirect: { redirect: { followRedirects: false } }, timeout: 10000,
    response: { response: { responseFormat: 'json', neverError: false, fullResponse: false } } };
  const receiptNode = (id, name, position, body) => node(id, name, 'n8n-nodes-base.httpRequest', 4.2, position, {
    method: 'POST', url: receiptUrl, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body, options: receiptOptions,
  }, { credentials: { httpHeaderAuth: receiptCredential } });
  const nodes = [
    node('c1000000-0000-4000-8000-000000000001', 'Receive Credential Request', 'n8n-nodes-base.webhook', 2.1, [-600,0], {
      authentication: 'headerAuth', httpMethod: 'POST', path: 'mam-people-hub-onboarding-credentials-v1', responseMode: 'lastNode', options: {},
    }, { webhookId: 'c1000000-0000-4000-8000-000000000001', ...(webhookCredential ? { credentials: { httpHeaderAuth: webhookCredential } } : {}) }),
    node('c1000000-0000-4000-8000-000000000002', 'Validate Credential Request', 'n8n-nodes-base.code', 2, [-400,0], { mode: 'runOnceForAllItems', jsCode: validator }),
    node('c1000000-0000-4000-8000-000000000003', 'Valid Credential Request?', 'n8n-nodes-base.if', 2.2, [-200,0], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c1000000-0000-4000-8000-000000000103', leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    receiptNode('c1000000-0000-4000-8000-000000000008', 'Reserve Credential Delivery', [0,-80],
      "={{ { action: 'reserve', eventKey: 'onboarding-credential:' + $json.deliveryId, recipient: $json.actualRecipient, cc: '', legacyEventKey: null } }}"),
    node('c1000000-0000-4000-8000-000000000009', 'Gate Credential Reservation', 'n8n-nodes-base.code', 2, [180,-80], { jsCode: `const context = $('Validate Credential Request').first().json;
const receipt = $input.first().json;
const token = receipt?.deliveryToken;
const send = receipt?.outcome === 'send' && receipt.eventKey === 'onboarding-credential:' + context.deliveryId
  && typeof token === 'string' && /^[0-9a-f-]{36}$/i.test(token);
return [{ json: send ? { ...context, deliveryToken: token, shouldSend: true }
  : { deliveryId: context.deliveryId, shouldSend: false, code: 'reservation_rejected' } }];` }),
    node('c1000000-0000-4000-8000-000000000010', 'Send Credential?', 'n8n-nodes-base.if', 2.2, [380,-80], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c1000000-0000-4000-8000-000000000110', leftValue: '={{ $json.shouldSend }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c1000000-0000-4000-8000-000000000004', 'Build Credential Email', 'n8n-nodes-base.code', 2, [580,-120], { mode: 'runOnceForAllItems', jsCode: emailCode }),
    node('c1000000-0000-4000-8000-000000000005', 'Send Credential Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [220,-80], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.toRecipient }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', bccRecipients: '={{ $json.bccRecipient }}', saveToSentItems: false },
    }, { credentials: { microsoftOutlookOAuth2Api: { id: 'vFEolsXoEOOxNyan', name: 'Microsoft Outlook account - hr@mobilityaccess.com.au' } } }),
    node('c1000000-0000-4000-8000-000000000011', 'Build Provider Receipt', 'n8n-nodes-base.code', 2, [900,-120], { jsCode: `const context = $('Build Credential Email').first().json;
const provider = $input.first().json;
const messageId = typeof provider?.id === 'string' && provider.id.length > 0 && provider.id.length <= 1024 ? provider.id : null;
if (!messageId) throw new Error('Provider identity unavailable');
return [{ json: { action: 'confirm', eventKey: 'onboarding-credential:' + context.deliveryId,
  recipient: context.actualRecipient, cc: '', deliveryToken: context.deliveryToken,
  providerReceipt: { accepted: true, messageId, requestId: null, statusCode: 202 } } }];` }),
    receiptNode('c1000000-0000-4000-8000-000000000012', 'Confirm Credential Delivery', [1120,-120], '={{ $json }}'),
    node('c1000000-0000-4000-8000-000000000006', 'Acknowledge Credential Email', 'n8n-nodes-base.code', 2, [1340,-120], {
      jsCode: `const context = $('Build Credential Email').first().json;
const receipt = $input.first().json;
const valid = receipt?.ok === true && receipt?.sent === true && receipt?.alreadySent === false
  && receipt?.eventKey === 'onboarding-credential:' + context.deliveryId
  && receipt?.actualRecipient === context.actualRecipient && receipt?.actualCcRecipients === ''
  && receipt?.providerReceipt?.accepted === true;
return [{ json: { ok: valid, sent: valid, deliveryId: context.deliveryId } }];`,
    }),
    node('c1000000-0000-4000-8000-000000000007', 'Reject Credential Request', 'n8n-nodes-base.code', 2, [0,100], { jsCode: "return [{ json: { ok: false, code: 'invalid_payload' } }];" }),
  ];
  const edge = (name) => ({ node: name, type: 'main', index: 0 });
  return {
    name: 'MAM People Hub - Onboarding Credentials (Live)', nodes,
    connections: {
      'Receive Credential Request': { main: [[edge('Validate Credential Request')]] },
      'Validate Credential Request': { main: [[edge('Valid Credential Request?')]] },
      'Valid Credential Request?': { main: [[edge('Reserve Credential Delivery')], [edge('Reject Credential Request')]] },
      'Reserve Credential Delivery': { main: [[edge('Gate Credential Reservation')]] },
      'Gate Credential Reservation': { main: [[edge('Send Credential?')]] },
      'Send Credential?': { main: [[edge('Build Credential Email')], [edge('Reject Credential Request')]] },
      'Build Credential Email': { main: [[edge('Send Credential Email from HR')]] },
      'Send Credential Email from HR': { main: [[edge('Build Provider Receipt')]] },
      'Build Provider Receipt': { main: [[edge('Confirm Credential Delivery')]] },
      'Confirm Credential Delivery': { main: [[edge('Acknowledge Credential Email')]] },
    },
    settings: { executionOrder: 'v1', timezone: 'Australia/Melbourne', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveExecutionProgress: false },
  };
}
