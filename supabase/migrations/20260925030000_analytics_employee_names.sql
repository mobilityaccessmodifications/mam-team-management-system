begin;

do $$
declare
  v_signature constant text := 'public.analytics_dashboard_dataset(text,date,date,integer,integer)';
  v_definition text;
  v_anchor constant text := $anchor$          'employee_id', person.id,
          'company', person.company_key,$anchor$;
  v_replacement constant text := $replacement$          'employee_id', person.id,
          'first_name', (select employee_detail.first_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'last_name', (select employee_detail.last_name from private.employee_directory_details employee_detail where employee_detail.person_id = person.id),
          'company', person.company_key,$replacement$;
  v_count integer;
begin
  if to_regprocedure(v_signature) is null then
    raise exception 'Analytics dataset RPC is missing.' using errcode = '55000';
  end if;

  v_definition := pg_get_functiondef(v_signature::regprocedure);
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'Analytics employee projection changed; review the name-field migration.' using errcode = '55000';
  end if;

  v_definition := replace(v_definition, v_anchor, v_replacement);
  execute v_definition;
end;
$$;

commit;
