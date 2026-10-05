import { runtimeCapabilityGET } from "@/server/payroll/runtime-capability/probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return runtimeCapabilityGET(request);
}
