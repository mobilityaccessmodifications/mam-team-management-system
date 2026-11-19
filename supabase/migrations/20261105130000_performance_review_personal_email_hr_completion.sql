-- Annual reviews: personal-email fallback and a distinct HR notification on manager completion.
-- This migration is intentionally idempotent for existing functions and review events.
CREATE OR REPLACE FUNCTION private.performance_review_recipient_email(p_person_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $email$
  SELECT lower(btrim(e.address))
  FROM private.employee_directory_details d
  CROSS JOIN LATERAL (VALUES (d.work_email,1),(d.personal_email,2)) e(address,preference)
  WHERE d.person_id=p_person_id AND e.address IS NOT NULL
    AND length(lower(btrim(e.address))) BETWEEN 6 AND 254
    AND lower(btrim(e.address)) !~ '[[:cntrl:]]'
    AND lower(btrim(e.address)) ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$'
  ORDER BY e.preference LIMIT 1
$email$;

DO $rewrite$
DECLARE s text;
BEGIN
  -- Resolve the employee's email from either directory field. Keep strict one-recipient validation.
  SELECT pg_get_functiondef(p.oid) INTO STRICT s FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='private' AND p.proname='performance_review_meeting_addresses';
  IF position('lower(btrim(ed.work_email)) employee_email' IN s)=0 THEN RAISE EXCEPTION 'Unexpected meeting-address implementation'; END IF;
  s:=replace(s,'lower(btrim(ed.work_email)) employee_email','private.performance_review_recipient_email(e.id) employee_email');
  s:=replace(s,'lower(btrim(rd.work_email)) email','private.performance_review_recipient_email(rp.person_id) email');
  s:=replace(s,'lower(btrim(md.work_email)) email','private.performance_review_recipient_email(m.id) email');
  s:=replace(s,'lower(btrim(md.work_email)) manager_email','private.performance_review_recipient_email(m.id) manager_email');
  s:=replace(s,'lower(btrim(d.work_email))=a.employee_email','private.performance_review_recipient_email(d.person_id)=a.employee_email');
  s:=replace(s,'lower(btrim(d.work_email))=a.manager_email','private.performance_review_recipient_email(d.person_id)=a.manager_email');
  s:=replace(s,'a.manager_email ~ ''^[^[:space:]@,;]+@(mobilityaccess\.com\.au|equipsy\.com\.au)$''',
              'a.manager_email ~ ''^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$''');
  EXECUTE s;

  -- Clone original notification projection, then wrap to append a manager-completed event.
  SELECT pg_get_functiondef(p.oid) INTO STRICT s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='private' AND p.proname='performance_review_notification_payload';
  IF position('FUNCTION private.performance_review_notification_payload(' IN s)=0 THEN RAISE EXCEPTION 'Unexpected notification implementation'; END IF;
  s:=replace(s,'FUNCTION private.performance_review_notification_payload(','FUNCTION private.performance_review_notification_payload_original(');
  s:=replace(s,'lower(btrim(detail.work_email))','private.performance_review_recipient_email(detail.person_id)');
  s:=replace(s,'detail.work_email is not null','private.performance_review_recipient_email(detail.person_id) is not null');
  s:=replace(s,'detail.work_email !~','private.performance_review_recipient_email(detail.person_id) !~');
  s:=replace(s,'lower(btrim(case when p_event=''started'' then employee_detail.work_email
    when org_manager.id is not null then org_manager.work_email
    when rp.person_id is not null then reviewer_detail.work_email end))',
            'case when p_event=''started'' then private.performance_review_recipient_email(employee.id)
    when org_manager.id is not null then private.performance_review_recipient_email(org_manager.id)
    when rp.person_id is not null then private.performance_review_recipient_email(rp.person_id) end');
  s:=replace(s,'lower(btrim(other.work_email))=private.performance_review_recipient_email(detail.person_id)',
              'private.performance_review_recipient_email(other.person_id)=private.performance_review_recipient_email(detail.person_id)');
  s:=replace(s,'lower(btrim(other.work_email))=recipient.email',
              'private.performance_review_recipient_email(other.person_id)=recipient.email');
  s:=replace(s,'private.performance_review_recipient_email(detail.person_id) ~ ''@(mobilityaccess\.com\.au|equipsy\.com\.au)$''',
              'private.performance_review_recipient_email(detail.person_id) ~ ''^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$''');
  s:=replace(s,'recipient.email ~ ''@(mobilityaccess\.com\.au|equipsy\.com\.au)$''',
              'recipient.email ~ ''^[^[:space:]@,;]+@[^[:space:]@,;]+\.[^[:space:]@,;]+$''');
  EXECUTE s;

  SELECT pg_get_functiondef(p.oid) INTO STRICT s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='claim_performance_review_notifications' AND p.pronargs=2;
  IF position('item.event=''manager-invited''' IN s)=0 THEN RAISE EXCEPTION 'Unexpected claim implementation'; END IF;
  s:=replace(s,'item.event=''manager-invited''','item.event in (''manager-invited'',''manager-completed'')');
  EXECUTE s;

  SELECT pg_get_functiondef(p.oid) INTO STRICT s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='reserve_performance_review_notification_mail';
  IF position('(started|self-submitted|manager-invited)' IN s)=0 THEN RAISE EXCEPTION 'Unexpected reservation implementation'; END IF;
  s:=replace(s,'(started|self-submitted|manager-invited)',
    '(started|self-submitted|manager-invited|manager-completed)');
  s:=replace(s,'if delivery.event=''manager-invited'' and (p_cc<>'''' or message is null or message->>''recipient'' is distinct from p_recipient) then',
    'if delivery.event in (''manager-invited'',''manager-completed'') and (p_cc<>'''' or message is null or message->>''recipient'' is distinct from p_recipient
     or (delivery.event=''manager-completed'' and p_recipient<>''careers@mobilityaccess.com.au'')) then');
  EXECUTE s;
END
$rewrite$;

CREATE OR REPLACE FUNCTION private.performance_review_notification_payload(
  p_review private.performance_reviews,p_event text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $payload$
SELECT CASE WHEN p_event='manager-completed' THEN
  CASE WHEN p_review.manager_completed_at IS NOT NULL AND p_review.self_submitted_at IS NOT NULL
  THEN jsonb_build_object(
    'event',p_event,'eventKey','performance-review:'||p_review.id::text||':'||p_event,
    'reviewId',p_review.id,'reviewCode','PR-'||p_review.cycle||'-'||p_review.review_no,
    'cycle',p_review.cycle,'dueDate',p_review.due_date,
    'recipient','careers@mobilityaccess.com.au',
    'employeeName',p_review.employee_identity->>'name',
    'managerName',p_review.manager_identity->>'name') ELSE NULL END
ELSE private.performance_review_notification_payload_original(p_review,p_event) END
$payload$;

ALTER TABLE private.performance_review_notifications DROP CONSTRAINT performance_review_notifications_event_check;
ALTER TABLE private.performance_review_notifications
  ADD CONSTRAINT performance_review_notifications_event_check
  CHECK (event IN ('started','self-submitted','manager-invited','manager-completed'));

CREATE OR REPLACE FUNCTION private.queue_performance_review_manager_completed_hr()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $trigger$
BEGIN
  INSERT INTO private.performance_review_notifications(review_id,event)
    VALUES(new.id,'manager-completed') ON CONFLICT (review_id,event) DO NOTHING;
  RETURN new;
END
$trigger$;

CREATE TRIGGER performance_review_manager_completed_hr_notification
AFTER UPDATE OF manager_completed_at ON private.performance_reviews
FOR EACH ROW WHEN (old.manager_completed_at IS NULL AND new.manager_completed_at IS NOT NULL)
EXECUTE FUNCTION private.queue_performance_review_manager_completed_hr();

-- Backfill 2026 manager-completed assessments exactly once; release only with the updated email worker.
INSERT INTO private.performance_review_notifications(review_id,event)
SELECT id,'manager-completed' FROM private.performance_reviews
WHERE manager_completed_at IS NOT NULL AND cycle='2026'
  AND id='6f38d695-88c3-4db3-a4d2-516fa3151890'::uuid
ON CONFLICT (review_id,event) DO NOTHING;
