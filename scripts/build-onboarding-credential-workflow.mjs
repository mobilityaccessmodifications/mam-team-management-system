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
return [{ json: valid ? { valid: true, deliveryId: p.deliveryId, login, temporaryPassword: p.temporaryPassword, actualRecipient: recipients.join(',') }
  : { valid: false, deliveryId: 'invalid', code: 'invalid_payload' } }];`;
const emailCode = `const source = $input.first().json;
const escape = value => String(value).replace(/[&<>\"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot',"'":'&#39;'}[char]));
return [{ json: { ...source, subject: 'Your MAM/Equipsy portal login', bodyContent: '<p>Your login: ' + escape(source.login) + '</p><p>Temporary password: ' + escape(source.temporaryPassword) + '</p><p>Change your password after signing in.</p>' } }];`;
export function buildOnboardingCredentialWorkflow({ webhookCredential } = {}) {
  const nodes = [
    node('c1000000-0000-4000-8000-000000000001', 'Receive Credential Request', 'n8n-nodes-base.webhook', 2.1, [-600,0], {
      authentication: 'headerAuth', httpMethod: 'POST', path: 'mam-people-hub-onboarding-credentials-v1', responseMode: 'lastNode', options: {},
    }, { webhookId: 'c1000000-0000-4000-8000-000000000001', ...(webhookCredential ? { credentials: { httpHeaderAuth: webhookCredential } } : {}) }),
    node('c1000000-0000-4000-8000-000000000002', 'Validate Credential Request', 'n8n-nodes-base.code', 2, [-400,0], { mode: 'runOnceForAllItems', jsCode: validator }),
    node('c1000000-0000-4000-8000-000000000003', 'Valid Credential Request?', 'n8n-nodes-base.if', 2.2, [-200,0], {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: 'c1000000-0000-4000-8000-000000000103', leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
    }),
    node('c1000000-0000-4000-8000-000000000004', 'Build Credential Email', 'n8n-nodes-base.code', 2, [0,-80], { mode: 'runOnceForAllItems', jsCode: emailCode }),
    node('c1000000-0000-4000-8000-000000000005', 'Send Credential Email from HR', 'n8n-nodes-base.microsoftOutlook', 2, [220,-80], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.actualRecipient }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: { bodyContentType: 'html', saveToSentItems: false },
    }, { credentials: { microsoftOutlookOAuth2Api: { id: 'vFEolsXoEOOxNyan', name: 'Microsoft Outlook account - hr@mobilityaccess.com.au' } } }),
    node('c1000000-0000-4000-8000-000000000006', 'Acknowledge Credential Email', 'n8n-nodes-base.code', 2, [440,-80], {
      jsCode: "return [{ json: { ok: true, deliveryId: $('Validate Credential Request').first().json.deliveryId } }];",
    }),
    node('c1000000-0000-4000-8000-000000000007', 'Reject Credential Request', 'n8n-nodes-base.code', 2, [0,100], { jsCode: "return [{ json: { ok: false, code: 'invalid_payload' } }];" }),
  ];
  const edge = (name) => ({ node: name, type: 'main', index: 0 });
  return {
    name: 'MAM People Hub - Onboarding Credentials (Live)', nodes,
    connections: {
      'Receive Credential Request': { main: [[edge('Validate Credential Request')]] },
      'Validate Credential Request': { main: [[edge('Valid Credential Request?')]] },
      'Valid Credential Request?': { main: [[edge('Build Credential Email')], [edge('Reject Credential Request')]] },
      'Build Credential Email': { main: [[edge('Send Credential Email from HR')]] },
      'Send Credential Email from HR': { main: [[edge('Acknowledge Credential Email')]] },
    },
    settings: { executionOrder: 'v1', timezone: 'Australia/Melbourne', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none', saveExecutionProgress: false },
  };
}
