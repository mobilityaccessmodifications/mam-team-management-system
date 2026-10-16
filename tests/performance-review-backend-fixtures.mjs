export const actorId='10000000-0000-4000-8000-000000000001';
export const personId='20000000-0000-4000-8000-000000000001';
export const managerId='20000000-0000-4000-8000-000000000002';
export const reviewId='30000000-0000-4000-8000-000000000001';
export const operationId='40000000-0000-4000-8000-000000000001';
export const identity={id:personId,name:'Synthetic employee',jobTitle:'Synthetic role',company:'MAM',team:'Synthetic team'};
export const meeting={date:'2026-10-16',time:'10:00',duration:30,mode:'in_person',location:'Synthetic room',notes:''};
export function review(audience='employee') {
 const base={id:reviewId,code:'PR-2026-1',employee:{...identity},manager:{id:managerId,name:'Synthetic manager'},cycle:'2026',dueDate:'2026-12-31',selfStatus:'awaiting_employee',selfAnswers:Array(12).fill(''),selfSubmittedAt:null,selfRevision:'self:0',selfActivity:[],audience};
 if(audience==='employee') return {...base,capabilities:{saveSelf:true,submitSelf:true,downloadDocument:true}};
 return {...base,managerAnswers:Array(12).fill(''),ratings:Array(12).fill(''),summary:'',overallRating:'',managerNote:'',managerCompletedAt:null,meeting:null,meetingHeldAt:null,finalisedAt:null,managerActivity:[],[audience==='manager'?'managerRevision':'readRevision']:audience==='manager'?'manager:0:0':'read:0:0',capabilities:{saveSelf:false,submitSelf:false,saveManager:false,completeManager:false,saveMeeting:false,submitReview:false,downloadDocument:true}};
}
export function document(audience='employee') {
 const r=review(audience);const result={audience,code:r.code,cycle:r.cycle,employee:r.employee,manager:r.manager,selfAnswers:r.selfAnswers};
 return audience==='employee'?result:{...result,managerAnswers:r.managerAnswers,ratings:r.ratings,summary:r.summary,overallRating:r.overallRating,meeting:r.meeting};
}
export const start=()=>({operationId,employeePersonId:personId,cycle:'2026',dueDate:'2026-12-31'});
export const mutation=()=>({operationId,reviewId,expectedRevision:'self:0',command:'save_self',input:{answers:Array(12).fill('')}});
