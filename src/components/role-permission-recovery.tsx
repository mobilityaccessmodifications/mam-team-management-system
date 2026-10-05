"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ROLE_CAPABILITY_ERROR } from "@/lib/portal-role-capabilities";
export function RolePermissionRecovery() {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  return <main><p role="alert">{ROLE_CAPABILITY_ERROR}</p><button type="button" disabled={retrying} onClick={() => {
    setRetrying(true);
    router.refresh();
    setRetrying(false);
  }}>{retrying ? "Retrying…" : "Retry permissions"}</button></main>;
}
