"use client";

import {
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Search,
  Sparkles,
  UserRoundCheck,
  UserRoundPlus,
  UserRoundX,
  X,
} from "lucide-react";
import { FormEvent, Fragment, MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import toolbar from "@/components/people-toolbar.module.css";
import styles from "@/components/account-management.module.css";
import { applyAccountStatusBatch, type AccountStatusFailure } from "@/components/account-status-batch";
import { AnimatedStatusBadge } from "@/components/ui/animated-status-badge";

export type AccountStatus = "unlinked" | "active" | "disabled";

export type AccountDto = {
  personId: string;
  name: string;
  position: string;
  company: string;
  userId?: string;
  loginName?: string;
  status: AccountStatus;
  lastSignInAt?: string;
  accountVersion: number;
};

export type AccountMutationResult = {
  account?: AccountDto;
  oneTimePassword?: string;
};

export type CreateAccountInput = {
  personId: string;
  loginName: string;
  newPassword: string;
  accountVersion: number;
};

export type UpdateLoginInput = {
  personId: string;
  userId: string;
  loginName: string;
  accountVersion: number;
};

export type ResetPasswordInput = {
  personId: string;
  userId: string;
  newPassword: string;
  accountVersion: number;
};

export type ToggleAccountInput = {
  personId: string;
  userId: string;
  enabled: boolean;
  accountVersion: number;
};

export type AccountManagementProps = {
  accounts: AccountDto[];
  onAccountChanged?: (account: AccountDto) => void;
  onCreateAccount: (
    input: CreateAccountInput,
  ) => Promise<AccountMutationResult | void>;
  onUpdateLogin: (
    input: UpdateLoginInput,
  ) => Promise<AccountMutationResult | void>;
  onResetPassword: (
    input: ResetPasswordInput,
  ) => Promise<AccountMutationResult | void>;
  onToggleEnabled: (
    input: ToggleAccountInput,
  ) => Promise<AccountMutationResult | void>;
};

type EditorAction = "create" | "login" | "password" | "toggle";

type AccountSort = "name" | "company" | "status" | "last-sign-in";

type EditorState = {
  personId: string;
  action: EditorAction;
};

type OneTimePassword = {
  personId: string;
  name: string;
  password: string;
  kind: "created" | "reset";
};

const statusLabels: Record<AccountStatus, string> = {
  unlinked: "No login",
  active: "Active",
  disabled: "Disabled",
};

const statusTones: Record<AccountStatus, "neutral" | "success" | "danger"> = {
  unlinked: "neutral",
  active: "success",
  disabled: "danger",
};

const passwordCharacters =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?";
const requiredPasswordGroups = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%&*+-=?",
];
const accountsPerPage = 12;

const statusSortOrder: Record<AccountStatus, number> = {
  active: 0,
  disabled: 1,
  unlinked: 2,
};

function randomCharacter(characters: string) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return characters[random[0] % characters.length];
}

function generateStrongPassword(length = 18) {
  const password = requiredPasswordGroups.map(randomCharacter);

  while (password.length < length) {
    password.push(randomCharacter(passwordCharacters));
  }

  for (let index = password.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const swapIndex = random[0] % (index + 1);
    [password[index], password[swapIndex]] = [
      password[swapIndex],
      password[index],
    ];
  }

  return password.join("");
}

function normalise(value: string) {
  return value.trim().toLocaleLowerCase();
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join("");
}

function companyLabel(company: string) {
  const cleaned = company.trim();
  if (!cleaned) return "Company";
  if (cleaned.toLocaleLowerCase() === "mam") return "MAM";
  return cleaned[0].toLocaleUpperCase() + cleaned.slice(1);
}

function formatLastSignIn(value?: string) {
  if (!value) return "Never signed in";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sign-in recorded";

  return `${new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)}`;
}

function compareNames(first: AccountDto, second: AccountDto) {
  return first.name.localeCompare(second.name, "en-AU", {
    sensitivity: "base",
  });
}

function lastSignInTimestamp(value?: string) {
  if (!value) return -1;

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? -1 : timestamp;
}

function compareAccounts(
  first: AccountDto,
  second: AccountDto,
  sort: AccountSort,
) {
  if (sort === "company") {
    return (
      first.company.localeCompare(second.company, "en-AU", {
        sensitivity: "base",
      }) || compareNames(first, second)
    );
  }

  if (sort === "status") {
    return (
      statusSortOrder[first.status] - statusSortOrder[second.status] ||
      compareNames(first, second)
    );
  }

  if (sort === "last-sign-in") {
    return (
      lastSignInTimestamp(second.lastSignInAt) -
        lastSignInTimestamp(first.lastSignInAt) || compareNames(first, second)
    );
  }

  return compareNames(first, second);
}

function isLinked(account: AccountDto): account is AccountDto & {
  userId: string;
} {
  return account.status !== "unlinked" && Boolean(account.userId);
}

export function AccountManagement({
  accounts,
  onAccountChanged,
  onCreateAccount,
  onUpdateLogin,
  onResetPassword,
  onToggleEnabled,
}: AccountManagementProps) {
  const [recordOverrides, setRecordOverrides] = useState<
    Record<string, AccountDto>
  >({});
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AccountSort>("name");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [loginName, setLoginName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [oneTimePassword, setOneTimePassword] =
    useState<OneTimePassword | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkPlan, setBulkPlan] = useState<{ enabled: boolean; accounts: AccountDto[] } | null>(null);
  const [bulkFailures, setBulkFailures] = useState<AccountStatusFailure[]>([]);
  const bulkInFlight = useRef(false);
  const bulkCancelRef = useRef<HTMLButtonElement>(null);
  const bulkWasOpenRef = useRef(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!openActionMenuId) return;

    function closeActionMenu(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-account-action-menu]")
      ) {
        return;
      }

      setOpenActionMenuId(null);
    }

    document.addEventListener("pointerdown", closeActionMenu);
    return () => document.removeEventListener("pointerdown", closeActionMenu);
  }, [openActionMenuId]);

  useEffect(() => {
    if (editor) {
      const frame = window.requestAnimationFrame(() => {
        const panel = editorPanelRef.current;
        const initialTarget = panel?.querySelector<HTMLElement>(
          "[data-account-editor-initial-focus]",
        );
        (initialTarget ?? panel)?.focus({ preventScroll: true });
      });

      return () => window.cancelAnimationFrame(frame);
    }

    const returnTarget = editorReturnFocusRef.current;
    editorReturnFocusRef.current = null;
    if (!returnTarget) return;

    const frame = window.requestAnimationFrame(() => {
      const target = returnTarget.isConnected
        ? returnTarget
        : searchInputRef.current;
      target?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  const records = useMemo(
    () =>
      accounts.map((account) => {
        const override = recordOverrides[account.personId];
        return override && override.accountVersion > account.accountVersion
          ? override
          : account;
      }),
    [accounts, recordOverrides],
  );

  const matchingAccounts = useMemo(() => {
    const cleanedQuery = normalise(query);
    if (!cleanedQuery) return records;

    return records.filter((account) =>
      normalise(
        `${account.name} ${account.position} ${account.company} ${account.loginName ?? ""}`,
      ).includes(cleanedQuery),
    );
  }, [query, records]);

  const sortedAccounts = useMemo(
    () =>
      [...matchingAccounts].sort((first, second) =>
        compareAccounts(first, second, sort),
      ),
    [matchingAccounts, sort],
  );

  const pageCount = Math.max(
    1,
    Math.ceil(sortedAccounts.length / accountsPerPage),
  );
  const currentPage = Math.min(page, pageCount);
  const firstAccountIndex = (currentPage - 1) * accountsPerPage;
  const paginatedAccounts = sortedAccounts.slice(
    firstAccountIndex,
    firstAccountIndex + accountsPerPage,
  );
  const selectedAccounts = records.filter((account) => selectedIds.includes(account.personId) && isLinked(account));
  const selectableAccounts = paginatedAccounts.filter(isLinked);
  const allVisibleSelected = selectableAccounts.length > 0 && selectableAccounts.every((account) => selectedIds.includes(account.personId));
  const someVisibleSelected = selectableAccounts.some((account) => selectedIds.includes(account.personId));
  const selectionLocked = saving || Boolean(editor) || Boolean(bulkPlan);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
  }, [allVisibleSelected, someVisibleSelected]);

  useEffect(() => {
    if (bulkPlan) {
      bulkWasOpenRef.current = true;
      bulkCancelRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!bulkWasOpenRef.current) return;
    bulkWasOpenRef.current = false;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [bulkPlan]);

  const visibleRange = sortedAccounts.length
    ? `Showing ${firstAccountIndex + 1}–${Math.min(
        firstAccountIndex + accountsPerPage,
        sortedAccounts.length,
      )} of ${sortedAccounts.length} account${sortedAccounts.length === 1 ? "" : "s"}`
    : "No matching accounts";

  function updateQuery(value: string) {
    setQuery(value);
    setPage(1);
    setSelectedIds([]);
    setBulkFailures([]);
  }

  function clearSearch() {
    updateQuery("");
    searchInputRef.current?.focus({ preventScroll: true });
  }

  function updateSort(value: AccountSort) {
    setSort(value);
    setPage(1);
    setSelectedIds([]);
    setBulkFailures([]);
  }

  function goToPage(nextPage: number) {
    setPage(Math.max(1, Math.min(nextPage, pageCount)));
    setSelectedIds([]);
    setBulkFailures([]);
  }

  function selectAccount(personId: string, checked: boolean) {
    setSelectedIds((current) => checked ? [...new Set([...current, personId])] : current.filter((id) => id !== personId));
    setBulkFailures([]);
  }

  function selectVisible(checked: boolean) {
    const visibleIds = new Set(selectableAccounts.map((account) => account.personId));
    setSelectedIds((current) => checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.has(id)));
    setBulkFailures([]);
  }

  function prepareBulkStatus(enabled: boolean) {
    if (selectionLocked) return;
    const candidates = selectedAccounts.filter((account) => account.status === (enabled ? "disabled" : "active"));
    if (!candidates.length) return;
    setBulkPlan({ enabled, accounts: candidates });
    setBulkFailures([]);
    setNotice("");
    setOpenActionMenuId(null);
  }

  function cancelBulkStatus() {
    if (bulkInFlight.current) return;
    setBulkPlan(null);
  }

  async function submitBulkStatus() {
    if (!bulkPlan || bulkInFlight.current) return;
    bulkInFlight.current = true;
    setSaving(true);
    try {
      const result = await applyAccountStatusBatch(bulkPlan.accounts, bulkPlan.enabled, onToggleEnabled);
      for (const account of result.confirmed) applyResult({ account });
      setSelectedIds(result.failures.map((failure) => failure.personId));
      setBulkFailures(result.failures);
      setNotice(`${result.confirmed.length} login${result.confirmed.length === 1 ? "" : "s"} ${bulkPlan.enabled ? "enabled" : "disabled"}.${result.failures.length ? ` ${result.failures.length} not confirmed; still selected.` : ""}`);
      setBulkPlan(null);
    } finally {
      setSaving(false);
      bulkInFlight.current = false;
    }
  }

  function clearEditor() {
    setEditor(null);
    setLoginName("");
    setNewPassword("");
    setShowPassword(false);
    setOneTimePassword(null);
    setError("");
  }

  function closeEditor() {
    if (saving) return;
    clearEditor();
  }

  function openEditor(
    account: AccountDto,
    action: EditorAction,
    returnFocusTarget?: HTMLElement | null,
  ) {
    if (saving || bulkPlan) return;
    editorReturnFocusRef.current =
      returnFocusTarget ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : searchInputRef.current);
    setOpenActionMenuId(null);
    setEditor({ personId: account.personId, action });
    setLoginName(action === "login" ? (account.loginName ?? "") : "");
    setNewPassword("");
    setShowPassword(false);
    setOneTimePassword(null);
    setError("");
    setNotice("");
  }

  function openActionEditor(
    event: MouseEvent<HTMLButtonElement>,
    account: AccountDto,
    action: Exclude<EditorAction, "create">,
  ) {
    const menu = event.currentTarget.closest("details");
    const returnFocusTarget = menu?.querySelector<HTMLElement>("summary");
    menu?.removeAttribute("open");
    openEditor(account, action, returnFocusTarget);
  }

  function applyResult(result?: AccountMutationResult | void) {
    if (!result?.account) return;

    setRecordOverrides((current) => ({
      ...current,
      [result.account!.personId]: result.account!,
    }));
    onAccountChanged?.(result.account);
  }

  function makePassword() {
    setNewPassword(generateStrongPassword());
    setShowPassword(true);
    setError("");
  }

  async function submitCreate(
    event: FormEvent<HTMLFormElement>,
    account: AccountDto,
  ) {
    event.preventDefault();
    const cleanLogin = loginName.trim();
    if (!cleanLogin || !newPassword) return;

    setSaving(true);
    setError("");

    try {
      const result = await onCreateAccount({
        personId: account.personId,
        loginName: cleanLogin,
        newPassword,
        accountVersion: account.accountVersion,
      });
      const oneTimeValue = result?.oneTimePassword ?? newPassword;
      applyResult(result);
      setNewPassword("");
      setLoginName("");
      setOneTimePassword({
        personId: account.personId,
        name: account.name,
        password: oneTimeValue,
        kind: "created",
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The account could not be created. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitLogin(
    event: FormEvent<HTMLFormElement>,
    account: AccountDto & { userId: string },
  ) {
    event.preventDefault();
    const cleanLogin = loginName.trim();
    if (!cleanLogin) return;

    setSaving(true);
    setError("");

    try {
      const result = await onUpdateLogin({
        personId: account.personId,
        userId: account.userId,
        loginName: cleanLogin,
        accountVersion: account.accountVersion,
      });
      applyResult(result);
      clearEditor();
      setNotice(`Login updated for ${account.name}.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The login could not be updated. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitPassword(
    event: FormEvent<HTMLFormElement>,
    account: AccountDto & { userId: string },
  ) {
    event.preventDefault();
    if (!newPassword) return;

    setSaving(true);
    setError("");

    try {
      const result = await onResetPassword({
        personId: account.personId,
        userId: account.userId,
        newPassword,
        accountVersion: account.accountVersion,
      });
      const oneTimeValue = result?.oneTimePassword ?? newPassword;
      applyResult(result);
      setNewPassword("");
      setOneTimePassword({
        personId: account.personId,
        name: account.name,
        password: oneTimeValue,
        kind: "reset",
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The password could not be reset. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function submitToggle(account: AccountDto & { userId: string }) {
    const enabled = account.status === "disabled";
    setSaving(true);
    setError("");

    try {
      const result = await onToggleEnabled({
        personId: account.personId,
        userId: account.userId,
        enabled,
        accountVersion: account.accountVersion,
      });
      applyResult(result);
      clearEditor();
      setNotice(`${account.name}'s login ${enabled ? "enabled" : "disabled"}.`);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : `The login could not be ${enabled ? "enabled" : "disabled"}. Try again.`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function copyPassword() {
    if (!oneTimePassword) return;

    try {
      await navigator.clipboard.writeText(oneTimePassword.password);
      const name = oneTimePassword.name;
      setOneTimePassword(null);
      setEditor(null);
      setNotice(`New password copied for ${name} and cleared from this page.`);
    } catch {
      setError(
        "Copy was blocked by the browser. Check its clipboard permission.",
      );
    }
  }

  return (
    <section className={styles.workspace} aria-labelledby="account-title">
      <h2 className={styles.srOnly} id="account-title">Login accounts</h2>

      <div className={toolbar.toolbar}>
        <label className={toolbar.search}>
          <Search aria-hidden="true" size={17} />
          <span className={styles.srOnly}>Search accounts</span>
          <input
            disabled={saving || Boolean(bulkPlan)}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search name, role or login"
            ref={searchInputRef}
            type="search"
            value={query}
          />
        </label>

        <label className={toolbar.select}>
          <span>Sort</span>
          <select
            aria-label="Sort accounts"
            disabled={saving || Boolean(bulkPlan)}
            onChange={(event) => updateSort(event.target.value as AccountSort)}
            value={sort}
          >
            <option value="name">Name A–Z</option>
            <option value="company">Company</option>
            <option value="status">Status</option>
            <option value="last-sign-in">Last sign-in</option>
          </select>
        </label>
      </div>

      {notice ? (
        <div className={styles.notice} role="status">
          <Check aria-hidden="true" size={15} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}

      {selectedAccounts.length ? (
        <div className={styles.bulkToolbar} aria-label="Selected accounts">
          <strong>{selectedAccounts.length} selected</strong>
          <div>
            <button className={styles.secondaryButton} disabled={selectionLocked || !selectedAccounts.some((account) => account.status === "disabled")} onClick={() => prepareBulkStatus(true)} type="button">Enable logins</button>
            <button className={styles.secondaryButton} disabled={selectionLocked || !selectedAccounts.some((account) => account.status === "active")} onClick={() => prepareBulkStatus(false)} type="button">Disable logins</button>
            <button className={styles.textButton} disabled={selectionLocked} onClick={() => { setSelectedIds([]); setBulkFailures([]); }} type="button">Clear selection</button>
          </div>
        </div>
      ) : null}

      {bulkPlan ? (
        <section className={styles.bulkConfirmation} aria-labelledby="bulk-account-title" aria-busy={saving}>
          <div>
            <h3 id="bulk-account-title">{bulkPlan.enabled ? "Enable" : "Disable"} {bulkPlan.accounts.length} login{bulkPlan.accounts.length === 1 ? "" : "s"}?</h3>
            <p>{bulkPlan.enabled ? "These people will be able to sign in again." : "These people will be signed out and unable to sign in."}</p>
            <ul>{bulkPlan.accounts.map((account) => <li key={account.personId}>{account.name}</li>)}</ul>
          </div>
          <div className={styles.bulkConfirmationActions}>
            <button className={styles.secondaryButton} disabled={saving} onClick={cancelBulkStatus} ref={bulkCancelRef} type="button">Cancel</button>
            <button className={bulkPlan.enabled ? styles.primaryButton : styles.dangerButton} disabled={saving} onClick={submitBulkStatus} type="button">{saving ? "Saving…" : `${bulkPlan.enabled ? "Enable" : "Disable"} ${bulkPlan.accounts.length} logins`}</button>
          </div>
        </section>
      ) : null}

      {bulkFailures.length ? (
        <div className={styles.bulkErrors} role="alert">
          <strong>Not confirmed</strong>
          <ul>{bulkFailures.map((failure) => <li key={failure.personId}><strong>{failure.name}:</strong> {failure.message}</li>)}</ul>
        </div>
      ) : null}

      <div className={styles.accountList} role="region" aria-label="Accounts register" tabIndex={0}>
        <table className={styles.accountTable} aria-label="Login accounts">
          <thead><tr>
            <th scope="col" className={styles.selectCell}><label className={styles.selectionLabel}><input aria-label="Select all visible accounts" checked={allVisibleSelected} disabled={selectionLocked || !selectableAccounts.length} onChange={(event) => selectVisible(event.target.checked)} ref={selectAllRef} type="checkbox" /><span>Select</span></label></th>
            <th scope="col">Employee</th><th scope="col">Company</th><th scope="col">Login email</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col">Actions</th>
          </tr></thead>
          <tbody>
        {paginatedAccounts.map((account) => {
          const activeEditor =
            editor?.personId === account.personId ? editor : null;
          const linked = isLinked(account);
          const receipt =
            oneTimePassword?.personId === account.personId
              ? oneTimePassword
              : null;

          return (
            <Fragment key={account.personId}>
              <tr className={styles.accountTableRow} data-open={Boolean(activeEditor)} data-selected={selectedIds.includes(account.personId)}>
                <td className={styles.selectCell}><label className={styles.selectionLabel}><input aria-label={`Select ${account.name}`} checked={selectedIds.includes(account.personId)} disabled={!linked || selectionLocked} onChange={(event) => selectAccount(account.personId, event.target.checked)} type="checkbox" /><span className={styles.srOnly}>{linked ? `Select ${account.name}` : "Create login before selecting"}</span></label></td>
                <td><div className={styles.employeeCell}>
                <div
                  className={styles.avatar}
                  data-company={account.company.toLocaleLowerCase()}
                  aria-hidden="true"
                >
                  {initials(account.name)}
                </div>

                <div className={styles.personCopy}>
                  <div className={styles.nameLine}>
                    <strong>{account.name}</strong>
                  </div>
                  <p>{account.position}</p>
                </div>

                </div></td>
                <td><span className={styles.companyBadge} data-company={account.company.toLocaleLowerCase()}>{companyLabel(account.company)}</span></td>
                <td className={styles.loginCell}>{account.loginName || "Not created"}</td>
                <td><AnimatedStatusBadge className={styles.status} tone={statusTones[account.status]}>
                  {statusLabels[account.status]}
                </AnimatedStatusBadge></td>
                <td className={styles.signInCell}>{formatLastSignIn(account.lastSignInAt)}</td>
                <td><div className={styles.actions}>
                  {!linked ? (
                    <button
                      className={styles.primaryButton}
                      disabled={saving || Boolean(bulkPlan)}
                      onClick={(event) =>
                        openEditor(account, "create", event.currentTarget)
                      }
                      type="button"
                    >
                      <UserRoundPlus aria-hidden="true" size={15} />
                      Create login
                    </button>
                  ) : (
                    <details
                      className={styles.actionMenu}
                      data-account-action-menu
                      open={openActionMenuId === account.personId}
                      onToggle={(event) => setOpenActionMenuId(event.currentTarget.open ? account.personId : (current) => current === account.personId ? null : current)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpenActionMenuId(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        setOpenActionMenuId(null);
                        event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
                      }}
                    >
                      <summary aria-label={`Manage ${account.name}'s login`} aria-disabled={saving || Boolean(bulkPlan)} onClick={(event) => { if (saving || bulkPlan) event.preventDefault(); }} title="Manage login"><MoreHorizontal aria-hidden="true" size={18} /></summary>
                      <div className={styles.actionMenuPopover}>
                        <button className={styles.textButton} onClick={(event) => openActionEditor(event, account, "login")} type="button">Change login</button>
                        <button className={styles.textButton} onClick={(event) => openActionEditor(event, account, "password")} type="button">Reset password</button>
                        <button className={styles.textButton} onClick={(event) => openActionEditor(event, account, "toggle")} type="button">
                          {account.status === "disabled" ? <UserRoundCheck aria-hidden="true" size={16} /> : <UserRoundX aria-hidden="true" size={16} />}
                          {account.status === "disabled" ? "Enable login" : "Disable login"}
                        </button>
                      </div>
                    </details>
                  )}
                </div></td>
              </tr>

              {activeEditor ? (
                <tr><td colSpan={7} className={styles.editorCell}><div
                  aria-busy={saving}
                  className={styles.editor}
                  ref={editorPanelRef}
                  tabIndex={-1}
                >
                  <div className={styles.editorHeader}>
                    <div>
                      <KeyRound aria-hidden="true" size={17} />
                      <strong>
                        {activeEditor.action === "create"
                          ? "Create login"
                          : activeEditor.action === "login"
                            ? "Change login"
                            : activeEditor.action === "password"
                              ? "Reset password"
                              : account.status === "disabled"
                                ? "Enable login"
                                : "Disable login"}
                      </strong>
                    </div>
                    <button
                      aria-label="Close account editor"
                      disabled={saving}
                      onClick={closeEditor}
                      type="button"
                    >
                      <X aria-hidden="true" size={16} />
                    </button>
                  </div>

                  {receipt ? (
                    <div className={styles.passwordReceipt}>
                      <div>
                        <LockKeyhole aria-hidden="true" size={18} />
                        <div>
                          <strong>
                            Password{" "}
                            {receipt.kind === "created" ? "created" : "reset"}
                          </strong>
                          <p>
                            Copy it now. It will be removed from this page after
                            copying.
                          </p>
                        </div>
                      </div>
                      <code>{receipt.password}</code>
                      <div className={styles.receiptActions}>
                        <button
                          className={styles.primaryButton}
                          onClick={copyPassword}
                          type="button"
                        >
                          <Copy aria-hidden="true" size={15} />
                          Copy once
                        </button>
                        <button
                          className={styles.textButton}
                          onClick={closeEditor}
                          type="button"
                        >
                          Clear without copying
                        </button>
                      </div>
                    </div>
                  ) : activeEditor.action === "create" ? (
                    <form onSubmit={(event) => submitCreate(event, account)}>
                      <LoginField
                        loginName={loginName}
                        onChange={setLoginName}
                      />
                      <PasswordField
                        newPassword={newPassword}
                        onChange={setNewPassword}
                        onGenerate={makePassword}
                        onToggleVisibility={() =>
                          setShowPassword((current) => !current)
                        }
                        showPassword={showPassword}
                      />
                      <FormFooter
                        error={error}
                        onCancel={closeEditor}
                        saving={saving}
                        submitLabel="Create login"
                      />
                    </form>
                  ) : activeEditor.action === "login" && linked ? (
                    <form onSubmit={(event) => submitLogin(event, account)}>
                      <LoginField
                        loginName={loginName}
                        onChange={setLoginName}
                      />
                      <FormFooter
                        error={error}
                        onCancel={closeEditor}
                        saving={saving}
                        submitLabel="Save login"
                      />
                    </form>
                  ) : activeEditor.action === "password" && linked ? (
                    <form onSubmit={(event) => submitPassword(event, account)}>
                      <PasswordField
                        newPassword={newPassword}
                        onChange={setNewPassword}
                        onGenerate={makePassword}
                        onToggleVisibility={() =>
                          setShowPassword((current) => !current)
                        }
                        showPassword={showPassword}
                      />
                      <FormFooter
                        error={error}
                        onCancel={closeEditor}
                        saving={saving}
                        submitLabel="Reset password"
                      />
                    </form>
                  ) : activeEditor.action === "toggle" && linked ? (
                    <div className={styles.confirmation}>
                      <p>
                        {account.status === "disabled"
                          ? `${account.name} will be able to sign in again.`
                          : `${account.name} will be signed out and unable to sign in.`}
                      </p>
                      {error ? <p className={styles.error}>{error}</p> : null}
                      <div>
                        <button
                          className={styles.secondaryButton}
                          data-account-editor-initial-focus
                          disabled={saving}
                          onClick={closeEditor}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className={
                            account.status === "disabled"
                              ? styles.primaryButton
                              : styles.dangerButton
                          }
                          disabled={saving}
                          onClick={() => submitToggle(account)}
                          type="button"
                        >
                          {saving
                            ? "Saving…"
                            : account.status === "disabled"
                              ? "Enable login"
                              : "Disable login"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div></td></tr>
              ) : null}
            </Fragment>
          );
        })}

        {!sortedAccounts.length ? (
          <tr><td colSpan={7}><div className={styles.emptyState}>
            <Search aria-hidden="true" size={20} />
            <strong>No accounts match this search.</strong>
            <button onClick={clearSearch} type="button">
              Clear search
            </button>
          </div></td></tr>
        ) : null}
          </tbody>
        </table>
      </div>

      {sortedAccounts.length ? (
        <footer className={styles.pagination}>
          <p
            className={styles.pageRange}
            id="account-results-range"
            role="status"
          >
            {visibleRange}
          </p>
          <nav
            aria-describedby="account-results-range"
            aria-label="Account page navigation"
            className={styles.pageControls}
          >
            <button
              aria-label="Previous page"
              disabled={saving || Boolean(bulkPlan) || currentPage === 1}
              onClick={() => goToPage(currentPage - 1)}
              type="button"
            >
              <ChevronLeft aria-hidden="true" size={16} />
            </button>
            <span aria-current="page" className={styles.pageIndicator}>
              Page {currentPage} of {pageCount}
            </span>
            <button
              aria-label="Next page"
              disabled={saving || Boolean(bulkPlan) || currentPage === pageCount}
              onClick={() => goToPage(currentPage + 1)}
              type="button"
            >
              <ChevronRight aria-hidden="true" size={16} />
            </button>
          </nav>
        </footer>
      ) : null}
    </section>
  );
}

function LoginField({
  loginName,
  onChange,
}: {
  loginName: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>Login email</span>
      <input
        autoCapitalize="none"
        autoComplete="off"
        data-account-editor-initial-focus
        maxLength={254}
        minLength={3}
        onChange={(event) => onChange(event.target.value)}
        placeholder="name@company.com"
        required
        spellCheck={false}
        type="email"
        value={loginName}
      />
    </label>
  );
}

function PasswordField({
  newPassword,
  onChange,
  onGenerate,
  onToggleVisibility,
  showPassword,
}: {
  newPassword: string;
  onChange: (value: string) => void;
  onGenerate: () => void;
  onToggleVisibility: () => void;
  showPassword: boolean;
}) {
  return (
    <div className={styles.passwordField}>
      <div className={styles.fieldLabel}>
        <span>New password</span>
        <button onClick={onGenerate} type="button">
          <Sparkles aria-hidden="true" size={14} />
          Generate strong password
        </button>
      </div>
      <div className={styles.passwordInput}>
        <input
          aria-label="New password"
          autoComplete="new-password"
          data-account-editor-initial-focus
          minLength={12}
          onChange={(event) => onChange(event.target.value)}
          placeholder="At least 12 characters"
          required
          type={showPassword ? "text" : "password"}
          value={newPassword}
        />
        <button
          aria-label={showPassword ? "Hide new password" : "Show new password"}
          onClick={onToggleVisibility}
          type="button"
        >
          {showPassword ? (
            <EyeOff aria-hidden="true" size={17} />
          ) : (
            <Eye aria-hidden="true" size={17} />
          )}
        </button>
      </div>
      <small>
        Use 12 or more characters. This value is not saved in the page.
      </small>
    </div>
  );
}

function FormFooter({
  error,
  onCancel,
  saving,
  submitLabel,
}: {
  error: string;
  onCancel: () => void;
  saving: boolean;
  submitLabel: string;
}) {
  return (
    <footer className={styles.formFooter}>
      {error ? <p className={styles.error}>{error}</p> : <span />}
      <div>
        <button
          className={styles.secondaryButton}
          disabled={saving}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className={styles.primaryButton}
          disabled={saving}
          type="submit"
        >
          {saving ? "Saving…" : submitLabel}
        </button>
      </div>
    </footer>
  );
}
