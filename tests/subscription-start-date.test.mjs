import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/contact-lifetime-harness.mjs';

const id='b3400000-0000-4000-8000-000000000001';
const person='a1000000-0000-4000-8000-000000000004';
const request={formVersion:3,kind:'new_purchase',service:'Synthetic service',purpose:'Work',company:'mam',duration:'ongoing',billing:'annual',currency:'AUD',monthlyCostCents:1200,annualCostCents:10000,quoteCents:10000,audEstimateCents:10000,payment:'direct_debit',intendedUsers:'Synthetic team',category:'subscription'};
const invalidDates=['2026-02-29','2024-02-30','1900-02-29','2026-04-31','2026-00-01','2026-13-01','2026-01-00','0000-01-01','2026-1-01','26-01-01','2026-01-01T00:00:00Z',' 2026-01-01','2026-01-01 ','infinity','10000-01-01'];

test('request start date supports optional V2 and V3 dates without normalizing invalid calendar values',()=>{
  const {validateRequestPayload}=loadModule('src/lib/subscription-request-types.ts');
  for(const formVersion of [2,3])for(const submission of [false,true]) {
    const base=formVersion===2?{...request,formVersion:2,payment:'non_card'}:{...request};
    if(formVersion===2)delete base.category;
    for(const startDate of ['', '0001-01-01','0099-01-01','1900-02-28','2000-02-29','2024-02-29','2026-10-15','9999-12-31']) {
      const value={...base,startDate};assert.deepEqual(validateRequestPayload(value,submission),value);
    }
    assert.doesNotThrow(()=>validateRequestPayload(base,submission));
    for(const startDate of [...invalidDates,null,42])assert.throws(()=>validateRequestPayload({...base,startDate},submission),/date|text/i);
  }
  assert.throws(()=>validateRequestPayload({startDate:'2026-10-15'},false),/field|version/i);
});

const free={company:'mam',serviceName:'Synthetic free service',pricingModel:'free',responsiblePersonId:person,memberPersonIds:[]};
function harness(startDate='2026-10-15',allowed=true) {
  const calls=[];
  const row={subscription_id:id,subscription_code:'MAM-SUB-000001',service_name:free.serviceName,plan_name:null,company_scope:'mam',subscription_status:'active',pricing_model:'free',billing_cycle:null,amount_cents:null,currency_code:'AUD',renewal_date:null,start_date:startDate,seat_count:null,credit_card_used:null,credit_card_holder:null,billing_anchor_date:null,next_billing_on:null,last_reviewed_on:null,next_review_on:'2026-12-01',responsible_person_id:person,responsible_person_name:'Synthetic owner',responsible_person_title:'Synthetic role',member_person_ids:[],member_names:[],created_at:'2026-10-15T00:00:00Z',version:4};
  const actions=loadModule('src/app/subscriptions/actions.ts',{'next/cache':{revalidatePath:()=>{}},'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:person}},error:null})},rpc:async(name,args)=>{calls.push({name,args});return {data:name.startsWith('can_')?allowed:name==='list_subscriptions_v2'?[row]:row,error:null};}})}});
  return {actions,calls,writes:()=>calls.filter(call=>/^(create|update)_subscription/.test(call.name))};
}

test('register start date maps from the credential-free read projection',async()=>{
  const h=harness();assert.equal((await h.actions.listSubscriptions())[0].startDate,'2026-10-15');
  const legacy=harness(null);assert.equal((await legacy.actions.listSubscriptions())[0].startDate,null);
  for(const value of ['2026-02-29','2026-01-01T00:00:00Z'])await assert.rejects(harness(value).actions.listSubscriptions(),/could not be loaded/i);
});

for(const operation of ['createSubscription','updateSubscription'])test(operation+' sends explicit date or clear through V5 and preserves omitted legacy updates',async()=>{
  const base=operation==='updateSubscription'?{...free,subscriptionId:id,version:3,status:'active'}:free;
  for(const startDate of ['2024-02-29',null,'']) {
    const h=harness(startDate||null);const result=await h.actions[operation]({...base,startDate});
    assert.equal(result.startDate,startDate||null);assert.equal(h.writes().length,1);
    assert.equal(h.writes()[0].name,operation==='updateSubscription'?'update_subscription_v5':'create_subscription_v5');
    assert.equal(h.writes()[0].args.p_start_date,startDate||null);
    if(operation==='updateSubscription')assert.equal(h.writes()[0].args.p_expected_version,3);
  }
  const legacy=harness();await legacy.actions[operation](base);assert.equal(legacy.writes()[0].name,operation==='updateSubscription'?'update_subscription_v4':'create_subscription_v4');assert.equal(Object.hasOwn(legacy.writes()[0].args,'p_start_date'),false);
  for(const startDate of invalidDates) {
    const invalid=harness();await assert.rejects(invalid.actions[operation]({...base,startDate}),/Start date/i);assert.equal(invalid.writes().length,0);
  }
  const denied=harness(null,false);await assert.rejects(denied.actions[operation]({...base,startDate:'2026-10-15'}),/permission/i);assert.equal(denied.writes().length,0);
});
