import { handlePerformanceMeetingRequest } from "@/lib/performance-review-meeting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function handle(request: Request) {
  return handlePerformanceMeetingRequest(request);
}

export const GET = handle;
export const POST = handle;
