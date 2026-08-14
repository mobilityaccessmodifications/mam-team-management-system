import "server-only";

import { createClient } from "@/lib/supabase/server";

// PostgreSQL's uuid type accepts all 128-bit UUID representations. The
// directory's imported deterministic IDs are valid UUIDs but do not promise a
// particular RFC version/variant nibble, so validation must not reject them.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC_CONTACT_ERROR = "Work contact could not be loaded. Refresh and try again.";

type WorkEmailRpcRow = {
  person_id: string;
  work_email: string | null;
};

function validWorkEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * Fetches one explicitly requested work contact. The database RPC performs
 * the membership check and deliberately does not expose any HR-private data.
 */
export async function getOrganisationPersonWorkEmailForMember(
  personId: unknown,
): Promise<string | null> {
  if (typeof personId !== "string" || !UUID_PATTERN.test(personId)) {
    throw new Error(GENERIC_CONTACT_ERROR);
  }

  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const { data, error } = await supabase.rpc("get_internal_org_work_email", {
    p_person_id: personId,
  });
  if (error || !Array.isArray(data) || data.length > 1) {
    throw new Error(GENERIC_CONTACT_ERROR);
  }

  const row = data[0] as WorkEmailRpcRow | undefined;
  if (!row || row.person_id !== personId) return null;

  return validWorkEmail(row.work_email);
}
