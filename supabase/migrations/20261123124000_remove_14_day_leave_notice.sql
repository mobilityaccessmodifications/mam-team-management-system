-- Allow employees to submit Annual and Unpaid Leave with less than 14 days notice.
-- Leave types, balance rules, approval routing, and other submission checks remain unchanged.
BEGIN;
DROP TRIGGER IF EXISTS leave_requests_enforce_notice_period ON public.leave_requests;
DROP FUNCTION IF EXISTS private.enforce_self_service_leave_notice();
COMMIT;
