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
import { isUatMode } from "@/lib/uat-safety";
import { isPortalLoginEmail, normalisePortalLogin } from "@/lib/portal-login";
import { finalisePortalAccountStatusChange, preparePortalAccountStatusChange } from "@/lib/portal-account-status";

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

const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,128}$/;
const GENERIC_ERROR = "The account change could not be saved. Refresh and try again.";

async function requireAccountAdministrator(fallback = GENERIC_ERROR) {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) throw new Error("Your session has expired. Sign in again.");

  const { data: allowed, error: permissionError } = await supabase
    .rpc("can_manage_portal_accounts");

  if (permissionError?.code === "42501" || (!permissionError && allowed === false)) throw new Error("You do not have permission to manage accounts.");
  if (permissionError || allowed !== true) throw new Error(fallback);

  return { supabase, actorUserId: userData.user.id };
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

async function loadAccountByPerson(personId: string, includeLastSignIn = true): Promise<AccountDto> {
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
    includeLastSignIn ? admin.auth.admin.getUserById(person.auth_user_id) : null,
  ]);

  if (profileError || !profile || userResult?.error) throw new Error(GENERIC_ERROR);
  return toAccount(person, profile, userResult?.data.user.last_sign_in_at);
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
  const account = await loadAccountByPerson(personId, false);
  if (
    account.userId !== userId
    || account.status === "unlinked"
    || account.accountVersion !== expectedVersion
  ) {
    throw new Error(GENERIC_ERROR);
  }
  return account;
}

type AccountAdminClient = ReturnType<typeof createAdminClient>;

async function inspectCreatedAccount(
  admin: AccountAdminClient,
  personId: string,
  userId: string,
  opaqueAddress: string,
  loginName: string,
): Promise<"committed" | "unlinked" | "unknown"> {
  try {
    const [auth, person, owner, profile] = await Promise.all([
      admin.auth.admin.getUserById(userId),
      admin.from("internal_org_people").select("id,auth_user_id").eq("id", personId).single(),
      admin.from("internal_org_people").select("id").eq("auth_user_id", userId).maybeSingle(),
      admin.from("profiles").select("id,login_name").eq("id", userId).maybeSingle(),
    ]);
    if (auth.error || person.error || owner.error || profile.error
      || auth.data.user?.id !== userId || auth.data.user.email !== opaqueAddress || !person.data) return "unknown";
    if (person.data.auth_user_id === userId && owner.data?.id === personId
      && profile.data?.id === userId && profile.data.login_name === loginName) return "committed";
    // A link to ANY person or an already configured profile protects the user,
    // even if it is not the expected person/login. Never infer an orphan merely
    // from a failed lookup or from the target person linking a different user.
    if (person.data.auth_user_id !== userId && !owner.data && !profile.data?.login_name) return "unlinked";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function listPortalAccounts(): Promise<AccountDto[]> {
  const { supabase } = await requireAccountAdministrator("Accounts could not be loaded.");
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
  const unresolvedUserIds = new Set(userIds);
  const lastSignInById = new Map<string, string | null>();

  for (let page = 1; !isUatMode() && unresolvedUserIds.size > 0; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("Accounts could not be loaded.");
    for (const user of data.users) {
      if (!unresolvedUserIds.has(user.id)) continue;
      lastSignInById.set(user.id, user.last_sign_in_at ?? null);
      unresolvedUserIds.delete(user.id);
    }
    if (data.users.length < 100) break;
  }

  return (people ?? []).map((person) => toAccount(
    person,
    person.auth_user_id ? profileById.get(person.auth_user_id) : undefined,
    person.auth_user_id ? lastSignInById.get(person.auth_user_id) : undefined,
  ));
}

export async function createPortalAccount(input: CreateAccountInput): Promise<AccountMutationResult> {
  if (isUatMode()) return { error: "This operation is unavailable in UAT." };
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId);
  const loginName = normalisePortalLogin(input.loginName);
  if (!isPortalLoginEmail(loginName)) throw new Error("Use the employee’s company email, or personal email if they have no company email.");
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
  });
  if (createError || !created.user) throw new Error("The login could not be created.");

  let saved: unknown;
  let saveError: { code?: string; message: string } | null = null;
  try {
    const result = await supabase.rpc("create_portal_account", {
      p_person_id: input.personId,
      p_auth_user_id: created.user.id,
      p_login_name: loginName,
      p_app_role: NEW_ACCOUNT_ROLE,
      p_expected_person_version: input.accountVersion,
    });
    saved = result.data;
    saveError = result.error;
    if (!saveError) {
      const row = mapRpcAccount(saved);
      if (row.person_id !== input.personId || row.auth_user_id !== created.user.id || row.login_name !== loginName) {
        saveError = { message: GENERIC_ERROR };
      }
    }
  } catch {
    saveError = { message: GENERIC_ERROR };
  }

  if (saveError) {
    const outcome = await inspectCreatedAccount(admin, input.personId, created.user.id, opaqueAddress, loginName);
    if (outcome !== "committed") {
      // Only a server SQL rejection proves that this create transaction ended.
      // A network/5xx/malformed response can leave a transaction still running,
      // even when an immediate read currently shows no link.
      const definitelyRejected = ["22004", "22023", "23503", "23505", "40001", "42501"].includes(saveError.code ?? "");
      if (definitelyRejected && outcome === "unlinked") {
        let deleted = false;
        let deletionAttempted = false;
        try {
          // Lock and recheck the exact orphan, then fence future linkage until
          // deletion completes. This closes the read-back/delete race.
          const { data: reserved, error: reserveError } = await admin.rpc("reserve_portal_account_creation_cleanup", {
            p_auth_user_id: created.user.id,
            p_auth_email: opaqueAddress,
          });
          if (!reserveError && reserved === true) {
            deletionAttempted = true;
            const { error: deleteError } = await admin.auth.admin.deleteUser(created.user.id);
            deleted = !deleteError;
          }
        } catch {
          // An ambiguous cleanup result also needs reconciliation; never retry
          // deletion or report the account as definitely absent.
        }
        if (deleted) throw new Error(saveError.message.includes("login_name") ? "That login name is already in use." : GENERIC_ERROR);
        if (deletionAttempted) throw new Error("The unlinked login cleanup result could not be confirmed. Administrator reconciliation is required; refresh before trying again.");
      }
      throw new Error("The account creation result could not be confirmed. The login was preserved for administrator reconciliation; refresh before trying again.");
    }
  }
  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId), oneTimePassword: input.newPassword };
}

export async function updatePortalLogin(input: UpdateLoginInput): Promise<AccountMutationResult> {
  if (isUatMode()) return { error: "This operation is unavailable in UAT." };
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  const loginName = normalisePortalLogin(input.loginName);
  if (!isPortalLoginEmail(loginName)) throw new Error("Use the employee’s company email, or personal email if they have no company email.");
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
  if (isUatMode()) return { error: "This operation is unavailable in UAT." };
  const { supabase } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  validatePassword(input.newPassword);
  await requireLinkedAccount(input.personId, input.userId, input.accountVersion);

  const { data: claimed, error: claimError } = await supabase.rpc("begin_portal_password_reset", {
    p_person_id: input.personId,
    p_auth_user_id: input.userId,
    p_expected_account_version: input.accountVersion,
  });
  if (claimError?.code === "55000" && claimError.message === "Onboarding credential delivery in progress") {
    return { error: "The password was not changed. Onboarding credential delivery is in progress or awaiting administrator review." };
  }
  if (claimError) throw new Error(GENERIC_ERROR);
  const claim = mapPasswordResetClaim(claimed);

  const admin = createAdminClient();
  const unconfirmedReset = { error: "The password-reset result could not be confirmed. Administrator reconciliation is required before trying again." };
  try {
    const { data, error } = await admin.auth.admin.updateUserById(input.userId, { password: input.newPassword });
    if (error || !data.user) return unconfirmedReset;
  } catch {
    return unconfirmedReset;
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
  if (isUatMode()) return { error: "This operation is unavailable in UAT." };
  const { supabase, actorUserId } = await requireAccountAdministrator();
  validateIds(input.personId, input.userId);
  if (!input.enabled && input.userId === actorUserId) throw new Error("You cannot disable your own login.");
  const admin = createAdminClient();

  const { changeToken } = await preparePortalAccountStatusChange(supabase, admin, input);
  await finalisePortalAccountStatusChange(supabase, { personId: input.personId, userId: input.userId, changeToken });

  revalidatePath("/");
  return { account: await loadAccountByPerson(input.personId) };
}
