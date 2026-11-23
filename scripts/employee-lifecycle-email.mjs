import { HR_EMAIL_SIGNATURE_HTML } from './hr-email-signature.mjs';

export const APPLICABILITY_NOTE = 'Actions depend on the employee’s role, team, employment type, work location and recorded system access.';
export const FUTURE_CHECKLIST_NOTE = 'A dynamic checklist within People Hub is planned for a future update.';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const clean = value => typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
const recorded = value => clean(value) || 'No record in People Hub';
const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const LOCATION = {hq:'HQ',onsite_trade:'Onsite Trade',remote_worker:'Remote Worker',hybrid:'Hybrid',overseas:'Overseas'};
const TIMESHEET = {aroflo:'AroFlo',deputy:'Deputy',hubstaff:'Hubstaff',deputy_hubstaff:'Deputy & Hubstaff',aroflo_hubstaff:'AroFlo & Hubstaff',aroflo_deputy:'AroFlo & Deputy'};
const EMPLOYMENT = {abn:'ABN',casual:'Casual',full_time:'Full-time',part_time:'Part-time',overseas:'Overseas'};

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('A valid employee date is required.');
  const date = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('A valid employee date is required.');
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Melbourne' }).format(date);
}
function formatted(value, dictionary) {
  const key = clean(value).toLowerCase();
  return dictionary[key] || recorded(value);
}
function workDays(employee) {
  const days = employee?.workingWeekdays;
  return Array.isArray(days) && days.length
    ? [...new Set(days)].sort((a,b)=>a-b).map(day=>WEEKDAYS[day-1]).filter(Boolean).join(', ') || 'No record in People Hub'
    : 'No record in People Hub';
}
function workTimes(employee) {
  const times = employee?.workingDayTimes;
  if (!Array.isArray(times) || !times.length) return 'No record in People Hub';
  const schedule = times.filter(row=>row && Number.isInteger(row.weekday) && row.weekday>=1 && row.weekday<=7
    && /^\d{2}:\d{2}$/.test(row.start_time) && /^\d{2}:\d{2}$/.test(row.end_time))
    .sort((a,b)=>a.weekday-b.weekday)
    .map(row=>WEEKDAYS[row.weekday-1] + ' ' + row.start_time + '–' + row.end_time);
  return schedule.join('; ') || 'No record in People Hub';
}
function table(rows) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid #e1e6df">'
    +rows.map(([key,value],i)=>'<tr style="background:'+(i%2?'#f8faf8':'#ffffff')+'"><th scope="row" align="left" valign="top" style="width:38%;padding:10px 12px;font-size:14px;color:#52635a;border-bottom:1px solid #e1e6df">'+escapeHtml(key)+'</th><td valign="top" style="padding:10px 12px;font-size:14px;color:#26332c;border-bottom:1px solid #e1e6df">'+escapeHtml(value)+'</td></tr>').join('')+'</table>';
}
function actions(items) {
  return '<ul style="margin:12px 0 0;padding-left:20px">'+items.map(action=>'<li style="margin:0 0 8px;font-size:14px;line-height:22px">'+escapeHtml(action)+'</li>').join('')+'</ul>';
}
const otherActions = {
  onboarding: [
    ['Team Leader',['Confirm equipment and uniform requirements for the employee.','Arrange applicable laptop or iPad, SIM, 3CX or vehicle allocation.','Confirm induction and any software requirements with the relevant team.']],
    ['Bookkeeper',['Create the Xero/payroll record when required, and confirm tax, bank and superannuation details.']],
    ['Warehouse',['Confirm and prepare applicable uniforms and warehouse-issued equipment.']],
    ['LMS Administrator',['Create the iSpring LMS account and assign relevant onboarding/training modules.']],
  ],
  offboarding: [
    ['Team Leader',['Recover company equipment, uniforms, phones and accessories and record asset returns.','Arrange SIM, vehicle/GPS and 3CX transfer or cancellation as applicable.']],
    ['Bookkeeper',['Process final pay, outstanding entitlements and superannuation; archive Xero record when appropriate.']],
    ['Warehouse',['Collect warehouse-issued equipment and applicable uniforms.']],
    ['LMS Administrator',['Deactivate iSpring LMS access and retain training records as required.']],
    ['Software / Subscription Owners',['Revoke access to assigned software and shared sessions; reassign licences or account ownership.']],
  ],
};
export function buildEmployeeLifecycleEmail({ kind, employee, preview = false }) {
  if (!['onboarding', 'offboarding'].includes(kind)) throw new Error('Select onboarding or offboarding.');
  const name = clean(employee?.name);
  if (!name || name.length > 200) throw new Error('An employee name is required.');
  const label = kind === 'onboarding' ? 'Onboarding' : 'Offboarding';
  const milestone = formatDate(kind === 'onboarding' ? employee.startDate : employee.endDate);
  const startDate = employee?.startDate ? formatDate(employee.startDate) : 'No record in People Hub';
  const teamLead = recorded(employee?.teamLeader);
  const deadline = kind === 'onboarding' ? (employee?.prestartDeadline ? formatDate(employee.prestartDeadline) : 'No recorded business-day deadline') : milestone;
  const deadlineLabel = kind === 'onboarding' ? 'Deadline (one Victorian business day before start)' : 'Deadline (final working day)';
  const noIt = clean(employee?.location).toLowerCase() === 'onsite_trade'
    || clean(employee?.department).toLowerCase() === 'warehouse'
    || clean(employee?.employmentType).toLowerCase() === 'overseas';
  const general = [
    ['Employee',name],['Company',recorded(employee.company)],['Job title',recorded(employee.role)],
    ['Department / team',recorded(employee.department)],['Start date',startDate],
  ];
  if (kind==='offboarding') general.push(['Final working day',milestone]);
  const accounts = [
    ['Personal email',recorded(employee?.personalEmail)],
    ['Work location',formatted(employee?.location,LOCATION)],
    ['Company',recorded(employee.company)],
    ['Timesheet entries / accounts system',formatted(employee?.timesheetEntries,TIMESHEET)],
    ['Employment type',formatted(employee?.employmentType,EMPLOYMENT)],
    ['Usual work days',workDays(employee)],
    ['Start / finish times',workTimes(employee)],
    [deadlineLabel,deadline],
  ];
  const selectedSystems = formatted(employee?.timesheetEntries,TIMESHEET);
  const accountsActions = kind === 'onboarding'
    ? ['Set up the employee in the selected timesheet system(s): '+selectedSystems+'.','Confirm applicable payroll or accounts setup is ready by the deadline.']
    : ['Remove or archive the employee from applicable timesheet system(s): '+selectedSystems+'.','Confirm payroll/accounts access is removed by the final working day.'];
  const itRows = noIt ? [['IT access','No IT access required']] : [
    ['Team Lead',teamLead],['Employee',name],['MAM/Equipsy email account name','Team Leader to confirm'],['Laptop code to configure',recorded(employee?.laptopCode)],
    ['OneDrive needed','Team Leader to confirm'],['SharePoint folders requiring access','Team Leader to confirm'],
    [deadlineLabel,deadline],
  ];
  const itActions = noIt ? [] : kind === 'onboarding' ? [
    'Team Leader to confirm the required MAM/Equipsy email account name.',
    'Configure the laptop and company email, OneDrive and approved SharePoint folder permissions as confirmed.',
    'Contact the employee via text/email ahead of their first day to provide login instructions securely.',
  ] : [
    'Disable the company email and revoke OneDrive, SharePoint and shared-mailbox permissions.',
    'Arrange approved mailbox retention or forwarding and reset returned laptop/devices.',
    'Confirm all assigned IT access is removed by the final working day.',
  ];
  const headings = [
    ['General employee information',general,[]],
    ['Accounts',accounts,accountsActions],
    ['IT',itRows,itActions],
  ];
  const subject = (preview ? '[PREVIEW] ' : '')+'People Hub | '+label+' checklist | '+name+' | '+milestone;
  const intro = kind === 'onboarding'
    ? name+' has been added to People Hub. Please arrange onboarding actions by the stated deadlines.'
    : 'The final working day for '+name+' is '+milestone+'. Please coordinate the applicable offboarding actions.';
  const theme = kind === 'onboarding' ? '#246343' : '#74336d';
  const blocks = headings.map(([heading,rows,tasks])=>'<h2 style="margin:26px 0 12px;font-size:19px;color:'+theme+'">'+escapeHtml(heading)+'</h2>'+table(rows)+(tasks.length?actions(tasks):'')).join('');
  const additional = otherActions[kind].map(([owner,tasks])=>'<h3 style="font-size:15px;color:'+theme+';margin:16px 0 3px">'+escapeHtml(owner)+'</h3>'+actions(tasks)).join('');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(subject)+'</title></head><body style="margin:0;background:#f3f4f1;font-family:Segoe UI,Arial,sans-serif;color:#26332c"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f1"><tr><td align="center" style="padding:20px 12px"><table role="presentation" width="760" cellpadding="0" cellspacing="0" style="width:100%;max-width:760px;background:#ffffff;border:1px solid #dce4df"><tr><td style="padding:26px 28px;border-top:4px solid #ed8b23">'+(preview?'<p style="color:#79541b;font-size:12px">MARKETING PREVIEW · FOR REVIEW ONLY</p>':'')+'<p style="font-weight:bold;font-size:12px;letter-spacing:1px">MAM &amp; EQUIPSY · PEOPLE HUB</p><h1 style="font-size:27px;color:'+theme+'">'+label+' checklist</h1><p style="font-size:14px;line-height:22px"><strong>Applicability:</strong> '+escapeHtml(APPLICABILITY_NOTE)+'</p><p>Hi team,</p><p>'+escapeHtml(intro)+'</p>'+blocks+'<h2 style="margin:26px 0 12px;font-size:19px;color:'+theme+'">Other applicable responsibilities</h2>'+additional+'<p style="margin:26px 0 12px;font-size:12px;color:#67766b">'+escapeHtml(FUTURE_CHECKLIST_NOTE)+'</p><p>Thank you,</p>'+HR_EMAIL_SIGNATURE_HTML+'</td></tr></table></td></tr></table></body></html>';
  const text = [preview?'MARKETING PREVIEW · FOR REVIEW ONLY':'',label+' checklist','Applicability: '+APPLICABILITY_NOTE,'Hi team,',intro,
    ...headings.map(([heading,rows,tasks])=>heading+'\n'+rows.map(([key,value])=>key+': '+value).join('\n')+(tasks.length?'\n'+tasks.map(action=>'• '+action).join('\n'):'')),
    'Other applicable responsibilities',...otherActions[kind].map(([owner,tasks])=>owner+'\n'+tasks.map(action=>'• '+action).join('\n')),
    FUTURE_CHECKLIST_NOTE,'Thank you,\nPeople & Culture\nMobility Access Modifications'].filter(Boolean).join('\n\n');
  return {subject,html,text};
}
