"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadSubscriptionRequests } from "@/app/subscription-requests/actions";
import type { SubscriptionRequest } from "@/lib/subscription-request-types";
import styles from "@/components/check-in-tasks.module.css";

export function SubscriptionRequestTasks() {
  const [tasks,setTasks]=useState<SubscriptionRequest[]>([]);
  const [error,setError]=useState("");
  const generation=useRef(0);
  const load=useCallback(async()=>{
    const current=++generation.current;
    try {
      const result=await loadSubscriptionRequests();
      if(current!==generation.current)return;
      setTasks(result.ok?result.data.requests.filter(r=>r.status==="submitted"&&r.canDecide):[]);
      setError(result.ok?"":result.message);
    } catch { if(current===generation.current){setTasks([]);setError("Subscription requests could not be loaded.");} }
  },[]);
  useEffect(()=>{let active=true;const fence=generation;queueMicrotask(()=>{if(active)void load();});return ()=>{active=false;fence.current++;};},[load]);
  if(!tasks.length&&!error)return null;
  return <section className={styles.workspace} aria-label="Subscription request tasks">
    <div className={styles.header}><h3>Subscription requests</h3><button className={styles.refresh} type="button" onClick={()=>void load()}>Refresh</button></div>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    <div className={styles.list}>{tasks.map(task=><article className={styles.task} key={task.id}>
      <div className={styles.person}><strong>{task.payload.service}</strong></div>
      <div className={styles.milestone}><strong>Subscription request</strong></div>
      <span className={styles.status}>Pending review</span>
      <Link className={styles.complete} prefetch={false} href={`/subscription-requests?request=${task.id}`}>Review request</Link>
    </article>)}</div>
  </section>;
}
