import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

export const APPLICABILITY_NOTE = 'Not all items below apply to every employee. Required actions depend on the employee’s actual role, department, division, work location, and assigned equipment and system access.';
export const FUTURE_CHECKLIST_NOTE = 'A dynamic checklist within People Hub is planned for a future update.';

const checklists = {
  onboarding: [
    ['HR – Maricon', [
      'Add employee to People Hub.',
      'Confirm name, company, job title, department, employment type, work location and start date.',
      'Confirm reporting Team Leader and employee contact details.',
      'Coordinate contract and onboarding documentation.',
    ]],
    ['Team Leader', [
      'Confirm equipment requirements for the employee.',
      'Arrange laptop, mouse and keyboard for office staff.',
      'Arrange iPad for Minor Mods trades and Major Mods draftspersons, including new/reused device and iCloud account setup.',
      'Arrange Telstra SIM and GPS/vehicle allocation if required.',
      'Set up 3CX extension where applicable.',
      'Confirm any additional software or access requirements.',
      'Confirm the new team member’s email name and required SharePoint access with Alfred.',
    ]],
    ['IT – Alfred', [
      'Create company email account for office employees.',
      'Configure laptop and required software.',
      'Set up SharePoint folder permissions and shared mailbox access.',
      'Arrange secure delivery of login details.',
      'Confirm IT setup is complete.',
    ]],
    ['Accounts', [
      'Create AroFlo access for relevant MAM office staff and trades.',
      'Create Deputy access for applicable onshore employees.',
      'Create Hubstaff access for offshore employees.',
      'Confirm relevant system access is active.',
    ]],
    ['Bookkeeper', [
      'Create employee profile in Xero where required.',
      'Confirm payroll, bank, tax and superannuation details.',
      'Ensure employee is ready for payroll processing.',
    ]],
    ['Warehouse', [
      'Confirm uniform sizes with HR for Minor and Major Mods trades.',
      'Organise and allocate required uniforms.',
      'Confirm uniforms are ready for collection.',
    ]],
    ['LMS Administrator', [
      'Create employee account in iSpring LMS.',
      'Assign applicable onboarding and training modules.',
      'Arrange LMS login instructions.',
    ]],
    ['Power BI / Reporting Owner', [
      'Add employee to relevant HR and employee reporting.',
      'Confirm headcount, department and training reporting reflect the new starter.',
    ]],
  ],
  offboarding: [
    ['HR – Maricon', [
      'Update employee status in People Hub.',
      'Confirm final working day and employment end date.',
      'Record exit reason and employee details.',
      'Coordinate offboarding documentation.',
      'Confirm all outstanding actions are completed.',
    ]],
    ['Team Leader', [
      'Collect company equipment including laptops, iPads, phones and accessories.',
      'Record returned equipment and asset references.',
      'Arrange iPad reset and removal of company accounts.',
      'Cancel or reassign Telstra SIM.',
      'Remove GPS Fleet/vehicle allocation.',
      'Remove or reassign 3CX extension.',
      'Confirm all company property has been returned.',
    ]],
    ['IT – Alfred', [
      'Disable company email access.',
      'Remove SharePoint, OneDrive and shared mailbox access.',
      'Secure and archive emails and company files where required.',
      'Arrange approved email forwarding or mailbox retention.',
      'Reset returned laptops and devices.',
      'Revoke relevant IT access.',
    ]],
    ['Accounts', [
      'Disable/archive AroFlo account if applicable.',
      'Disable/archive Deputy account if applicable.',
      'Disable/archive Hubstaff account if applicable.',
      'Confirm all relevant system access is removed.',
    ]],
    ['Bookkeeper', [
      'Process final pay and outstanding entitlements.',
      'Finalise superannuation obligations.',
      'Archive employee in Xero when appropriate.',
    ]],
    ['Warehouse', [
      'Collect company uniforms from Minor and Major Mods trades where required.',
      'Confirm return of warehouse-issued equipment.',
    ]],
    ['LMS Administrator', [
      'Deactivate the employee’s iSpring LMS access.',
      'Retain training completion records as required.',
    ]],
    ['Power BI / Reporting Owner', [
      'Update employee status and end date in reporting.',
      'Remove employee from active headcount and relevant dashboards.',
    ]],
    ['Software / Subscription Owners', [
      'Remove access to Canva, Adobe and other assigned subscriptions.',
      'Reassign licences or account ownership.',
      'Revoke shared credentials or sessions where required.',
    ]],
  ],
};

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function clean(value) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
}

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('A valid employee date is required.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('A valid employee date is required.');
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Melbourne' }).format(date);
}

export function buildEmployeeLifecycleEmail({ kind, employee, preview = false }) {
  if (!['onboarding', 'offboarding'].includes(kind)) throw new Error('Select onboarding or offboarding.');
  const name = clean(employee?.name);
  if (!name || name.length > 200) throw new Error('An employee name is required.');
  const label = kind === 'onboarding' ? 'Onboarding' : 'Offboarding';
  const date = formatDate(kind === 'onboarding' ? employee.startDate : employee.endDate);
  const dateLabel = kind === 'onboarding' ? 'Start date' : 'Final working day';
  const colour = kind === 'onboarding' ? '#246343' : '#74336d';
  const tint = kind === 'onboarding' ? '#eff6f1' : '#f7f0f6';
  const intro = kind === 'onboarding'
    ? `${name} has been added to People Hub. Please coordinate the applicable onboarding actions below.`
    : `The recorded final working day for ${name} is ${date}. Please coordinate the applicable offboarding actions below.`;
  const summary = [
    ['Employee', name], ['Company', clean(employee.company)], ['Job title', clean(employee.role)],
    ['Department / team', clean(employee.department)], ['Work location', clean(employee.location)],
    ['Employment type', clean(employee.employmentType)], [dateLabel, date],
  ].filter(([, value]) => value);
  const details = summary.map(([key, value]) => `<tr><th scope="row" align="left" valign="top" style="padding:6px 14px 6px 0;width:145px;font-weight:normal;color:#68726d;font-size:14px;line-height:21px">${escapeHtml(key)}</th><td style="padding:6px 0;font-size:14px;line-height:21px;color:#26332c;font-weight:600">${escapeHtml(value)}</td></tr>`).join('');
  const rows = checklists[kind].map(([owner, actions], index) => `<tr><th scope="row" align="left" valign="top" width="26%" bgcolor="${tint}" style="width:26%;padding:16px 14px;border-bottom:1px solid #dce4df;color:${colour};font-size:14px;line-height:21px;font-weight:bold">${escapeHtml(owner)}</th><td valign="top" bgcolor="${index % 2 ? '#fafbf9' : '#ffffff'}" style="padding:14px 16px;border-bottom:1px solid #dce4df;font-size:14px;line-height:22px;color:#26332c"><ul style="margin:0;padding-left:18px">${actions.map(action => `<li style="margin:0 0 5px">${escapeHtml(action)}</li>`).join('')}</ul></td></tr>`).join('');
  const previewNote = preview ? '<tr><td style="padding:10px 28px;background:#fff2d8;color:#79541b;font-size:11px;font-weight:bold;letter-spacing:1px">MARKETING PREVIEW · FOR REVIEW ONLY</td></tr>' : '';
  const subject = `${preview ? '[PREVIEW] ' : ''}People Hub | ${label} checklist | ${name} | ${date}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background:#f3f4f1;font-family:Segoe UI,Arial,sans-serif;color:#26332c"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f4f1"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="760" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;max-width:760px;border:1px solid #dce4df">${previewNote}<tr><td style="padding:26px 28px 22px;border-bottom:4px solid #ed8b23"><div style="font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1.5px;color:#737a72">MAM &amp; EQUIPSY · PEOPLE HUB</div><h1 style="margin:9px 0 0;font-size:28px;line-height:36px;color:${colour}">${label} checklist</h1></td></tr><tr><td style="padding:24px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fff7e8"><tr><td style="padding:14px 16px;border-left:3px solid #ed8b23;font-size:14px;line-height:22px"><strong>Applicability</strong><br>${APPLICABILITY_NOTE}</td></tr></table><p style="font-size:15px;line-height:24px;margin:24px 0 12px">Hi team,</p><p style="font-size:15px;line-height:24px;margin:0 0 20px">${escapeHtml(intro)}</p><table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e8e2;border-bottom:1px solid #e4e8e2">${details}</table><h2 style="font-size:18px;line-height:25px;margin:26px 0 14px">Responsibilities and actions</h2><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dce4df;border-collapse:collapse"><thead><tr bgcolor="${colour}"><th scope="col" align="left" style="padding:12px 14px;width:26%;font-size:13px;line-height:20px;color:#ffffff">Contact / Person responsible</th><th scope="col" align="left" style="padding:12px 16px;font-size:13px;line-height:20px;color:#ffffff">Actions required</th></tr></thead><tbody>${rows}</tbody></table><p style="margin:20px 0 0;font-size:12px;line-height:19px;color:#68726d">${APPLICABILITY_NOTE} ${FUTURE_CHECKLIST_NOTE}</p><p style="font-size:15px;line-height:24px;margin:24px 0 0">Thank you,</p>${HR_EMAIL_SIGNATURE_HTML}</td></tr><tr><td style="height:28px;font-size:1px;line-height:1px">&nbsp;</td></tr></table></td></tr></table></body></html>`;
  const text = [preview ? 'MARKETING PREVIEW · FOR REVIEW ONLY' : '', `${label} checklist`, APPLICABILITY_NOTE, 'Hi team,', intro, summary.map(([key, value]) => `${key}: ${value}`).join('\n'), ...checklists[kind].map(([owner, actions]) => `${owner}\n${actions.map(action => `• ${action}`).join('\n')}`), `${APPLICABILITY_NOTE} ${FUTURE_CHECKLIST_NOTE}`, 'Thank you,\nPeople & Culture\nMobility Access Modifications'].filter(Boolean).join('\n\n');
  return { subject, html, text };
}
