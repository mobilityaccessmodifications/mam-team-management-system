import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const validate = new Function('$input', '$getWorkflowStaticData', fs.readFileSync('workflows/leave-notification-validator.n8n.txt', 'utf8'));
const id = '10000000-0000-4000-8000-000000000001';
const base = { version:1,requestId:id,employeeName:'Test Employee',employeeEmail:'employee@example.test',company:'mam',leaveType:'Annual leave',startDate:'2026-09-14',endDate:'2026-09-15',startTime:null,endTime:null,days:2,hours:null,status:'Pending',employeeNote:null,managerNote:null,managerEmail:'manager@example.test' };
function run(event, extra={}, state={}) {
  const body={...base,event,eventKey:`leave:${id}:${event}:${'a'.repeat(24)}`,...extra};
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
  assert.equal(out.outcome,'send'); assert.equal(out.deliveryRecipient,'manager@example.test'); assert.equal(out.ccRecipients,event==='leave-reminder'?'':'hr@mobilityaccess.com.au');
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
