import type {
  AccountDto,
  AccountManagementProps,
} from "@/components/account-management";

export type AccountStatusFailure = {
  personId: string;
  name: string;
  message: string;
};

/** Keep each account's existing permission, version and audit checks authoritative. */
export async function applyAccountStatusBatch(
  accounts: readonly AccountDto[],
  enabled: boolean,
  toggle: AccountManagementProps["onToggleEnabled"],
) {
  const confirmed: AccountDto[] = [];
  const failures: AccountStatusFailure[] = [];
  const seen = new Set<string>();

  for (const account of accounts) {
    if (seen.has(account.personId)) continue;
    seen.add(account.personId);
    try {
      if (!account.userId || account.status === "unlinked") {
        throw new Error("Create this person's login first.");
      }
      const result = await toggle({
        personId: account.personId,
        userId: account.userId,
        enabled,
        accountVersion: account.accountVersion,
      });
      if (
        !result?.account ||
        result.account.personId !== account.personId ||
        result.account.userId !== account.userId ||
        result.account.status !== (enabled ? "active" : "disabled")
      ) {
        throw new Error("Update not confirmed. Refresh accounts before trying again.");
      }
      confirmed.push(result.account);
    } catch (cause) {
      failures.push({
        personId: account.personId,
        name: account.name,
        message: cause instanceof Error ? cause.message : "Update not confirmed. Try again.",
      });
    }
  }

  return { confirmed, failures };
}
