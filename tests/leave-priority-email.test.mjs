import test from 'node:test';
import assert from 'node:assert/strict';
import {prepare, confirmDelivery, receiverFor, canonical} from './notification-workflow-harness.mjs';
const id = '10000000-0000-4000-8000-000000000001';
const base = { version:1,requestId:id,employeeName:'Test Employee',employeeEmail:'employee@example.test',company:'mam',leaveType:'Annual leave',startDate:'2026-09-14',endDate:'2026-09-15',startTime:null,endTime:null,days:2,hours:null,fullDayHours:7.6,status:'Pending',employeeNote:null,managerNote:null,managerEmail:'manager@example.test' };
function run(event, extra={}, state={}) {
  const body={...base,event,eventKey:`leave:${id}:${event}:${'a'.repeat(24)}`,
    ...(event==='leave-submitted'?{audience:'reviewers'}:{}),...extra};
  return prepare(body,state);
}
function runPayroll(extra={}, state={}) {
  const body={version:1,event:'payroll-balance-reminder',requestId:id,recipientName:'Gerard',
    recipientEmail:'gerard@example.test',reminderMonth:'2026-10-01',missingCompanies:['mam','equipsy'],...extra};
  if (!Object.prototype.hasOwnProperty.call(extra,'eventKey')) {
    body.eventKey=`payroll-balance:${body.requestId}:${body.reminderMonth.slice(0,7)}`;
  }
  return prepare(body,state);
}
test('submission reviewer copy excludes employee addresses and includes HR',()=>{
  const out=run('leave-submitted');
  assert.equal(out.outcome,'send'); assert.equal(out.deliveryRecipient,'manager@example.test,career@mobilityaccess.com.au');
  assert.equal(out.ccRecipients,'');
});
test('trade school uses the existing notification contract without balance amounts',()=>{
  for(const [event,status] of [['leave-submitted','Pending'],['leave-approved','Approved'],['leave-declined','Declined'],['leave-cancelled','Cancelled']]){
    const out=run(event,{leaveType:'trade school',status,wasApproved:event==='leave-cancelled'});
    assert.equal(out.outcome,'send');
    assert(out.emailHtml.includes('trade school'));
    assert(!out.emailHtml.toLowerCase().includes('balance'));
    assert(!out.emailSubject.toLowerCase().includes('balance'));
  }
});
test('missing employee email never blocks the manager submission notice',()=>{
  const out=run('leave-submitted',{employeeEmail:null,employeeEmails:[]});
  assert.equal(out.outcome,'send');assert.equal(out.deliveryRecipient,'manager@example.test,career@mobilityaccess.com.au');
});
test('multiline textarea notes are accepted and HTML remains escaped',()=>{
  const out=run('leave-declined',{status:'Declined',employeeNote:'First line\nSecond line',managerNote:'Approved\r\n<unsafe>\ttext'});
  assert.equal(out.outcome,'send');
  assert(out.emailHtml.includes('&lt;unsafe&gt;'));
  assert(!out.emailHtml.includes('<unsafe>'));
  assert.equal(run('leave-approved',{employeeNote:'bad\u0000note'}).outcome,'rejected');
  assert.equal(run('leave-approved',{employeeName:'name\nheader'}).outcome,'rejected');
});
for (const company of ['mam','equipsy']) test(`${company} decline email delivers reviewer notes to applicant`,()=>{
  const note='Please reapply for fewer paid days.\nUse unpaid leave for the remainder.';
  const out=run('leave-declined',{company,status:'Declined',managerNote:note});
  assert.equal(out.outcome,'send');
  assert.equal(out.deliveryRecipient,'employee@example.test');
  assert.ok(out.emailHtml.includes('Please reapply for fewer paid days.'));
  assert.ok(out.emailHtml.includes('Use unpaid leave for the remainder.'));
  assert.ok(!out.ccRecipients.includes('accounts'));
});
for(const event of ['leave-approved','leave-declined','leave-conditionally-approved']) test(event,()=>{
  const out=run(event,{status:event==='leave-conditionally-approved'?'Approved – pending leave balance':event==='leave-approved'?'Approved':'Declined',managerNote:'<unsafe>'});
  assert.equal(out.deliveryRecipient,'employee@example.test');
  assert.equal(out.ccRecipients,event==='leave-approved'?'career@mobilityaccess.com.au,accounts@mobilityaccess.com.au':'career@mobilityaccess.com.au');
  assert(!out.emailHtml.includes('<unsafe>')); assert.equal(out.emailHtml.includes('&lt;unsafe&gt;'),event!=='leave-approved');
});
test('Accounts receives only approved cancellation',()=>{
  assert.equal(run('leave-cancelled',{wasApproved:true}).ccRecipients,'career@mobilityaccess.com.au,accounts@mobilityaccess.com.au');
  assert.equal(run('leave-cancelled',{wasApproved:false}).ccRecipients,'career@mobilityaccess.com.au');
});
for(const event of ['leave-reminder','team-birthday']) test(event,()=>{
  const out=run(event,{employeeEmail:null,leaveType:event==='team-birthday'?'Birthday':'Annual leave'});
  assert.equal(out.outcome,'send'); assert.equal(out.deliveryRecipient,'manager@example.test'); assert.equal(out.ccRecipients,'');
  if (event === 'team-birthday') assert.equal(out.emailSubject, '[MAM] Team birthday reminder: Test Employee');
});
test('deduplicates sent event and fails closed without a manager',()=>{
  const state={};
  confirmDelivery(run('leave-submitted',{},state),[{json:{statusCode:202}}],state);
  const out=run('leave-submitted',{},state);
  assert.equal(out.outcome,'duplicate'); assert.equal(out.actualRecipient,'career@mobilityaccess.com.au,manager@example.test');
  assert.equal(run('leave-submitted',{managerEmail:null}).outcome,'rejected');
});
test('conditional approval reminder explains the leave balance condition',()=>{
  const out=run('leave-reminder',{status:'Approved – pending leave balance'});
  assert(out.emailHtml.includes('finalise approval'));
  assert(out.emailHtml.includes('approved, subject to sufficient leave balance'));
  assert.equal(out.ccRecipients,'');
});
test('ordinary leave emails omit balance language from their subject and body',()=>{
  const cases = [
    ['leave-submitted', {}],
    ['leave-approved', {status:'Approved'}],
    ['leave-declined', {status:'Declined'}],
    ['leave-cancelled', {status:'Cancelled',wasApproved:true}],
    ['leave-reminder', {status:'Pending'}],
  ];
  for (const [event, extra] of cases) {
    const out = run(event, extra);
    assert.equal(out.outcome, 'send');
    assert(!out.emailSubject.toLowerCase().includes('balance'), `${event} subject`);
    assert(!out.emailHtml.toLowerCase().includes('balance'), `${event} body`);
  }
});
test('reminder cannot re-enable HR CC through the payload',()=>{
  assert.equal(run('leave-reminder',{ccEmails:['career@mobilityaccess.com.au']}).ccRecipients,'');
});
test('manager requests notify every group reviewer and do not duplicate HR in CC',()=>{
  const group='reviewer1@example.test,reviewer2@example.test,career@mobilityaccess.com.au';
  const out=run('leave-submitted',{managerEmail:group});
  assert.equal(out.outcome,'send');
  assert.equal(out.confirmationRecipient,group);
  assert.equal(out.deliveryRecipient,group);
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

test('leave submissions include hours but never include a balance',()=>{
  const out=run('leave-submitted',{leaveBalance:{kind:'annual',status:'current',hours:28.4621}});
  assert.equal(out.outcome,'send');
  assert(out.emailHtml.includes('Hours requested:</strong> 15.2 hours'));
  assert(!out.emailHtml.toLowerCase().includes('balance'));
  assert(!out.emailHtml.includes('28.46'));
  const partial=run('leave-submitted',{hours:3.25,leaveBalance:{kind:'annual',status:'current',hours:2}});
  assert(partial.emailHtml.includes('Hours requested:</strong> 3.25 hours'));
  assert(!partial.emailHtml.toLowerCase().includes('balance'));
});
test('legacy balance snapshots are accepted but never rendered',()=>{
  const out=run('leave-submitted',{leaveBalance:{kind:'annual',status:'check_balance',hours:null}});
  assert.equal(out.outcome,'send');
  assert(!out.emailHtml.toLowerCase().includes('balance'));
});
test('sick submissions contain no balance in either legacy split copy',()=>{
  const extra={leaveType:'Sick leave',leaveBalance:{kind:'sick',status:'current',hours:40.9297}};
  const review=run('leave-submitted',{...extra,audience:'reviewers',managerEmail:'manager@example.test,employee@example.test'});
  assert.equal(review.deliveryRecipient,'manager@example.test,career@mobilityaccess.com.au');
  assert.equal(review.confirmationRecipient,review.deliveryRecipient);
  assert.equal(review.ccRecipients,'');
  assert(!review.emailHtml.toLowerCase().includes('balance'));
  assert(!review.emailHtml.includes('40.93'));
  for(const audience of [undefined,'employee']) {
    const out=run('leave-submitted',{...extra,...(audience?{audience}:{})});
    assert.equal(out.outcome,'send');
    assert(!out.emailHtml.includes('40.93'));
    assert(!out.emailHtml.toLowerCase().includes('balance'));
    if(audience) {assert.equal(out.deliveryRecipient,'employee@example.test');assert.equal(out.ccRecipients,'');}
  }
  const carer=run('leave-submitted',{...extra,leaveType:"Carer's leave",audience:'reviewers'});
  assert(!carer.emailHtml.toLowerCase().includes('balance'));
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
  assert(!out.emailHtml.includes('career@mobilityaccess.com.au'));
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
  const state={};
  confirmDelivery(runPayroll({},state),[{json:{statusCode:202}}],state);
  const out=runPayroll({},state);
  assert.equal(out.outcome,'duplicate');
  assert.equal(out.alreadySent,true);
  assert.equal(out.actualRecipient,'gerard@example.test');
  assert.equal(out.eventKey,eventKey);
});


test('confirmation records both payroll and leave event families after one provider result',()=>{
  for(const family of ['payroll','leave']) {
    const state={};
    const send=family==='payroll'?runPayroll({},state):run('leave-approved',{},state);
    const out=confirmDelivery(send,[{json:{statusCode:202}}],state);
    assert.equal(out.ok,true);
    assert.equal(out.sent,true);
    assert.equal(out.actualRecipient,canonical(send.deliveryRecipient));
    assert.equal(out.eventKey,send.eventKey);
    assert.equal(receiverFor(state).api.rows.get(send.eventKey).state,'sent');
  }
});

test('confirmation rejects unknown keys, count mismatches and explicit provider failures',()=>{
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:'other:event',confirmationRecipient:'recipient@example.test'}),/contract mismatch/);
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:`payroll-balance:${id}:2026-10`,confirmationRecipient:'recipient@example.test'},[]),/count mismatch/);
  assert.throws(()=>confirmDelivery({mamDelivery:true,eventKey:`payroll-balance:${id}:2026-10`,confirmationRecipient:'recipient@example.test'},[{json:{statusCode:500}}]),/provider explicitly rejected/);
});

test('all submission categories isolate the applicant work/personal addresses from reviewers',()=>{
  for(const leaveType of ['Annual leave','Sick leave',"Carer's leave",'Unpaid leave']) {
    const employeeEmails=['employee@example.test','personal@example.test'];
    const reviewerState={},employeeState={};
    const reviewer=run('leave-submitted',{leaveType,employeeEmails,managerEmail:'manager@example.test,personal@example.test'},reviewerState);
    assert.equal(reviewer.deliveryRecipient,'manager@example.test,career@mobilityaccess.com.au');
    const employee=run('leave-submitted',{leaveType,employeeEmails,audience:'employee'},employeeState);
    assert.equal(employee.deliveryRecipient,employeeEmails.join(','));
    assert.equal(employee.ccRecipients,'');
    for(const [out,state] of [[reviewer,reviewerState],[employee,employeeState]]) {
      assert.equal(confirmDelivery(out,[{json:{statusCode:202}}],state).actualRecipient,canonical(out.deliveryRecipient));
    }
  }
  assert.equal(run('leave-submitted',{audience:undefined}).rejectionCode,'audience-required');
});

test('rollout does not resend either copy of an already-delivered legacy shared event',()=>{
  const legacyEventKey=`leave:${id}:leave-submitted:${'b'.repeat(24)}`;
  for(const audience of ['reviewers','employee']) {
    const state={leaveNotificationEvents:{[legacyEventKey]:{state:'sent',at:Date.now()}}};
    const replay=run('leave-submitted',{audience,legacyEventKey},state);
    assert.equal(replay.rejectionCode,'receipt-evidence-unavailable');
    assert.equal(replay.actualRecipient,undefined);
    receiverFor(state).api.rows.get(legacyEventKey).state='processing';
    assert.equal(run('leave-submitted',{audience,legacyEventKey},state).rejectionCode,'delivery-in-flight');
    receiverFor(state).api.rows.get(legacyEventKey).at=Date.now()-21*60*1000;
    assert.equal(run('leave-submitted',{audience,legacyEventKey},state).rejectionCode,'receipt-delivery-unknown');
  }
  assert.equal(run('leave-submitted',{legacyEventKey:'invalid'}).rejectionCode,'legacy-event-key');
});

test('Accounts note minimisation and provider rejection apply equally to Equipsy',()=>{
  for(const company of ['mam','equipsy']) {
    const out=run('leave-approved',{company,status:'Approved',managerNote:'Private manager comment'});
    assert(!out.emailHtml.includes('Private manager comment'));
    for(const result of [{error:'denied'},{success:false},{ok:false},{statusCode:403}]) {
      const state={};
      assert.throws(()=>confirmDelivery(out,[{json:result}],state),/provider explicitly rejected/);
      assert.equal(state.leaveNotificationEvents,undefined);
    }
  }
});
