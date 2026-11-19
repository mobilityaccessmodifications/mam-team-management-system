-- Optional HR-managed Work station text on employee profiles.
-- Existing employees are not updated; the new column is nullable.
ALTER TABLE private.employee_directory_details
  ADD COLUMN IF NOT EXISTS work_station text;

DO $workstation_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'private.employee_directory_details'::regclass
      AND conname = 'employee_directory_work_station_length_check'
  ) THEN
    ALTER TABLE private.employee_directory_details
      ADD CONSTRAINT employee_directory_work_station_length_check
      CHECK (work_station IS NULL OR (length(work_station) <= 200 AND work_station = btrim(work_station)));
  END IF;
END;
$workstation_check$;

CREATE OR REPLACE FUNCTION public.list_employee_work_stations()
RETURNS TABLE(person_id uuid, work_station text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR COALESCE(((SELECT auth.jwt())->>'is_anonymous')::boolean, false)
    OR NOT public.can_manage_employee_directory() THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT d.person_id, d.work_station
  FROM private.employee_directory_details d;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_employee_work_station(p_person_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  station text;
BEGIN
  IF (SELECT auth.uid()) IS NULL
    OR COALESCE(((SELECT auth.jwt())->>'is_anonymous')::boolean, false)
    OR NOT public.can_manage_employee_directory() THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;
  SELECT d.work_station INTO station
  FROM private.employee_directory_details d WHERE d.person_id=p_person_id;
  RETURN station;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.update_employee_work_station(
  p_person_id uuid, p_work_station text, p_expected_detail_version bigint
)
RETURNS TABLE(detail_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  v_role_locked boolean := private.lock_portal_role_actor();
  v_actor uuid := (SELECT auth.uid());
  v_detail private.employee_directory_details%rowtype;
  v_station text;
BEGIN
  IF v_actor IS NULL OR NOT private.is_internal_org_hr() THEN
    RAISE EXCEPTION 'Only an authorized HR user can update employee directory records.' USING ERRCODE='42501';
  END IF;
  IF p_person_id IS NULL OR p_expected_detail_version IS NULL OR p_expected_detail_version < 1 THEN
    RAISE EXCEPTION 'The employee detail version is required.' USING ERRCODE='22004';
  END IF;

  v_station := private.normalise_employee_directory_text(p_work_station, 200, false, 'Work station');
  SELECT d.* INTO v_detail
  FROM private.employee_directory_details d
  JOIN public.internal_org_people p ON p.id=d.person_id AND p.node_kind='person'
  WHERE d.person_id=p_person_id
  FOR UPDATE OF d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The employee detail does not exist.' USING ERRCODE='23503';
  END IF;
  IF v_detail.version <> p_expected_detail_version THEN
    RAISE EXCEPTION 'This employee detail changed since it was opened. Refresh and try again.'
      USING ERRCODE='40001';
  END IF;
  IF v_detail.work_station IS NOT DISTINCT FROM v_station THEN
    RETURN QUERY SELECT v_detail.version;
    RETURN;
  END IF;

  UPDATE private.employee_directory_details d
  SET work_station=v_station, updated_by=v_actor
  WHERE d.person_id=p_person_id
  RETURNING * INTO v_detail;

  INSERT INTO private.employee_directory_audit_events(person_id,actor_user_id,event_type,changed_fields)
  VALUES (p_person_id,v_actor,'updated',ARRAY['work_station']::text[]);

  RETURN QUERY SELECT v_detail.version;
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_employee_work_stations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_employee_work_station(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_employee_work_station(uuid,text,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_employee_work_stations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_work_station(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_employee_work_station(uuid,text,bigint) TO authenticated;
