SELECT f.ordinal, f.fixture_key, f.auth_user_id, f.person_id,
       p.app_role, h.company_key, h.parent_id, p.account_version, h.version AS person_version,
       p.account_status, p.must_change_password,
       coalesce(u.raw_app_meta_data->>'org_role' = f.app_role, false) AS product_synced_org_role,
       policy.app_role AS target_policy_role, policy.person_id AS target_policy_person_id,
       coalesce(p.id = f.auth_user_id AND p.full_name = f.full_name AND p.app_role = f.app_role
         AND p.login_name = f.email AND p.account_status = 'active'
         AND NOT p.must_change_password AND p.disabled_at IS NULL
         AND p.account_version = 1 AND p.timezone = 'Australia/Melbourne'
         AND p.credentials_valid_after >= u.created_at AND p.credentials_valid_after <= clock_timestamp()
         AND u.email = f.email AND u.email_confirmed_at IS NOT NULL
         AND u.is_anonymous IS FALSE AND u.deleted_at IS NULL
         AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
         AND u.raw_app_meta_data->>'org_role' = f.app_role
         AND policy.app_role = f.app_role AND policy.person_id IS NOT DISTINCT FROM f.person_id
         AND CASE WHEN f.person_id IS NULL THEN
           NOT EXISTS (SELECT 1 FROM public.internal_org_people l WHERE l.auth_user_id = f.auth_user_id)
         ELSE h.id = f.person_id AND h.auth_user_id = f.auth_user_id AND h.id <> h.auth_user_id
           AND h.company_key = f.company_key AND h.full_name = f.full_name
           AND h.parent_id IS NOT DISTINCT FROM f.parent_id AND h.node_kind = 'person'
           AND h.position_title = 'Synthetic UAT role' AND h.is_active AND h.version = 1
           AND h.started_date IS NULL AND h.created_by IS NULL AND h.updated_by IS NULL
           AND (SELECT count(*) FROM public.internal_org_people l WHERE l.auth_user_id = f.auth_user_id) = 1
         END, false) AS row_matches
FROM __FIXTURE__ f
LEFT JOIN public.profiles p ON p.id = f.auth_user_id
LEFT JOIN public.internal_org_people h ON h.id = f.person_id
LEFT JOIN auth.users u ON u.id = f.auth_user_id
LEFT JOIN LATERAL private.portal_role_policy(f.auth_user_id) policy ON true
ORDER BY f.ordinal
