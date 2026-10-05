import { createHash, randomUUID } from 'node:crypto';

export const capabilityColumns = [
  'app_role', 'person_id', 'account_status', 'is_super_admin', 'can_manage_accounts',
  'can_view_employee_directory', 'can_manage_employee_directory',
  'can_view_organisation_chart', 'can_edit_organisation_chart', 'can_change_employee_view',
  'can_view_check_in_workspace', 'can_manage_assets', 'can_view_subscription_register',
  'can_manage_subscriptions', 'can_manage_subscription_credentials',
  'can_manage_subscription_credential_grants', 'can_manage_subscription_management_grants',
  'can_manage_roles', 'can_manage_analytics_api', 'can_import_payroll_balances',
  'payroll_comparison_only', 'can_manage_leave_balances', 'can_view_all_leave_requests',
  'can_review_leave_workspace', 'can_approve_employment_decisions',
];

export function expectedCapabilities(role, personId, { management = false, vault = false } = {}) {
  const row = Object.fromEntries(capabilityColumns.map(column => [column, false]));
  Object.assign(row, { app_role: role, person_id: personId, account_status: 'active' });
  const operational = role === 'admin' || role === 'system_admin';
  if (operational) {
    for (const column of [
      'can_manage_accounts', 'can_view_employee_directory', 'can_manage_employee_directory',
      'can_view_organisation_chart', 'can_edit_organisation_chart', 'can_view_check_in_workspace',
      'can_manage_assets', 'can_view_subscription_register', 'can_manage_subscriptions',
      'can_manage_subscription_credentials', 'can_import_payroll_balances',
      'can_manage_leave_balances', 'can_view_all_leave_requests', 'can_review_leave_workspace',
      'can_approve_employment_decisions',
    ]) row[column] = true;
  }
  if (role === 'system_admin') {
    for (const column of [
      'is_super_admin', 'can_change_employee_view', 'can_manage_subscription_credential_grants',
      'can_manage_subscription_management_grants', 'can_manage_roles', 'can_manage_analytics_api',
    ]) row[column] = true;
  }
  if (role === 'manager') {
    for (const column of [
      'can_view_employee_directory', 'can_view_organisation_chart', 'can_view_check_in_workspace',
      'can_view_subscription_register', 'can_review_leave_workspace',
    ]) row[column] = true;
    row.can_manage_subscriptions = management;
    row.can_manage_subscription_credentials = vault;
  }
  if (role === 'account') {
    row.can_import_payroll_balances = true;
    row.payroll_comparison_only = true;
    row.can_view_all_leave_requests = true;
  }
  return row;
}

export function historicalGrantFixture(user) {
  return `
    insert into private.leave_approval_grants(reviewer_user_id,scope_kind,reviewer_label,priority)
      values ('${user.id}','global','Synthetic historical grant',100) on conflict do nothing;
    insert into private.employee_check_in_access_grants(reviewer_user_id,scope_kind)
      values ('${user.id}','global') on conflict do nothing;
    insert into private.payroll_balance_import_grants(person_id)
      values ('${user.id}') on conflict do nothing;
    insert into private.leave_register_read_grants(person_id)
      values ('${user.id}') on conflict do nothing;
    insert into private.subscription_management_grants(person_id)
      values ('${user.id}') on conflict do nothing;
    insert into private.subscription_credential_access_grants(auth_user_id,person_id)
      values ('${user.id}','${user.id}') on conflict do nothing;
  `;
}

export function leaveFixture(owner, status = 'submitted', { dateOffset = 90, annual = false, historical = false } = {}) {
  const id = randomUUID();
  const attachment = randomUUID();
  return {
    id, attachment, ownerId: owner.id, status,
    sql: `
      insert into public.leave_requests(id,user_id,employee_person_id,leave_type,request_type_label,
        start_date,end_date,business_days,status,submitted_at,reason,manager_note,record_origin,source_record_sha256)
      values ('${id}','${owner.id}','${owner.id}','${annual ? 'annual' : 'unpaid'}',
        '${annual ? 'Annual leave' : 'Unpaid leave'}',current_date+${dateOffset},current_date+${dateOffset},
        1,'${status}',now(),'Synthetic employee note','Synthetic retained reviewer note',
        '${historical ? 'historical_import' : 'portal'}',${historical ? `'${createHash('sha256').update(id).digest('hex')}'` : 'null'});
      insert into public.leave_request_attachments(id,leave_request_id,uploaded_by,storage_path,file_name,mime_type,size_bytes)
      values ('${attachment}','${id}','${owner.id}','${id}/${attachment}.pdf','synthetic-evidence.pdf','application/pdf',128);
    `,
  };
}
