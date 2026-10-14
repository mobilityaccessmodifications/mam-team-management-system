const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({ id, name, type, typeVersion, position, parameters, ...extra });
const validator = `const p = $input.first().json.body;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = /^[^\\s@,;]+@[^\\s@,;]+\\.[^\\s@,;]+$/;
let valid = p?.version === 1 && uuid.test(p?.requestId ?? '')
  && typeof p?.recipient === 'string' && p.recipient.length <= 254 && email.test(p.recipient)
  && p.recipient === p.recipient.trim().toLowerCase();
valid = valid && typeof p?.resetUrl === 'string'
  && /^https:\\/\\/mam-team-management-system-ten\\.vercel\\.app\\/login\\/reset-password#token=[A-Za-z0-9_-]{43}$/.test(p.resetUrl);
return [{json: valid ? {valid: true, requestId: p.requestId, recipient: p.recipient, resetUrl: p.resetUrl} : {valid: false}}];`;
const emailCode = `const p = $input.first().json;
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
return [{json: {...p, subject: 'Reset your People Hub password', bodyContent:
  '<div style="font-family:Arial,sans-serif;color:#252525;max-width:600px"><h2>People Hub</h2><p>Hi,</p>'
  + '<p>Use the link below to reset your People Hub password.</p><p><a style="display:inline-block;padding:14px 22px;background:#ed8b23;color:#202020;text-decoration:none" href="' + escape(p.resetUrl) + '">Reset password</a></p>'
  + '<p>This link expires in one hour and can be used once. If you did not request this, you can ignore this email.</p>'
  + '<p>Kind regards,<br><strong>MAM AI</strong><br>People Hub system notifications</p></div>'}}];`;

export function buildPasswordRecoveryWorkflow({ webhookCredential, outlookCredential } = {}) {
  if (!webhookCredential?.id || webhookCredential.name !== 'MAM People Hub - Password Recovery Webhook Header' || !outlookCredential?.id
    || outlookCredential.name !== 'Microsoft Outlook - ai@mobilityaccess.com.au') throw new Error('Verified MAM webhook and AI Outlook credentials required');
  const nodes = [
    node('recovery-webhook', 'Receive Password Recovery', 'n8n-nodes-base.webhook', 2.1, [0,0], {
      authentication: 'headerAuth', httpMethod: 'POST', path: 'mam-people-hub-password-recovery-v1', responseMode: 'lastNode', options: {},
    }, {webhookId: 'mam-people-hub-password-recovery-v1', credentials: {httpHeaderAuth: webhookCredential}}),
    node('recovery-validator', 'Validate Password Recovery', 'n8n-nodes-base.code', 2, [220,0], {mode: 'runOnceForAllItems', jsCode: validator}),
    node('recovery-gate', 'Valid Password Recovery?', 'n8n-nodes-base.if', 2.2, [440,0], {
      conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2},
        conditions: [{id: 'valid-recovery', leftValue: '={{ $json.valid }}', rightValue: '', operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {},
    }),
    node('recovery-email', 'Build Password Recovery Email', 'n8n-nodes-base.code', 2, [660,-80], {mode: 'runOnceForAllItems', jsCode: emailCode}),
    node('recovery-send', 'Send Password Recovery from AI', 'n8n-nodes-base.microsoftOutlook', 2, [880,-80], {
      resource: 'message', operation: 'send', toRecipients: '={{ $json.recipient }}', subject: '={{ $json.subject }}', bodyContent: '={{ $json.bodyContent }}',
      additionalFields: {bodyContentType: 'html', saveToSentItems: true},
    }, {credentials: {microsoftOutlookOAuth2Api: outlookCredential}, retryOnFail: false}),
    node('recovery-ack', 'Acknowledge Password Recovery', 'n8n-nodes-base.code', 2, [1100,-80], {jsCode: `if ($input.first().json?.success !== true) throw new Error('Provider acceptance unavailable');
return [{json: {ok: true, sent: true, requestId: $('Validate Password Recovery').first().json.requestId}}];`}),
    node('recovery-rejected', 'Reject Password Recovery', 'n8n-nodes-base.code', 2, [660,100], {jsCode: "return [{json: {ok: false, sent: false}}];"}),
  ];
  const edge = name => ({node: name, type: 'main', index: 0});
  return {name: 'MAM People Hub - Password Recovery', nodes, connections: {
    'Receive Password Recovery': {main: [[edge('Validate Password Recovery')]]},
    'Validate Password Recovery': {main: [[edge('Valid Password Recovery?')]]},
    'Valid Password Recovery?': {main: [[edge('Build Password Recovery Email')], [edge('Reject Password Recovery')]]},
    'Build Password Recovery Email': {main: [[edge('Send Password Recovery from AI')]]},
    'Send Password Recovery from AI': {main: [[edge('Acknowledge Password Recovery')]]},
  }, settings: {executionOrder: 'v1', saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none', saveExecutionProgress: false, saveManualExecutions: false}};
}
