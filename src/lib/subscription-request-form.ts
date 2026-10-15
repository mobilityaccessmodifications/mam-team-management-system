import type { RequestPayload } from "./subscription-request-types";

export function parseRequestAmount(value: string): number | null {
  if (value.trim() === "") return null;
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) throw new Error("Enter an AUD amount with up to two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000) throw new Error("Enter an AUD amount up to 1,000,000.");
  return cents;
}

export function formatRequestAmount(value: number | null | undefined): string {
  return value == null ? "" : (value / 100).toFixed(2);
}

export function withSelectedRequestCost(payload: RequestPayload): RequestPayload {
  const cost = payload.billing === "one_off" ? payload.oneOffCostCents : payload.billing === "monthly" ? payload.monthlyCostCents : payload.annualCostCents;
  return { ...payload, quoteCents: cost ?? null, audEstimateCents: cost ?? null };
}
