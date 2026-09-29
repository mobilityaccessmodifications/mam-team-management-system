begin;

do $$
declare
  v_person uuid := '91000000-0000-4000-8000-000000000001';
  v_other uuid := '91000000-0000-4000-8000-000000000002';
  v_user uuid := '91000000-0000-4000-8000-000000000003';
  v_other_user uuid := '91000000-0000-4000-8000-000000000004';
  v_claim record;
  v_date date := timezone('Australia/Melbourne',clock_timestamp())::date;
begin
  insert into auth.users(id,email) values(v_user,'synthetic-opaque@example.test');
  insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,started_date,is_active)
    values(v_person,'person','mam','Synthetic Starter','Tester',v_date-1,true);
  insert into private.employee_directory_details(person_id,first_name,work_email,personal_email)
    values(v_person,'Synthetic','work@example.test','home@example.test');
  if not exists(select 1 from private.employee_onboarding_credentials where person_id=v_person and status='pending_account') then
    raise exception 'Unlinked starter must await account';
  end if;
  insert into public.profiles(id,full_name,app_role,login_name) values(v_user,'Synthetic Starter','employee','work@example.test');
  update public.internal_org_people set auth_user_id=v_user where id=v_person;
  if not exists(select 1 from private.employee_onboarding_credentials where person_id=v_person and status='scheduled' and due_date=v_date-1) then
    raise exception 'Linked past starter should be scheduled immediately';
  end if;
  select * into v_claim from public.claim_due_onboarding_credentials(10);
  if v_claim.person_id is distinct from v_person or v_claim.login_name <> 'work@example.test'
    or v_claim.work_email <> 'work@example.test' or v_claim.personal_email <> 'home@example.test' then
    raise exception 'Claim must resolve work login and both current contacts';
  end if;
  if not public.begin_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token) then
    raise exception 'Valid claim did not start';
  end if;
  if public.complete_onboarding_credential_delivery(v_claim.delivery_id,gen_random_uuid()) then
    raise exception 'Wrong token completed delivery';
  end if;
  if not public.fail_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token,'delivery_uncertain') then
    raise exception 'Ambiguous send must be review-held';
  end if;
  if exists(select 1 from public.claim_due_onboarding_credentials(10)) then
    raise exception 'Uncertain send must never auto-retry';
  end if;
  update private.employee_onboarding_credentials set status='scheduled',review_code=null where person_id=v_person;
  select * into v_claim from public.claim_due_onboarding_credentials(10);
  if not public.begin_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token)
    or not public.complete_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token) then
    raise exception 'Successful send should be recorded';
  end if;
  if exists(select 1 from public.claim_due_onboarding_credentials(10)) then
    raise exception 'Delivered credential must never be reissued';
  end if;
  update private.employee_onboarding_credentials set status='scheduled',delivered_at=null where person_id=v_person;
  select * into v_claim from public.claim_due_onboarding_credentials(10);
  if not public.begin_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token) then
    raise exception 'Pre-archive claim did not start';
  end if;
  update public.profiles set account_status='disabled',disabled_at=clock_timestamp() where id=v_user;
  update public.internal_org_people set is_active=false where id=v_person;
  if public.complete_onboarding_credential_delivery(v_claim.delivery_id,v_claim.claim_token) then
    raise exception 'Archived person must not be marked delivered';
  end if;
  if exists(select 1 from public.profiles where id=v_user and login_name is not null) then
    raise exception 'Archived email login must be released';
  end if;
  insert into public.internal_org_people(id,node_kind,company_key,full_name,position_title,started_date,is_active)
    values(v_other,'person','mam','Other Synthetic Starter','Tester',v_date+1,true);
  insert into private.employee_directory_details(person_id,first_name,work_email)
    values(v_other,'Other','work@example.test');
  if exists(select 1 from public.profiles where login_name='work@example.test') then
    raise exception 'Archived identity still reserves the email';
  end if;
  insert into auth.users(id,email) values(v_other_user,'synthetic-other-opaque@example.test');
  insert into public.profiles(id,full_name,app_role,login_name)
    values(v_other_user,'Other Synthetic Starter','employee','work@example.test');
  update public.internal_org_people set auth_user_id=v_other_user where id=v_other;
  if not exists(select 1 from private.employee_onboarding_credentials where person_id=v_other and status='scheduled' and due_date=v_date+1) then
    raise exception 'Reused email must schedule the new identity, not immediate send';
  end if;
  if exists(select 1 from public.claim_due_onboarding_credentials(10)) then
    raise exception 'Future starter must wait until start date';
  end if;
end $$;
rollback;
