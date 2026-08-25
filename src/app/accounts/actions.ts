"use server";

import { revalidatePath } from "next/cache";

import type {
  AccountDto,
  AccountMutationResult,
  CreateAccountInput,
  ResetPasswordInput,
  ToggleAccountInput,
  UpdateLoginInput,
} from "@/components/account-management";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type DirectoryRow = {
  id: string;
  node_kind: "person" | "org_unit" | "vacancy";
  company_key: "mam" | "equipsy";
  full_name: string | null;
  position_title: string;
  auth_user_id: string | null;
  is_active: boolean;
  version: number;
};

type ProfileRow = {
  id: string;
  login_name: string | null;
  account_status: "active" | "disabled";
  account_version: number;
};

type AccountRpcRow = {
  person_id: string;
  auth_user_id: string;
  login_name: string;
  account_status: "active" | "disabled";
  account_version: number;
};

type PasswordResetClaimRpcRow = AccountRpcRow & {
  reset_token: string;
};

const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,128}$/;
const GENERIC_ERROR = "The account change could not be saved. Refresh and try again.";

async function requireAccountAdministrator() {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase
    .rpc("can_manage_portal_accounts");

  if (permissionError || allowed !== true) throw new Error("You do not have permission to manage accounts.");

  return { supabase, actorUserId: userData.user.id };
}

function normaliseLogin(value: string) {
  return value.trim().toLowerCase();
}

function validatePassword(value: string) {
  if (!PASSWORD_PATTERN.test(value)) {
    throw new Error("Use 12–128 characters with upper and lower case, a number and a symbol.");
  }
}

function validateIds(personId: string, userId?: string) {
  // Imported directory records may use deterministic PostgreSQL UUID values
  // without RFC version/variant markers. Validate the UUID shape, not bits
  // which are irrelevant to identity and are checked by Postgres on use.
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(personId) || (userId && !uuidPattern.test(userId))) {
    throw new Error(GENERIC_ERROR);
  }
}

function toAccount(row: DirectoryRow, profile?: ProfileRow, lastSignInAt?: string | null): AccountDto {
  const status = profile ? profile.account_status : "unlinked";
  return {
    personId: row.id,
    name: row.full_name ?? "Unnamed person",
    position: row.position_title,
    company: row.company_key,
    userId: row.auth_user_id ?? undefined,
    loginName: profile?.login_name ?? undefined,
    status,
    lastSignInAt: lastSignInAt ?? undefined,
    accountVersion: profile?.account_version ?? row.version,
  };
}

async function loadAccountByPerson(personId: string): Promise<AccountDto> {
  const admin = createAdminClient();
  const { data: person, error: personError } = await admin
    .from("internal_org_people")
    .select("id,node_kind,company_key,full_name,position_title,auth_user_id,is_active,version")
    .eq("id", personId)
    .eq("node_kind", "person")
    .eq("is_active", true)
    .single<DirectoryRow>();

  if (personError || !person) throw new Error(GENERIC_ERROR);
  if (!person.auth_user_id) return toAccount(person);

  const [{ data: profile, error: profileError }, userResult] = await Promise.all([
    admin
      .from("profiles")
      .select("id,login_name,account_status,account_version")
      .eq("id", person.auth_user_id)
      .single<ProfileRow>(),
    admin.auth.admin.getUserById(person.auth_user_id),
  ]);

  if (profileError || !profile || userResult.error) throw new Error(GENERIC_ERROR);
  return toAccount(person, profile, userResult.data.user.last_sign_in_at);
}

function mapRpcAccount(data: unknown) {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as AccountRpcRow | undefined;
  if (!row) throw new Error(GENERIC_ERROR);
  return row;
}

function mapPasswordResetClaim(data: unknown) {
  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as PasswordResetClaimRpcRow | undefined;
  if (!row || !/^[0-9a-f-]{36}$/i.test(row.reset_token)) throw new Error(GENERIC_ERROR);
  return row;
}

// A new login is deliberately unprivileged. Reporting-line position and
// direct-report count describe the organisation tree; neither is authority to
// approve leave, see HR records, or administer the portal. Any later role
// change must be explicitly assigned by an authorised database operation.
const NEW_ACCOUNT_ROLE = "employee" as const;

async function requireLinkedAccount(
  personId: string,
  userId: string,
  expectedVersion: number,
) {
  const account = await loadAccountByPerson(personId);
  if (
    account.userId !== userId
    || account.status === "unlinked"
    || account.accountVersion !== expectedVersion
  ) {
    throw new Error(GENERIC_ERROR);
  }
  return account;
}

export async function listPortalAccounts(): Promise<AccountDto[]> {
  const { supabase } = await requireAccountAdministrator();
  const admin = createAdminClient();
  const [{ data: people, error: peopleError }, { data: profiles, error: profilesError }] = await Promise.all([
    admin
      .from("internal_org_people")
      .select("id,node_kind,company_key,full_name,position_title,auth_user_id,is_active,version")
      .eq("node_kind", "person")
      .eq("is_active", true)
      .order("company_key")
      .order("sort_order")
      .returns<DirectoryRow[]>(),
    supabase.rpc("list_portal_account_summaries"),
  ]);

  if (peopleError || profilesError) throw new Error("Accounts could not be loaded.");

  const profileRows = Array.isArray(profiles) ? profiles as ProfileRow[] : [];
  const profileById = new Map(profileRows.map((profile) => [profile.id, profile]));
  const userIds = (people ?? []).flatMap((person) => person.auth_user_id ? [person.auth_user_id] : []);
  const lastSignInById = new Map<string, string | null>();

  for (let page = 1; userIds.length && page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("Accounts could not be loaded.");
    for (const user of data.users) {
      if (userIds.includes(user.id)) lastSignInById.set(user.id, user.last_sign_in_at ?? null);
    }
    if (data.users.length < 100 || lastSignInById.size >= userIds.length) break;
  }

  return (people ?? []).map((person) => toAccount(
    person,
    person.auth_user_id ? profileById.get(person.auth_user_id) : undefined,
    person.auth_user_id ? lastSignInById.get(person.auth_user_id) : undefined,
  ));
}

export async function createPortalAccount(input: CreateAccountInput): Promise<AccountMutationResult> {
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId);
  const loginName = normaliseLogin(input.loginName);
  if (!LOGIN_PATTERN.test(loginName)) throw new Error("Use 3–64 lower-case letters, numbers, dots, dashes or underscores.");
  validatePassword(input.newPassword);

  const admin = createAdminClient();
  const { data: person, error: personError } = await admin
    .from("internal_org_people")
    .select("id,full_name,auth_user_id,version")
    .eq("id", input.personId)
    .eq("node_kind", "person")
    .eq("is_active", true)
    .single();

  if (personError || !person || person.auth_user_id || person.version !== input.accountVersion) throw new Error(GENERIC_ERROR);

  const { count: loginCount, error: loginError } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("login_name", loginName);
  if (loginError) throw new Error(GENERIC_ERROR);
  if (loginCount) throw new Error("That login name is already in use.");

  const opaqueAddress = `portal-${crypto.randomUUID()}@accounts.mobilityaccess.com.au`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: opaqueAddress,
    password: input.newPassword,
    email_confirm: true,
    app_metadata: { org_role: NEW_ACCOUNT_ROLE },
  });
  if (createError || !created.user) throw new Error("The login could not be created.");

  const { data: saved, error: saveError } = await supabase.rpc("create_portal_account", {
    p_person_id: input.personId,
    p_auth_user_id: created.user.id,
    p_login_name: loginName,
    p_app_role: NEW_ACCOUNT_ROLE,
    p_expected_person_version: input.accountVersion,
  });

  if (saveError) {
    await admin.auth.admin.deleteUser(created.user.id);
    throw new Error(saveError.message.includes("login_name") ? "That login name is already in use." : GENERIC_ERROR);
  }

  mapRpcAccount(saved);
  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId), oneTimePassword: input.newPassword };
}

export async function updatePortalLogin(input: UpdateLoginInput): Promise<AccountMutationResult> {
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  const loginName = normaliseLogin(input.loginName);
  if (!LOGIN_PATTERN.test(loginName)) throw new Error("Use 3–64 lower-case letters, numbers, dots, dashes or underscores.");
  const { data, error } = await supabase.rpc("update_portal_login", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_login_name: loginName,
    p_expected_account_version: input.accountVersion,
  });
  if (error) throw new Error(error.message.includes("login_name") ? "That login name is already in use." : GENERIC_ERROR);
  mapRpcAccount(data);
  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId) };
}

export async function resetPortalPassword(input: ResetPasswordInput): Promise<AccountMutationResult> {
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  validatePassword(input.newPassword);
  await requireLinkedAccount(input.personId, input.userId, input.accountVersion);

  const { data: claimed, error: claimError } = await supabase.rpc("begin_portal_password_reset", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_expected_account_version: input.accountVersion,
  });
  if (claimError) throw new Error(GENERIC_ERROR);
  const claim = mapPasswordResetClaim(claimed);

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.updateUserById(input.userId, { password: input.newPassword });
  if (error || !data.user) {
    await supabase.rpc("cancel_portal_password_reset", {
      p_auth_user_id: input.userId,
      p_reset_token: claim.reset_token,
    });
    throw new Error("The password could not be reset.");
  }

  let finalised = await supabase.rpc("finalise_portal_password_reset", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_reset_token: claim.reset_token,
  });
  if (finalised.error) {
    // A provider timeout can leave the database call's outcome unknown. The
    // claim token makes this retry idempotent and prevents a second password
    // from being shown for the same reset.
    finalised = await supabase.rpc("finalise_portal_password_reset", {
      p_person_id: input.personId,
      p_auth_user_id: input.userId,
      p_reset_token: claim.reset_token,
    });
  }
  if (finalised.error) throw new Error("The password changed, but its account record needs refreshing.");
  mapRpcAccount(finalised.data);
  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId), oneTimePassword: input.newPassword };
}

export async function togglePortalAccount(input: ToggleAccountInput): Promise<AccountMutationResult> {
  const { supabase, actorUserId } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  if (!input.enabled && input.userId === actorUserId) throw new Error("You cannot disable your own login.");
  await requireLinkedAccount(input.personId, input.userId, input.accountVersion);
  const admin = createAdminClient();

  if (input.enabled) {
    const { error: authError } = await admin.auth.admin.updateUserById(input.userId, { ban_duration: "none" });
    if (authError) throw new Error("The login could not be enabled.");
  }

  const { data, error } = await supabase.rpc("set_portal_account_enabled", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_enabled: input.enabled,
    p_expected_account_version: input.accountVersion,
  });
  if (error) {
    if (input.enabled) {
      await admin.auth.admin.updateUserById(input.userId, { ban_duration: "876000h" });
    }
    throw new Error(error.message.includes("own account") ? "You cannot disable your own login." : GENERIC_ERROR);
  }

  if (!input.enabled) {
    const { error: authError } = await admin.auth.admin.updateUserById(input.userId, { ban_duration: "876000h" });
    if (authError) {
      await supabase.rpc("set_portal_account_enabled", {
        p_person_id: input.personId,
        p_auth_user_id: input.userId,
        p_enabled: true,
        p_expected_account_version: mapRpcAccount(data).account_version,
      });
      throw new Error("The login could not be disabled.");
    }
  }

  mapRpcAccount(data);
  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId) };
}
