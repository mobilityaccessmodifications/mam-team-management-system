import {buildReviewDocx} from '../src/lib/performance-review-word.mjs';
import {QUESTIONS} from '../src/lib/performance-review-questions.mjs';
import {loadModule} from './helpers/contact-lifetime-harness.mjs';
import {document, meeting} from './performance-review-backend-fixtures.mjs';
export const download=loadModule('src/lib/performance-review-document.ts',{'./performance-review-word.mjs':{buildReviewDocx},'./performance-review-questions.mjs':{QUESTIONS}}).buildPerformanceReviewDownload;
export function ordinary(company='MAM') {
 const d=document('manager');delete d.goals;d.employee.company=company;d.selfAnswers.fill('Self evidence');d.managerAnswers.fill('Manager evidence');d.ratings.fill('2 Meets expectations');d.summary='Summary';d.overallRating='2 Meets expectations';d.meeting={...meeting,date:'2026-01-02'};return d;
}
export function blank(company) {
 const d=ordinary(company);for(const key of ['name','jobTitle','team'])d.employee[key]='';d.manager.name='';d.code='';d.cycle='';d.selfAnswers.fill('');d.managerAnswers.fill('');d.ratings.fill('');d.summary='';d.overallRating='';d.meeting={date:'',time:'',duration:'',mode:'',location:'',notes:''};return d;
}
export const blankBytes=company=>buildReviewDocx(blank(company),QUESTIONS[company]);
export function valueBytes(value) {
 const normalized=value.replace(/\r\n?/g,'\n');
 const escaped=normalized.replace(/[\n\t]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 return Buffer.byteLength(escaped)+39*(normalized.match(/\n/g)?.length??0)+40*(normalized.match(/\t/g)?.length??0);
}
export function sourceSize(d) {
 const m=d.meeting;
 const fields=[d.employee.name,d.employee.jobTitle,d.employee.team,d.manager.name,d.code,d.cycle,d.summary,d.overallRating,d.overallRating,m.date,m.date,m.time,m.time,String(m.duration),m.mode,m.location,m.notes,...d.selfAnswers,...d.managerAnswers,...[0,1,2,6,7,8,9].map(i=>d.ratings[i])];
 return blankBytes(d.employee.company).length+fields.reduce((n,v)=>n+valueBytes(v),0);
}
export function atLimit(d,limit=2097152) {
 d.selfAnswers.fill('x'.repeat(8000));d.managerAnswers.fill('x'.repeat(8000));d.meeting.notes='';
 let remaining=limit-sourceSize(d);
 if(remaining<0)throw Error('Unexpected baseline overflow');
 for(const list of [d.selfAnswers,d.managerAnswers])for(let i=0;i<12;i++) {
  const n=Math.min(7999,Math.floor(remaining/38));list[i]='\n'.repeat(n)+'x'.repeat(8000-n);remaining-=n*38;
 }
 if(remaining>=8000)throw Error('Boundary is unreachable');
 d.meeting.notes='x'.repeat(remaining);return d;
}
export function parityCases() {
 const cases=[];
 for(const company of ['MAM','Equipsy']) {
  const push=(label,d)=>cases.push({label:company+':'+label,document:d});
  push('ordinary',ordinary(company));
  for(const value of ['a'.repeat(8000),"'".repeat(8000),'🦽'.repeat(4000),'R\n'.repeat(3998)+'END','\t'.repeat(7999)+'X','\r\n'.repeat(3999)+'X']) {
   const d=ordinary(company);d.selfAnswers.fill(value);d.managerAnswers.fill(value);d.summary=value;d.meeting.location=value;d.meeting.notes=value;push('extreme-'+cases.length,d);
  }
  const paths=[['employee','name'],['employee','jobTitle'],['employee','team'],['manager','name'],['summary'],['meeting','date'],['meeting','time'],['meeting','duration'],['meeting','mode'],['meeting','location'],['meeting','notes'],['overallRating'],...Array.from({length:12},(_,i)=>['selfAnswers',i]),...Array.from({length:12},(_,i)=>['managerAnswers',i]),...Array.from({length:12},(_,i)=>['ratings',i])];
  for(const path of paths) {
   const d=ordinary(company);let target=d;for(const k of path.slice(0,-1))target=target[k];target[path.at(-1)]=path.at(-1)==='duration'?480:"&<>\"'🦽\r\n\n\r\t e\u0301\u0085\ufffd\u{10ffff}";
   push('field-'+path.join('.'),d);
  }
  for(const size of [2097151,2097152,2097153])push('limit-'+size,atLimit(ordinary(company),size));
 }
 return cases;
}
