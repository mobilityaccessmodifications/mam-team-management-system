import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const validate = new Function('$input', '$getWorkflowStaticData', fs.readFileSync('workflows/leave-notification-validator.n8n.txt', 'utf8'));
const confirm = new Function('$', '$input', '$getWorkflowStaticData', fs.readFileSync('workflows/leave-notification-confirmation.n8n.txt', 'utf8'));
const id = '10000000-0000-4000-8000-000000000001';
const base = { version:1,requestId:id,employeeName:'Test Employee',employeeEmail:'employee@example.test',company:'mam',leaveType:'Annual leave',startDate:'2026-09-14',endDate:'2026-09-15',startTime:null,endTime:null,days:2,hours:null,status:'Pending',employeeNote:null,managerNote:null,managerEmail:'manager@example.test' };
function run(event, extra={}, state={}) {
  const body={...base,event,eventKey:`leave:${id}:${event}:${'a'.repeat(24)}`,...extra};
  return validate({first:()=>({json:{headers:{'content-type':'application/json'},body}})},()=>state)[0].json;
}
function runPayroll(extra={}, state={}) {
  const body={version:1,event:'payroll-balance-reminder',requestId:id,recipientName:'Gerard',
    recipientEmail:'gerard@example.test',reminderMonth:'2026-10-01',missingCompanies:['mam','equipsy'],...extra};
  if (!Object.prototype.hasOwnProperty.call(extra,'eventKey')) {
    body.eventKey=`payroll-balance:${body.requestId}:${body.reminderMonth.slice(0,7)}`;
  }
  return validate({first:()=>({json:{headers:{'content-type':'application/json'},body}})},()=>state)[0].json;
}
test('submission goes to manager and employee with HR copied',()=>{
  const out=run('leave-submitted');
  assert.equal(out.outcome,'send'); assert.equal(out.deliveryRecipient,'manager@example.test,employee@example.test');
  assert.equal(out.ccRecipients,'hr@mobilityaccess.com.au');
});
test('missing employee email never blocks the manager submission notice',()=>{
  const out=run('leave-submitted',{employeeEmail:null,employeeEmails:[]});
  assert.equal(out.outcome,'send');assert.equal(out.deliveryRecipient,'manager@example.test');
});
test('multiline textarea notes are accepted and HTML remains escaped',()=>{
  const out=run('leave-declined',{status:'Declined',employeeNote:'First line\nSecond line',managerNote:'Approved\r\n<unsafe>\ttext'});
  assert.equal(out.outcome,'send');
  assert(out.emailHtml.includes('&lt;unsafe&gt;'));
  assert(!out.emailHtml.includes('<unsafe>'));
  assert.equal(run('leave-approved',{employeeNote:'bad\u0000note'}).outcome,'rejected');
  assert.equal(run('leave-approved',{employeeName:'name\nheader'}).outcome,'rejected');
});
for(const event of ['leave-approved','leave-declined','leave-conditionally-approved']) test(event,()=>{
  const out=run(event,{status:event==='leave-conditionally-approved'?'Approved – pending leave balance':event==='leave-approved'?'Approved':'Declined',managerNote:'<unsafe>'});
  assert.equal(out.deliveryRecipient,'employee@example.test');
  assert.equal(out.ccRecipients,event==='leave-approved'?'hr@mobilityaccess.com.au,accounts@mobilityaccess.com.au':'hr@mobilityaccess.com.au');
  assert(!out.emailHtml.includes('<unsafe>')); assert.equal(out.emailHtml.includes('&lt;unsafe&gt;'),event!=='leave-approved');
});
test('Accounts receives only approved cancellation',()=>{
  assert.equal(run('leave-cancelled',{wasApproved:true}).ccRecipients,'hr@mobilityaccess.com.au,accounts@mobilityaccess.com.au');
  assert.equal(run('leave-cancelled',{wasApproved:false}).ccRecipients,'hr@mobilityaccess.com.au');
});
for(const event of ['leave-reminder','team-birthday']) test(event,()=>{
  const out=run(event,{employeeEmail:null,leaveType:event==='team-birthday'?'Birthday':'Annual leave'});
  assert.equal(out.outcome,'send'); assert.equal(out.deliveryRecipient,'manager@example.test'); assert.equal(out.ccRecipients,'');
  if (event === 'team-birthday') assert.equal(out.emailSubject, '[MAM] Team birthday reminder: Test Employee');
});
test('deduplicates sent event and fails closed without a manager',()=>{
  const key=`leave:${id}:leave-submitted:${'a'.repeat(24)}`;
  const out=run('leave-submitted',{}, {leaveNotificationEvents:{[key]:{state:'sent',at:Date.now()}}});
  assert.equal(out.outcome,'duplicate'); assert.equal(out.actualRecipient,'manager@example.test');
  assert.equal(run('leave-submitted',{managerEmail:null}).outcome,'rejected');
});
test('conditional approval reminder asks the manager to finalise the balance',()=>{
  const out=run('leave-reminder',{status:'Approved – pending leave balance'});
  assert(out.emailHtml.includes('confirm the annual leave balance and finalise approval'));
  assert.equal(out.ccRecipients,'');
});
test('reminder cannot re-enable HR CC through the payload',()=>{
  assert.equal(run('leave-reminder',{ccEmails:['hr@mobilityaccess.com.au']}).ccRecipients,'');
});
test('manager requests notify every group reviewer and do not duplicate HR in CC',()=>{
  const group='reviewer1@example.test,reviewer2@example.test,hr@mobilityaccess.com.au';
  const out=run('leave-submitted',{managerEmail:group});
  assert.equal(out.outcome,'send');
  assert.equal(out.confirmationRecipient,group);
  assert.equal(out.deliveryRecipient,group+',employee@example.test');
  assert.equal(out.ccRecipients,'');
  assert.equal(run('leave-reminder',{managerEmail:group}).deliveryRecipient,group);
  assert.equal(run('leave-cancelled',{managerEmail:group,wasApproved:true}).ccRecipients,'accounts@mobilityaccess.com.au');
});
test('group recipients reject partial, malformed and header-injected lists',()=>{
  for(const value of ['a@example.test,','a@example.test,broken','a@example.test;other@example.test','a@example.test,\r\nb@example.test']) {
    assert.equal(run('leave-submitted',{managerEmail:value}).outcome,'rejected');
  }
});

test('preserves deployed MAM Accounts note minimisation and delivery flag',()=>{
  const out=run('leave-approved',{status:'Approved',managerNote:'Private approval note'});
  assert.equal(out.mamDelivery,true);
  assert(!out.emailHtml.includes('Private approval note'));
});

test('annual submission includes full-day hours and projected balance without duplication',()=>{
  const out=run('leave-submitted',{leaveBalance:{kind:'annual',status:'current',hours:28.4621}});
  assert.equal(out.outcome,'send');
  assert(out.emailHtml.includes('Annual leave hours requested:</strong> 15 hours'));
  assert(out.emailHtml.includes('Annual leave balance:</strong> 28.46 hours'));
  assert(out.emailHtml.includes('Annual leave remaining if approved:</strong> 13.46 hours'));
  assert(!out.emailHtml.includes('<strong>Hours:</strong>'));
  const partial=run('leave-submitted',{hours:3.25,leaveBalance:{kind:'annual',status:'current',hours:2}});
  assert(partial.emailHtml.includes('hours requested:</strong> 3.25 hours'));
  assert(partial.emailHtml.includes('remaining if approved:</strong> -1.25 hours'));
});
test('unknown or held balances are never rendered as zero',()=>{
  const out=run('leave-submitted',{leaveBalance:{kind:'annual',status:'check_balance',hours:null}});
  assert(out.emailHtml.includes('balance:</strong> Check balance'));
  assert(out.emailHtml.includes('remaining if approved:</strong> Check balance'));
  assert(!out.emailHtml.includes('balance:</strong> 0 hours'));
});
test('sick balance is private to reviewer copy, including overlapping applicant addresses',()=>{
  const extra={leaveType:'Sick leave',leaveBalance:{kind:'sick',status:'current',hours:40.9297}};
  const review=run('leave-submitted',{...extra,audience:'reviewers',managerEmail:'manager@example.test,employee@example.test'});
  assert.equal(review.deliveryRecipient,'manager@example.test,hr@mobilityaccess.com.au');
  assert.equal(review.confirmationRecipient,review.deliveryRecipient);
  assert.equal(review.ccRecipients,'');
  assert(review.emailHtml.includes('Sick leave remaining if approved:</strong> 25.93 hours'));
  for(const audience of [undefined,'employee']) {
    const out=run('leave-submitted',{...extra,...(audience?{audience}:{})});
    assert.equal(out.outcome,'send');
    assert(!out.emailHtml.includes('40.93'));
    assert(!out.emailHtml.includes('remaining if approved'));
    if(audience) {assert.equal(out.deliveryRecipient,'employee@example.test');assert.equal(out.ccRecipients,'');}
  }
  const carer=run('leave-submitted',{...extra,leaveType:"Carer's leave",audience:'reviewers'});
  assert(carer.emailHtml.includes('Sick leave balance:</strong> 40.93 hours'));
});
test('balance contract rejects invalid values and does not subtract again after approval',()=>{
  for(const leaveBalance of [{kind:'sick',status:'current',hours:10},{kind:'annual',status:'current',hours:'10'},
    {kind:'annual',status:'check_balance',hours:10},{kind:'annual',status:'current',hours:Infinity}]) {
    assert.equal(run('leave-submitted',{leaveBalance}).outcome,'rejected');
  }
  assert.equal(run('leave-approved',{audience:'reviewers'}).outcome,'rejected');
  assert(!run('leave-approved',{leaveBalance:{kind:'annual',status:'current',hours:10}}).emailHtml.includes('remaining if approved'));
});

test('monthly payroll reminder sends only to the server-resolved recipient',()=>{
  const out=runPayroll();
  assert.equal(out.outcome,'send');
  assert.equal(out.mamDelivery,true);
  assert.equal(out.deliveryRecipient,'gerard@example.test');
  assert.equal(out.confirmationRecipient,'gerard@example.test');
  assert.equal(out.ccRecipients,'');
  assert.equal(out.eventKey,`payroll-balance:${id}:2026-10`);
  assert.match(out.emailSubject,/Monthly banked leave update due/);
  assert(out.emailHtml.includes('October 2026'));
  assert(out.emailHtml.includes('MAM and Equipsy'));
  assert(out.emailHtml.includes('/?view=leave'));
  assert(!out.emailHtml.includes('hr@mobilityaccess.com.au'));
  assert(!out.emailHtml.includes('accounts@mobilityaccess.com.au'));
});

test('monthly payroll reminder identifies only the outstanding company and escapes the greeting',()=>{
  const out=runPayroll({recipientName:'Gerard <Payroll>',missingCompanies:['equipsy']});
  assert.equal(out.outcome,'send');
  assert(out.emailHtml.includes('Hi Gerard &lt;Payroll&gt;'));
  assert(out.emailHtml.includes('<strong>Still required:</strong> Equipsy'));
  assert(!out.emailHtml.includes('<strong>Still required:</strong> MAM'));
});

test('monthly payroll reminder rejects recipient injection and malformed server payloads',()=>{
  for(const extra of [
    {recipientEmail:'gerard@example.test\r\ncc:attacker@example.test'},
    {recipientEmail:'Gerard@example.test'},
    {recipientName:'Gerard\nPayroll'},
    {reminderMonth:'2026-10-02'},
    {missingCompanies:[]},
    {missingCompanies:['mam','mam']},
    {missingCompanies:['other']},
    {eventKey:`payroll-balance:${id}:2026-09`},
    {unexpected:'browser-controlled'},
  ]) assert.equal(runPayroll(extra).outcome,'rejected');
});

test('monthly payroll reminder deduplicates its stable workday-row event key',()=>{
  const eventKey=`payroll-balance:${id}:2026-10`;
  const out=runPayroll({}, {leaveNotificationEvents:{[eventKey]:{state:'sent',at:Date.now()}}});
  assert.equal(out.outcome,'duplicate');
  assert.equal(out.alreadySent,true);
  assert.equal(out.actualRecipient,'gerard@example.test');
  assert.equal(out.eventKey,eventKey);
});

function confirmDelivery(source, sent=[{json:{}}], state={}) {
  const node={all:()=>[{json:source}],first:()=>({json:source})};
  return confirm(()=>node,{all:()=>sent},()=>state)[0].json;
}

test('confirmation records both payroll and leave event families after one provider result',()=>{
  for(const eventKey of [`payroll-balance:${id}:2026-10`,`leave:${id}:leave-approved:${'a'.repeat(24)}`]) {
    const state={};
    const out=confirmDelivery({mamDelivery:true,eventKey,confirmationRecipient:'recipient@example.test'},[{json:{statusCode:202}}],state);
    assert.equal(out.ok,true);
    assert.equal(out.sent,true);
    assert.equal(out.actualRecipient,'recipient@example.test');
    assert.equal(out.eventKey,eventKey);
    assert.equal(state.leaveNotificationEvents[eventKey].state,'sent');
  }
});

test('confirmation rejects unknown keys, count mismatches and explicit provider failures',()=>{
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:'other:event',confirmationRecipient:'recipient@example.test'}),/count mismatch/);
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:`payroll-balance:${id}:2026-10`,confirmationRecipient:'recipient@example.test'},[]),/count mismatch/);
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:`payroll-balance:${id}:2026-10`,confirmationRecipient:'recipient@example.test'},[{json:{statusCode:500}}]),/provider explicitly rejected/);
});
