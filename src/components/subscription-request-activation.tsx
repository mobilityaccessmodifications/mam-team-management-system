"use client";

import { useRef, useState } from "react";
import { listSubscriptionCredentialCatalogue } from "@/app/subscription-credentials/actions";
import type { RequestActivation } from "@/lib/subscription-request-types";
import type { SubscriptionCredentialCatalogueItem } from "@/lib/subscription-credential-types";
import { SubscriptionCredentialEditor } from "./subscription-credential-vault";
import styles from "./subscription-requests.module.css";

export function SubscriptionRequestActivation({ people, defaultPersonId, disabled, onActivate }: {
  people: {id:string;name:string}[]; defaultPersonId: string; disabled: boolean;
  onActivate: (input: Omit<RequestActivation,"id"|"version">) => void;
}) {
  const [seatCount,setSeatCount]=useState("1");
  const [billingAnchorDate,setBillingAnchorDate]=useState("");
  const [renewalDate,setRenewalDate]=useState("");
  const [responsiblePersonId,setResponsiblePersonId]=useState(people.some(p=>p.id===defaultPersonId)?defaultPersonId:"");
  const [memberPersonIds,setMemberPersonIds]=useState<string[]>([]);
  return <section aria-label="Register approved subscription"><h2>Register subscription</h2><form onSubmit={e=>{e.preventDefault();if(!disabled)onActivate({seatCount:Number(seatCount),billingAnchorDate,renewalDate,responsiblePersonId,memberPersonIds});}}>
    <div className={styles.fields}>
      <label>Seats<input required type="number" min={1} max={100000} step={1} value={seatCount} disabled={disabled} onChange={e=>setSeatCount(e.target.value)}/></label>
      <label>Billing start date<input required type="date" value={billingAnchorDate} disabled={disabled} onChange={e=>setBillingAnchorDate(e.target.value)}/></label>
      <label>Renewal date<input required type="date" min={billingAnchorDate} value={renewalDate} disabled={disabled} onChange={e=>setRenewalDate(e.target.value)}/></label>
      <label className={styles.member}><input type="checkbox" checked={Boolean(renewalDate)} disabled/>Renewal reminder set</label>
      <label>Responsible person<select required value={responsiblePersonId} disabled={disabled} onChange={e=>setResponsiblePersonId(e.target.value)}><option value="">Select person</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    <fieldset disabled={disabled}><legend>Who has access</legend>{people.map(p=><label className={styles.member} key={p.id}><input type="checkbox" checked={memberPersonIds.includes(p.id)} onChange={e=>setMemberPersonIds(current=>e.target.checked?[...current,p.id]:current.filter(id=>id!==p.id))}/>{p.name}</label>)}</fieldset>
    <button type="submit" disabled={disabled}>Add subscription</button>
  </form></section>;
}

export function SubscriptionRequestCredentials({ subscriptionId, disabled }: {subscriptionId:string;disabled:boolean}) {
  const [target,setTarget]=useState<SubscriptionCredentialCatalogueItem | null>(null);
  const [loading,setLoading]=useState(false);
  const [message,setMessage]=useState("");
  const busyRef=useRef(false);
  async function open() {
    if(disabled||busyRef.current) return;
    busyRef.current=true;setLoading(true);setMessage("");setTarget(null);
    try {
      const catalogue=await listSubscriptionCredentialCatalogue();
      const item=catalogue.find(row=>row.subscriptionId===subscriptionId);
      if(item)setTarget(item);else setMessage("Credentials are unavailable. Reload before retrying.");
    } catch {setMessage("Credentials could not be loaded. Reload before retrying.");}
    finally {busyRef.current=false;setLoading(false);}
  }
  return <section aria-label="Approved subscription credentials"><button type="button" disabled={disabled||loading} onClick={()=>void open()}>Credentials</button>{message?<p role="alert">{message}</p>:null}{target?<SubscriptionCredentialEditor subscriptionId={target.subscriptionId} serviceName={target.serviceName} planName={target.planName} credentialsSaved={target.credentialsSaved} onClose={()=>setTarget(null)} onSaved={()=>setTarget(null)} onRemoved={()=>setTarget(null)}/>:null}</section>;
}
