"use client";

import { useRef, useState } from "react";
import { activateSubscriptionRequest, completeSubscriptionRequestPurchase, downloadRequestEvidence, loadSubscriptionRequests, mutateSubscriptionRequest } from "@/app/subscription-requests/actions";
import { validateRequestPayload, validateRequestFinance, type RequestFinance, type RequestActivation, type RequestEvidence, type RequestOperation, type RequestPayload, type RequestResult, type RequestWorkspace, type SubscriptionRequest } from "@/lib/subscription-request-types";
import { formatRequestAmount, parseRequestAmount, withSelectedRequestCost } from "@/lib/subscription-request-form";
import { SubscriptionRequestActivation, SubscriptionRequestCredentials } from "./subscription-request-activation";
import styles from "./subscription-requests.module.css";

const initialRequestPayload: RequestPayload = {formVersion:2,kind:"new_purchase",company:"mam",duration:"ongoing",billing:"annual",currency:"AUD",payment:"card"};
function requestFinance(row: SubscriptionRequest | null, payload: RequestPayload): RequestFinance {
  return {budgetApproved:row?.finance?.budgetApproved??false,invoiceEmail:row?.finance?.invoiceEmail??payload.invoiceEmail??"",invoiceContact:row?.finance?.invoiceContact??payload.invoiceContact??""};
}
async function evidenceFiles(files: File[]): Promise<RequestEvidence[]> {
  if (files.length>3 || files.reduce((sum,file)=>sum+file.size,0)>500000) throw new Error("Use at most three evidence files, 500 KB total.");
  return Promise.all(files.map(file=>new Promise<RequestEvidence>((resolve,reject)=>{
    const reader=new FileReader(); reader.onerror=()=>reject(new Error("Evidence could not be read."));
    reader.onload=()=>resolve({name:file.name,mime:file.type,base64:String(reader.result).split(",")[1]}); reader.readAsDataURL(file);
  })));
}
export function SubscriptionRequests({ initial, selectedId, startNew = false }: { initial: RequestWorkspace; selectedId?: string; startNew?: boolean }) {
  const [workspace,setWorkspace]=useState(initial);
  const initialPayload: RequestPayload = {...initialRequestPayload,...(workspace.requestFormVersion===3?{formVersion:3,category:"subscription"}:{})};
  const [selected,setSelected]=useState<SubscriptionRequest | null>(()=>initial.requests.find(r=>r.id===selectedId)??null);
  const [newId,setNewId]=useState<string | null>(()=>startNew&&!selectedId&&initial.canApply&&initial.enabled?crypto.randomUUID():null);
  const [payload,setPayload]=useState<RequestPayload>(selected?.payload??initialPayload);
  const [files,setFiles]=useState<File[] | null>(null);
  const [reason,setReason]=useState("");
  const [message,setMessage]=useState("");
  const [isError,setIsError]=useState(false);
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const [denied,setDenied]=useState(false);
  const [monthlyAmount,setMonthlyAmount]=useState(formatRequestAmount(selected?.payload.monthlyCostCents));
  const [annualAmount,setAnnualAmount]=useState(formatRequestAmount(selected?.payload.annualCostCents));
  const [oneOffAmount,setOneOffAmount]=useState(formatRequestAmount(selected?.payload.oneOffCostCents));
  const [finance,setFinance]=useState<RequestFinance>(()=>requestFinance(selected,payload));
  const busyRef=useRef(false);
  const deniedRef=useRef(false);
  const editable=workspace.enabled && (selected?.canEdit ?? (workspace.canApply && newId!==null));
  const blocked=busy||uncertain;
  function failure(result: Extract<RequestResult<unknown>,{ok:false}>) {
    if(result.denied) {
      deniedRef.current=true;setDenied(true);
      setWorkspace({enabled:false,canApply:false,requests:[],people:[]});
      setSelected(null);setNewId(null);setPayload({...initialPayload});setFiles(null);setReason("");setUncertain(false);setMonthlyAmount("");setAnnualAmount("");setOneOffAmount("");setFinance(requestFinance(null,initialPayload));
    }
    setIsError(true);setMessage(result.message);
  }
  function choose(row: SubscriptionRequest) {
    if(busyRef.current || deniedRef.current || uncertain) return;
    setSelected(row);setNewId(null);setPayload(row.payload);setFiles(null);setReason("");setMessage("");setMonthlyAmount(formatRequestAmount(row.payload.monthlyCostCents));setAnnualAmount(formatRequestAmount(row.payload.annualCostCents));setOneOffAmount(formatRequestAmount(row.payload.oneOffCostCents));setFinance(requestFinance(row,row.payload));
  }
  function create() {
    if(busyRef.current || deniedRef.current || uncertain) return;
    setNewId(crypto.randomUUID());setSelected(null);setPayload({...initialPayload});setFiles(null);setReason("");setMessage("");setMonthlyAmount("");setAnnualAmount("");setOneOffAmount("");setFinance(requestFinance(null,initialPayload));
  }
  async function reload() {
    if(busyRef.current || deniedRef.current) return;
    busyRef.current=true;setBusy(true);
    try {
      const result=await loadSubscriptionRequests();
      if(!result.ok) {failure(result);return;}
      setWorkspace(result.data);
      const row=result.data.requests.find(r=>r.id===(selected?.id??newId));
      if(row) {setSelected(row);setNewId(null);setPayload(row.payload);setFiles(null);setMonthlyAmount(formatRequestAmount(row.payload.monthlyCostCents));setAnnualAmount(formatRequestAmount(row.payload.annualCostCents));setOneOffAmount(formatRequestAmount(row.payload.oneOffCostCents));setFinance(requestFinance(row,row.payload));}
      else if(selected) {setSelected(null);setNewId(null);setPayload({...initialPayload});setFiles(null);setReason("");setMonthlyAmount("");setAnnualAmount("");setOneOffAmount("");setFinance(requestFinance(null,initialPayload));}
      setUncertain(false);setMessage("Reloaded.");setIsError(false);
    } catch {setIsError(true);setMessage("Requests could not be loaded.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function run(operation: RequestOperation) {
    if(busyRef.current||deniedRef.current||uncertain||!workspace.enabled) return;
    const id=selected?.id??newId; if(!id) return;
    busyRef.current=true;setBusy(true);setMessage("");setIsError(false);
    let dispatched=false;
    try {
      const outgoing=payload.formVersion===2||payload.formVersion===3?withSelectedRequestCost({...payload,monthlyCostCents:payload.billing==="one_off"?null:parseRequestAmount(monthlyAmount),annualCostCents:payload.billing==="one_off"?null:parseRequestAmount(annualAmount),...(payload.formVersion===3?{oneOffCostCents:parseRequestAmount(oneOffAmount)}:{})}):payload;
      if(operation==="save"||operation==="submit") validateRequestPayload(outgoing,operation==="submit");
      const decisionFinance=payload.formVersion===3&&["approve","return","reject"].includes(operation)?validateRequestFinance(finance,operation):undefined;
      if(operation==="approve"&&decisionFinance&&payload.payment==="invoice"&&!decisionFinance.invoiceEmail?.trim()&&!decisionFinance.invoiceContact?.trim()) throw new Error("Provide the invoice email or contact.");
      const evidence=files===null?undefined:await evidenceFiles(files);
      dispatched=true;
      const result=await mutateSubscriptionRequest({id,version:selected?.version??0,operation,payload:outgoing,reason,evidence,finance:decisionFinance});
      if(!result.ok) {setUncertain(result.uncertain===true);failure(result);return;}
      setWorkspace(current=>({...current,requests:[result.data,...current.requests.filter(r=>r.id!==id)]}));
      setSelected(result.data);setNewId(null);setPayload(result.data.payload);setFiles(null);setReason("");setMonthlyAmount(formatRequestAmount(result.data.payload.monthlyCostCents));setAnnualAmount(formatRequestAmount(result.data.payload.annualCostCents));setOneOffAmount(formatRequestAmount(result.data.payload.oneOffCostCents));setFinance(requestFinance(result.data,result.data.payload));setMessage(operation==="save"?"Saved.":"Request updated.");
    } catch(error) {setMessage(dispatched?"The request could not be confirmed. Reload before retrying.":error instanceof Error?error.message:"Check the request fields.");setIsError(true);setUncertain(dispatched);}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function activate(input: Omit<RequestActivation,"id"|"version">) {
    if(busyRef.current||deniedRef.current||uncertain||!workspace.enabled||!selected?.canActivate) return;
    busyRef.current=true;setBusy(true);setMessage("");setIsError(false);
    try {
      const result=await activateSubscriptionRequest({...input,id:selected.id,version:selected.version});
      if(!result.ok) {setUncertain(result.uncertain===true);failure(result);return;}
      setWorkspace(current=>({...current,requests:current.requests.map(r=>r.id===result.data.id?result.data:r)}));setSelected(result.data);setPayload(result.data.payload);setMessage("Subscription added.");
    } catch {setUncertain(true);setIsError(true);setMessage("The request could not be confirmed. Reload before retrying.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function completePurchase() {
    if(busyRef.current||deniedRef.current||uncertain||!workspace.enabled||!selected?.canCompletePurchase) return;
    busyRef.current=true;setBusy(true);setMessage("");setIsError(false);
    try {
      const result=await completeSubscriptionRequestPurchase(selected.id,selected.version);
      if(!result.ok) {setUncertain(result.uncertain===true);failure(result);return;}
      setWorkspace(current=>({...current,requests:current.requests.map(r=>r.id===result.data.id?result.data:r)}));setSelected(result.data);setPayload(result.data.payload);setMessage("Purchase recorded.");
    } catch {setUncertain(true);setIsError(true);setMessage("The request could not be confirmed. Reload before retrying.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function download(version: number,index: number) {
    if(busyRef.current||deniedRef.current||!selected) return;
    busyRef.current=true;setBusy(true);
    try {
      const result=await downloadRequestEvidence(selected.id,version,index);
      if(!result.ok) {failure(result);return;}
      const bytes=Uint8Array.from(atob(result.data.base64),char=>char.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:result.data.mime}));
      const link=document.createElement("a");link.href=url;link.download=result.data.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch {setIsError(true);setMessage("Evidence could not be downloaded.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  function textField(key: keyof RequestPayload,label: string,area=false) {
    const value=payload[key]??"";
    const maxLength=key==="websiteUrl"?2048:key==="invoiceEmail"?254:(payload.formVersion===2||payload.formVersion===3)&&["service","cardLabel","cardHolder","invoiceContact"].includes(key)?160:4000;
    return <label key={key}>{label}{area?<textarea value={String(value)} maxLength={maxLength} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value}))}/>:<input type={key==="websiteUrl"?"url":key==="invoiceEmail"?"email":"text"} value={String(value)} maxLength={maxLength} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value}))}/>}</label>;
  }
  function choice(key: keyof RequestPayload,label: string,options: [string,string][]) {
    return <label>{label}<select aria-label={label} value={String(payload[key]??"")} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value,...(key==="category"&&e.target.value==="one_off_service"?{billing:"one_off"}:{})}))}>{options.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>;
  }
  return <section className={styles.workspace} aria-label="Subscription requests" aria-busy={busy}>
    <header className={styles.toolbar}><h1>Requests</h1><button type="button" onClick={()=>void reload()} disabled={busy||denied}>Reload</button>{workspace.canApply&&workspace.enabled?<button type="button" onClick={create} disabled={blocked}>New request</button>:null}</header>
    {!workspace.enabled?<p role="status">Subscription requests are not enabled.</p>:null}
    {message?<p role={isError?"alert":"status"}>{message}</p>:null}
    <div className={styles.columns}>
      <nav aria-label="Request list">{workspace.requests.map(r=><button type="button" key={r.id} disabled={blocked} aria-pressed={selected?.id===r.id} onClick={()=>choose(r)}>{r.payload.service||"Untitled request"} — {r.status}</button>)}</nav>
      {selected||newId?<div><h2>{selected?.completedAt?"Approved — purchase recorded":selected?.status==="approved"?(selected.linkedSubscriptionId?"Approved — subscription added":payload.formVersion===3&&payload.billing==="one_off"?"Approved — ready to record purchase":payload.formVersion===2||payload.formVersion===3?"Approved — ready to register":"Approved — pending procurement"):selected?.status??"draft"}</h2>
        <form onSubmit={event=>{event.preventDefault();void run("submit");}}>
          <div className={styles.fields}>
            {payload.formVersion===2||payload.formVersion===3?<>
              <label>Requested by<input value={selected?.applicantName??workspace.viewerName??""} disabled /></label>
              {selected?.requestedAt?<label>Date requested<input value={new Date(selected.requestedAt).toLocaleString("en-AU",{timeZone:"Australia/Melbourne"})} disabled/></label>:null}
              {textField("service","Service")}{textField("purpose","Purpose",true)}
              {payload.formVersion===3?<>{textField("websiteUrl","Website link")}{choice("category","Category",[["software_app","Software / App"],["hardware","Hardware"],["subscription","Subscription"],["one_off_service","One-off service"]])}</>:null}
              {choice("company","Benefiting company",[["mam","MAM"],["equipsy","Equipsy"],["both","Both"]])}
              {textField("intendedUsers","Intended users",true)}
              {choice("duration","Expected usage",[["ongoing","Ongoing"],["3_months","3 months"],["12_months","12 months"]])}
              {payload.formVersion===3?textField("usageFrequency","Usage frequency"):null}
              {payload.billing!=="one_off"?<><label>Monthly cost (AUD)<input inputMode="decimal" value={monthlyAmount} disabled={!editable||blocked} onChange={e=>setMonthlyAmount(e.target.value)} /></label>
              <label>Annual cost (AUD)<input inputMode="decimal" value={annualAmount} disabled={!editable||blocked} onChange={e=>setAnnualAmount(e.target.value)} /></label></>:null}
              {choice("billing","Preferred billing",[["monthly","Paid monthly"],["annual","Paid annually"],...(payload.formVersion===3?[["one_off","One-off"]] as [string,string][]:[])])}
              {payload.billing!=="one_off"?textField("comparisonUnavailableReason","Alternative quote unavailable reason"):null}
              {payload.formVersion===3?<label>One-off cost (AUD)<input inputMode="decimal" value={oneOffAmount} disabled={!editable||blocked} onChange={e=>setOneOffAmount(e.target.value)}/></label>:null}
            </>:<>
            {choice("kind","Request type",[["new_purchase","New purchase"],["renewal","Renewal"],["added_seats","Added seats"],["plan_change","Plan change"]])}
            {textField("service","Service")}{textField("plan","Plan")}{textField("purpose","Purpose",true)}
            {choice("company","Benefiting company",[["mam","MAM"],["equipsy","Equipsy"],["both","Both"]])}
            {textField("payer","Payer")}{textField("duration","Usage duration")}
            {choice("billing","Billing cadence",[["monthly","Monthly"],["annual","Annual"],["one_off","One-off"],["other","Other"]])}
            {textField("currency","Original currency")}{textField("tax","Tax basis")}
            {([['quoteCents','Original quote (cents)'],['audEstimateCents','AUD estimate (cents)']] as const).map(([key,label])=><label key={key}>{label}<input type="number" min={0} max={100000000} step={1} disabled={!editable||blocked} value={payload[key]??""} onChange={e=>setPayload(p=>({...p,[key]:e.target.value===""?null:Number(e.target.value)}))}/></label>)}
            {textField("noQuoteReason","Missing quote reason")}
            </>}
            {choice("payment","Payment method",payload.formVersion===3?[["card","Card"],["invoice","Invoice"],["direct_debit","Direct debit"]]:[["non_card","Non-card"],["card","Card"]])}
            {payload.payment==="card"?<>{textField("cardLabel","Card label")}{textField("cardHolder","Card holder")}</>:null}
            {payload.formVersion===3&&payload.payment==="invoice"?<>{textField("invoiceEmail","Invoice email")}{textField("invoiceContact","Invoice contact")}</>:null}
            {payload.formVersion!==2&&payload.formVersion!==3?<><label>Responsible person<select value={payload.responsiblePersonId??""} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,responsiblePersonId:e.target.value||null}))}><option value="">Applicant default</option>{workspace.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{textField("intendedUsers","Intended users",true)}</>:null}
            {editable?<label>Evidence (PDF, PNG, JPEG; no credentials)<input type="file" accept="application/pdf,image/png,image/jpeg" multiple disabled={blocked} onChange={e=>setFiles(Array.from(e.target.files??[]))}/></label>:null}
          </div>
          {editable?<div className={styles.toolbar}><button type="button" disabled={blocked} onClick={()=>void run("save")}>Save draft</button><button type="submit" disabled={blocked}>{selected?.status==="returned"?"Resubmit":"Submit"}</button><button type="button" disabled={blocked} onClick={()=>setFiles([])}>Remove draft evidence</button></div>:null}
        </form>
        {selected?.finance?<section aria-label="Finance approval"><h2>Finance approval</h2><dl><dt>Budget approved</dt><dd>{selected.finance.budgetApproved?"Yes":"No"}</dd>{selected.finance.approvedByName?<><dt>Approved by</dt><dd>{selected.finance.approvedByName}</dd></>:null}{selected.finance.approvedAt?<><dt>Date of approval</dt><dd>{new Date(selected.finance.approvedAt).toLocaleString("en-AU",{timeZone:"Australia/Melbourne"})}</dd></>:null}{selected.finance.invoiceEmail?<><dt>Invoice email</dt><dd>{selected.finance.invoiceEmail}</dd></>:null}{selected.finance.invoiceContact?<><dt>Invoice contact</dt><dd>{selected.finance.invoiceContact}</dd></>:null}</dl></section>:null}
        {selected?.canDecide&&workspace.enabled?<div className={styles.decisions}>{payload.formVersion===3?<fieldset disabled={blocked}><legend>Finance decision</legend><label className={styles.member}><input type="checkbox" checked={finance.budgetApproved} onChange={e=>setFinance(f=>({...f,budgetApproved:e.target.checked}))}/>Budget approved</label>{payload.payment==="invoice"?<><label>Approval invoice email<input type="email" maxLength={254} value={finance.invoiceEmail??""} onChange={e=>setFinance(f=>({...f,invoiceEmail:e.target.value}))}/></label><label>Approval invoice contact<input maxLength={160} value={finance.invoiceContact??""} onChange={e=>setFinance(f=>({...f,invoiceContact:e.target.value}))}/></label></>:null}</fieldset>:null}<label>Decision reason<textarea value={reason} maxLength={4000} disabled={blocked} onChange={e=>setReason(e.target.value)}/></label><div className={styles.toolbar}>{([['approve','Approve'],['return','Return'],['reject','Reject']] as const).map(([operation,label])=><button key={operation} type="button" disabled={blocked} onClick={()=>void run(operation)}>{label}</button>)}</div></div>:null}
        {selected?.canWithdraw&&workspace.enabled?<button type="button" disabled={blocked} onClick={()=>void run("withdraw")}>Withdraw</button>:null}
        {selected?.canCompletePurchase&&workspace.enabled?<button type="button" disabled={blocked} onClick={()=>void completePurchase()}>Record purchase</button>:null}
        {selected?.canActivate&&workspace.enabled?<SubscriptionRequestActivation key={selected.id+":"+selected.version} people={workspace.people} defaultPersonId={workspace.viewerPersonId??""} disabled={blocked} onActivate={input=>void activate(input)}/>:null}
        {selected?.linkedSubscriptionId&&workspace.canManageCredentials&&workspace.enabled?<SubscriptionRequestCredentials key={selected.id+":"+selected.linkedSubscriptionId} subscriptionId={selected.linkedSubscriptionId} disabled={blocked}/>:null}
        {selected?<section aria-label="Request history"><h2>History</h2>{selected.events.map(event=><details key={event.version}><summary>Version {event.version} — {event.operation}</summary><p>{new Date(event.at).toLocaleString("en-AU",{timeZone:"Australia/Melbourne"})} — {event.actorName??"Unknown actor"}{event.reason?` — ${event.reason}`:""}</p><pre>{JSON.stringify(event.payload,null,2)}</pre>{event.evidence.map((e,index)=><button type="button" key={index} disabled={busy} onClick={()=>void download(event.version,index)}>Download {e.name}</button>)}</details>)}</section>:null}
      </div>:null}
    </div>
  </section>;
}
