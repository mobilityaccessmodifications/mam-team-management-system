import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const balance={};
new Function('exports',ts.transpileModule(fs.readFileSync('src/lib/leave-request-balance.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(balance);
function render({available=8,status='projected',key,loading=false}={}) {
  const calls=[];let state=0;
  const projection={status,projectedDate:'2026-10-12',availableHours:available};
  const imports={
    react:{useRef:v=>({current:v}),useEffect(){},useState:v=>[++state===3?(loading?null:{key:key??JSON.stringify(['self','2026-10-12',null]),data:projection}):v,()=>{}]},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},
    'lucide-react':{},'@/app/leave/actions':{},'@/components/leave-priority-controls':{LeaveRequestBalance:'balance'},
    '@/components/ui/modal-backdrop':{ModalBackdrop:'backdrop'},'@/components/ui/use-dialog-focus':{useDialogFocus(){}},
    '@/lib/leave-attachments':{},'@/lib/leave-request-options':{START_TIME_OPTIONS:[],END_TIME_OPTIONS:[]},
    '@/lib/leave-priority':{},'@/lib/victorian-public-holidays':{getVictorianPublicHolidays:()=>[]},
    '@/lib/leave-notice':{requiresLeaveNotice:()=>false,LEAVE_NOTICE_MESSAGE:'notice'},
    '@/lib/leave-request-balance':balance,'@/components/leave-demo.module.css':{default:{}},
  };
  const mod={};new Function('exports','require',ts.transpileModule(fs.readFileSync('src/components/leave-request-dialog.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(mod,id=>{assert.ok(id in imports,id);return imports[id];});
  const root=mod.LeaveRequestDialog({activeProfile:{id:'self'},requestForPersonId:'',teamRequestPeople:[],canApplyForLeave:true,
    leavePriority:{people:[{personId:'self',annualAvailableHours:1,requestFullDayHours:7.6}]},employmentType:'full_time',
    formLeaveType:'Annual leave',availableLeaveTypes:[],hasPaidLeaveEntitlement:true,formStartDate:'2026-10-12',formEndDate:'2026-10-12',formError:'',
    setFormError:error=>calls.push(error),submitRequest:()=>calls.push('submitted')});
  const nodes=x=>!x||typeof x!=='object'?[]:Array.isArray(x)?x.flatMap(nodes):[x,...nodes(x.props?.children)];
  return {calls,nodes:nodes(root)};
}
test('form permits projected coverage rather than blocking on banked-only balance',()=>{
  const {calls,nodes}=render();nodes.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
  assert.deepEqual(calls,['submitted']);
});
test('form blocks insufficient projection and preserves banked-only diagnostic',()=>{
  for(const [status,error] of [['projected',balance.INSUFFICIENT_BALANCE_MESSAGE],['banked_only',balance.UNCONFIRMED_ACCRUAL_MESSAGE]]){
    const {calls,nodes}=render({status,available:7.59});nodes.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls,[error]);
  }
});
test('form never submits with a projection for an older person/date or while loading',()=>{
  for(const options of [{key:'old person/date'},{loading:true}]){
    const {calls,nodes}=render(options);assert.equal(nodes.find(n=>n.props?.type==='submit').props.disabled,true);
    nodes.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls,[balance.UNAVAILABLE_BALANCE_MESSAGE]);
  }
});
