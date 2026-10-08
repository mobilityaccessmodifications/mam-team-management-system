"use client";

import { useRef, useState } from "react";
import { downloadRequestEvidence, loadSubscriptionRequests, mutateSubscriptionRequest } from "@/app/subscription-requests/actions";
import { validateRequestPayload, type RequestEvidence, type RequestOperation, type RequestPayload, type RequestWorkspace, type SubscriptionRequest } from "@/lib/subscription-request-types";
import styles from "./subscription-requests.module.css";

const initialPayload: RequestPayload = {kind:"new_purchase",company:"mam",billing:"annual",currency:"AUD",payment:"non_card"};
async function evidenceFiles(files: File[]): Promise<RequestEvidence[]> {
  if (files.length>3 || files.reduce((sum,file)=>sum+file.size,0)>500000) throw new Error("Use at most three evidence files, 500 KB total.");
  return Promise.all(files.map(file=>new Promise<RequestEvidence>((resolve,reject)=>{
    const reader=new FileReader(); reader.onerror=()=>reject(new Error("Evidence could not be read."));
    reader.onload=()=>resolve({name:file.name,mime:file.type,base64:String(reader.result).split(",")[1]}); reader.readAsDataURL(file);
  })));
}
export function SubscriptionRequests({ initial, selectedId }: { initial: RequestWorkspace; selectedId?: string }) {
  const [workspace,setWorkspace]=useState(initial);
  const [selected,setSelected]=useState<SubscriptionRequest | null>(()=>initial.requests.find(r=>r.id===selectedId)??null);
  const [newId,setNewId]=useState<string | null>(null);
  const [payload,setPayload]=useState<RequestPayload>(selected?.payload??initialPayload);
  const [files,setFiles]=useState<File[] | null>(null);
  const [reason,setReason]=useState("");
  const [message,setMessage]=useState("");
  const [isError,setIsError]=useState(false);
  const [busy,setBusy]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const busyRef=useRef(false);
  const editable=workspace.enabled && (selected?.canEdit ?? (workspace.canApply && newId!==null));
  const blocked=busy||uncertain;
  function choose(row: SubscriptionRequest) {
    if(busyRef.current || uncertain) return;
    setSelected(row);setNewId(null);setPayload(row.payload);setFiles(null);setReason("");setMessage("");
  }
  function create() {
    if(busyRef.current || uncertain) return;
    setNewId(crypto.randomUUID());setSelected(null);setPayload({...initialPayload});setFiles(null);setReason("");setMessage("");
  }
  async function reload() {
    if(busyRef.current) return;
    busyRef.current=true;setBusy(true);
    try {
      const result=await loadSubscriptionRequests();
      if(!result.ok) {setIsError(true);setMessage(result.message);return;}
      setWorkspace(result.data);
      const row=result.data.requests.find(r=>r.id===(selected?.id??newId));
      if(row) {setSelected(row);setNewId(null);setPayload(row.payload);setFiles(null);}
      else if(selected) {setSelected(null);setNewId(null);setPayload({...initialPayload});setFiles(null);setReason("");}
      setUncertain(false);setMessage("Reloaded.");setIsError(false);
    } catch {setIsError(true);setMessage("Requests could not be loaded.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function run(operation: RequestOperation) {
    if(busyRef.current||uncertain||!workspace.enabled) return;
    const id=selected?.id??newId; if(!id) return;
    busyRef.current=true;setBusy(true);setMessage("");setIsError(false);
    let dispatched=false;
    try {
      if(operation==="save"||operation==="submit") validateRequestPayload(payload,operation==="submit");
      const evidence=files===null?undefined:await evidenceFiles(files);
      dispatched=true;
      const result=await mutateSubscriptionRequest({id,version:selected?.version??0,operation,payload,reason,evidence});
      if(!result.ok) {setMessage(result.message);setIsError(true);setUncertain(result.uncertain===true);return;}
      setWorkspace(current=>({...current,requests:[result.data,...current.requests.filter(r=>r.id!==id)]}));
      setSelected(result.data);setNewId(null);setPayload(result.data.payload);setFiles(null);setReason("");setMessage(operation==="save"?"Saved.":"Request updated.");
    } catch(error) {setMessage(dispatched?"The request could not be confirmed. Reload before retrying.":error instanceof Error?error.message:"Check the request fields.");setIsError(true);setUncertain(dispatched);}
    finally {busyRef.current=false;setBusy(false);}
  }
  async function download(version: number,index: number) {
    if(busyRef.current||!selected) return;
    busyRef.current=true;setBusy(true);
    try {
      const result=await downloadRequestEvidence(selected.id,version,index);
      if(!result.ok) {setIsError(true);setMessage(result.message);return;}
      const bytes=Uint8Array.from(atob(result.data.base64),char=>char.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:result.data.mime}));
      const link=document.createElement("a");link.href=url;link.download=result.data.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch {setIsError(true);setMessage("Evidence could not be downloaded.");}
    finally {busyRef.current=false;setBusy(false);}
  }
  function textField(key: keyof RequestPayload,label: string,area=false) {
    const value=payload[key]??"";
    return <label key={key}>{label}{area?<textarea value={String(value)} maxLength={4000} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value}))}/>:<input value={String(value)} maxLength={4000} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value}))}/>}</label>;
  }
  function choice(key: keyof RequestPayload,label: string,options: [string,string][]) {
    return <label>{label}<select aria-label={label} value={String(payload[key]??"")} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,[key]:e.target.value}))}>{options.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>;
  }
  return <section className={styles.workspace} aria-label="Subscription requests" aria-busy={busy}>
    <header className={styles.toolbar}><h1>Requests</h1><button type="button" onClick={()=>void reload()} disabled={busy}>Reload</button>{workspace.canApply&&workspace.enabled?<button type="button" onClick={create} disabled={blocked}>New request</button>:null}</header>
    {!workspace.enabled?<p role="status">Subscription requests are not enabled.</p>:null}
    {message?<p role={isError?"alert":"status"}>{message}</p>:null}
    <div className={styles.columns}>
      <nav aria-label="Request list">{workspace.requests.map(r=><button type="button" key={r.id} disabled={blocked} aria-pressed={selected?.id===r.id} onClick={()=>choose(r)}>{r.payload.service||"Untitled request"} — {r.status}</button>)}</nav>
      {selected||newId?<div><h2>{selected?.status==="approved"?"Approved — pending procurement":selected?.status??"draft"}</h2>
        <form onSubmit={event=>{event.preventDefault();void run("submit");}}>
          <div className={styles.fields}>
            {choice("kind","Request type",[["new_purchase","New purchase"],["renewal","Renewal"],["added_seats","Added seats"],["plan_change","Plan change"]])}
            {textField("service","Service")}{textField("plan","Plan")}{textField("purpose","Purpose",true)}
            {choice("company","Benefiting company",[["mam","MAM"],["equipsy","Equipsy"],["both","Both"]])}
            {textField("payer","Payer")}{textField("duration","Usage duration")}
            {choice("billing","Billing cadence",[["monthly","Monthly"],["annual","Annual"],["one_off","One-off"],["other","Other"]])}
            {textField("currency","Original currency")}{textField("tax","Tax basis")}
            {([['quoteCents','Original quote (cents)'],['audEstimateCents','AUD estimate (cents)']] as const).map(([key,label])=><label key={key}>{label}<input type="number" min={0} max={100000000} step={1} disabled={!editable||blocked} value={payload[key]??""} onChange={e=>setPayload(p=>({...p,[key]:e.target.value===""?null:Number(e.target.value)}))}/></label>)}
            {textField("noQuoteReason","Missing quote reason")}
            {choice("payment","Payment method",[["non_card","Non-card"],["card","Card"]])}
            {payload.payment==="card"?<>{textField("cardLabel","Card label")}{textField("cardHolder","Card holder")}</>:null}
            <label>Responsible person<select value={payload.responsiblePersonId??""} disabled={!editable||blocked} onChange={e=>setPayload(p=>({...p,responsiblePersonId:e.target.value||null}))}><option value="">Applicant default</option>{workspace.people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            {textField("intendedUsers","Intended users",true)}
            {editable?<label>Evidence (PDF, PNG, JPEG; no credentials)<input type="file" accept="application/pdf,image/png,image/jpeg" multiple disabled={blocked} onChange={e=>setFiles(Array.from(e.target.files??[]))}/></label>:null}
          </div>
          {editable?<div className={styles.toolbar}><button type="button" disabled={blocked} onClick={()=>void run("save")}>Save draft</button><button type="submit" disabled={blocked}>{selected?.status==="returned"?"Resubmit":"Submit"}</button><button type="button" disabled={blocked} onClick={()=>setFiles([])}>Remove draft evidence</button></div>:null}
        </form>
        {selected?.canDecide&&workspace.enabled?<div className={styles.decisions}><label>Decision reason<textarea value={reason} maxLength={4000} disabled={blocked} onChange={e=>setReason(e.target.value)}/></label><div className={styles.toolbar}>{([['approve','Approve'],['return','Return'],['reject','Reject']] as const).map(([operation,label])=><button key={operation} type="button" disabled={blocked} onClick={()=>void run(operation)}>{label}</button>)}</div></div>:null}
        {selected?.canWithdraw&&workspace.enabled?<button type="button" disabled={blocked} onClick={()=>void run("withdraw")}>Withdraw</button>:null}
        {selected?<section aria-label="Request history"><h2>History</h2>{selected.events.map(event=><details key={event.version}><summary>Version {event.version} — {event.operation}</summary><p>{event.at} — {event.reason}</p><pre>{JSON.stringify(event.payload,null,2)}</pre>{event.evidence.map((e,index)=><button type="button" key={index} disabled={busy} onClick={()=>void download(event.version,index)}>Download {e.name}</button>)}</details>)}</section>:null}
      </div>:null}
    </div>
  </section>;
}
