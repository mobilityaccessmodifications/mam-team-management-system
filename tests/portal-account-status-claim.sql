create function pg_temp.assert(ok boolean, label text)
returns void
language plpgsql
as $$
begin
  if not coalesce(ok, false) then
    raise exception 'assertion failed: %', label;
  end if;
end;
$$;

insert into auth.users (id) values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');

insert into public.profiles (id, login_name, account_status, account_version, app_role) values
  ('10000000-0000-4000-8000-000000000001', 'admin.user', 'active', 1, 'system_admin'),
  ('10000000-0000-4000-8000-000000000002', 'sample.user', 'disabled', 1, 'employee'),
  ('10000000-0000-4000-8000-000000000003', 'second.admin', 'active', 1, 'system_admin'),
  ('10000000-0000-4000-8000-000000000004', 'third.admin', 'active', 1, 'system_admin');

insert into public.internal_org_people (id, auth_user_id, node_kind, is_active) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'person', true),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'person', true),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'person', true),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000004', 'person', true);

insert into private.portal_account_admins (auth_user_id)
values
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004');

select set_config('test.actor', '10000000-0000-4000-8000-000000000001', false);

create temporary table first_claim as
select *
from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  true,
  1
);

select pg_temp.assert(
  (select account_status = 'disabled' and account_version = 1 and change_token is not null from first_claim),
  'begin returns the claimed pre-change account state'
);

select pg_temp.assert(
  (select change_token = (select change_token from first_claim)
   from public.begin_portal_account_status_change(
     '20000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000002',
     true,
     1
   )),
  'the same administrator can safely resume an interrupted claim'
);

select set_config('test.actor', '10000000-0000-4000-8000-000000000003', false);
do $$
begin
  update public.profiles
  set account_status = 'active'
  where id = '10000000-0000-4000-8000-000000000002';
  raise exception 'expected another actor to be fenced by the pending claim';
exception
  when sqlstate '55000' then null;
end;
$$;
select set_config('test.actor', '10000000-0000-4000-8000-000000000001', false);

do $$
begin
  perform public.begin_portal_account_status_change(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    false,
    1
  );
  raise exception 'expected concurrent status claim rejection';
exception
  when sqlstate '40001' then null;
end;
$$;

do $$
begin
  insert into private.portal_password_reset_claims (auth_user_id, status)
  values ('10000000-0000-4000-8000-000000000002', 'pending');
  raise exception 'expected password reset guard rejection';
exception
  when sqlstate '40001' then null;
end;
$$;

create temporary table first_finalise as
select *
from public.finalise_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  (select change_token from first_claim)
);

select pg_temp.assert(
  (select account_status = 'active' and account_version = 2 from first_finalise),
  'finalise publishes the matching database state'
);

select pg_temp.assert(
  (select account_status = 'active' and account_version = 2
   from public.finalise_portal_account_status_change(
     '20000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000002',
     (select change_token from first_claim)
   )),
  'finalise is idempotent'
);

create temporary table same_state_claim as
select *
from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  true,
  2
);

select pg_temp.assert(
  (select account_version = 2
   from public.finalise_portal_account_status_change(
     '20000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000002',
     (select change_token from same_state_claim)
   )),
  'same-state reconciliation does not increment the public version'
);

create temporary table archive_claim as
select *
from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  false,
  2
);

update public.internal_org_people
set is_active = false
where id = '20000000-0000-4000-8000-000000000002';

update public.profiles
set account_status = 'disabled',
    disabled_at = clock_timestamp(),
    account_version = account_version + 1
where id = '10000000-0000-4000-8000-000000000002';

select pg_temp.assert(
  (select account_status = 'disabled' and account_version = 3
   from public.finalise_portal_account_status_change(
     '20000000-0000-4000-8000-000000000002',
     '10000000-0000-4000-8000-000000000002',
     (select change_token from archive_claim)
   )),
  'an archive transaction can publish the claimed status before finalisation'
);

do $$
begin
  perform public.begin_portal_account_status_change(
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    false,
    1
  );
  raise exception 'expected stale-version rejection';
exception
  when sqlstate '40001' then null;
end;
$$;

create temporary table administrator_disable_claim as
select *
from public.begin_portal_account_status_change(
  '20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000003',
  false,
  1
);

do $$
begin
  perform public.begin_portal_account_status_change(
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000004',
    false,
    1
  );
  raise exception 'expected concurrent administrator-disable rejection';
exception
  when sqlstate '40001' then null;
end;
$$;

select pg_temp.assert(
  public.cancel_portal_account_status_change(
    '10000000-0000-4000-8000-000000000003',
    (select change_token from administrator_disable_claim)
  ),
  'cancelling an administrator-disable claim releases the global fence'
);

select pg_temp.assert(
  (select count(*) = 1 from private.portal_account_admin_events where event_type = 'account_enabled'),
  'only the real state transition writes an audit event'
);
