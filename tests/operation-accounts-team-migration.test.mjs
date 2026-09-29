import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync('supabase/migrations/20260930120000_rename_mam_admin_team.sql', 'utf8');

test('team rename migrates saved labels and makes reporting rather than category the peer scope', () => {
  assert.match(sql, /update private\.employee_directory_details[\s\S]*team_name = 'Operation & Accounts'[\s\S]*team_name = 'MAM admin'/i);
  assert.match(sql, /drop constraint employee_directory_details_canonical_team/i);
  assert.match(sql, /add constraint employee_directory_details_canonical_team[\s\S]*'Operation & Accounts'/i);
  assert.match(sql, /create or replace function private\.employee_calendar_peer_ids\(p_person_id uuid\)/i);
  assert.match(sql, /with recursive ancestors/i);
  assert.doesNotMatch(sql.slice(sql.indexOf('create or replace function private.employee_calendar_peer_ids')), /peer_detail\.team_name\s*=|actor_detail\.team_name\s+in/i);
  assert.match(sql, /'Management'/);
  assert.match(sql, /peer\.company_key = actor\.company_key/);
  assert.equal((sql.match(/v_is_manager and employee\.is_active/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /v_is_manager and employee\.is_active and employee\.company_key/);
  assert.match(sql, /manager_profile\.app_role = 'manager'/);
  const effectiveApprovalSql = readFileSync('supabase/migrations/20260922220000_core_review_safety_fixes.sql', 'utf8');
  const approvalResolver = effectiveApprovalSql.slice(effectiveApprovalSql.indexOf('create or replace function private.resolve_leave_approval_grants'), effectiveApprovalSql.indexOf('create or replace function private.is_current_leave_request_reviewer'));
  assert.doesNotMatch(approvalResolver, /scope_kind = 'team'|scope_team_name|employee_team/);
  assert.doesNotMatch(sql, /update public\.internal_org_people/i);
});
