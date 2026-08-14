"use client";

import {
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleUserRound,
  Eye,
  LockKeyhole,
  Mail,
  Phone,
  RotateCcw,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "@/components/self-profile-menu.module.css";

/**
 * The signed-in person's safe profile information. Do not pass another
 * employee's private contact details into this component.
 */
export type SelfProfileData = {
  name: string;
  title: string;
  company: string;
  team?: string | null;
  manager?: string | null;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  /** ISO date (`YYYY-MM-DD`) only. */
  dateOfBirth?: string | null;
};

/** Fields a person may update for their own profile. An empty string clears a value. */
export type SelfProfileChanges = {
  personalEmail: string;
  phone: string;
  dateOfBirth: string;
};

/** An optional plain-language confirmation supplied by the owning screen. */
export type SelfProfileSaveResult = void | {
  message?: string;
};

/** Safe organisation-tree data used only by an authorised HR access preview. */
export type EmployeeAccessPreviewPerson = {
  id: string;
  name: string;
  roleLabel: string;
};

/**
 * An HR-only, presentation-only employee-view selector. It must never contain
 * private fields and must never change the authenticated session.
 */
export type EmployeeAccessPreview = {
  people: readonly EmployeeAccessPreviewPerson[];
  selectedPersonId: string;
  previewedPersonName?: string;
  onSelect: (personId: string) => void;
};

export type SelfProfileMenuProps = {
  /** The actual signed-in person's profile, rather than an access-preview profile. */
  profile: SelfProfileData;
  /**
   * Persist only the editable self-service fields. The caller must still check
   * the signed-in identity and authorise the update on the server.
   */
  onSave: (changes: SelfProfileChanges) => Promise<SelfProfileSaveResult>;
  /** Use while the profile record is initially loading. */
  disabled?: boolean;
  /** Present only for an authorised HR user; options contain safe work identity only. */
  accessPreview?: EmployeeAccessPreview;
  /** Presentation-only preview mode. Self-profile fields must not render or save while true. */
  isAccessPreview?: boolean;
};

type Feedback =
  | { tone: "idle"; message: "" }
  | { tone: "success"; message: string }
  | { tone: "error"; message: string };

const idleFeedback: Feedback = { tone: "idle", message: "" };
const STALE_PROFILE_MESSAGE = "Your profile was updated elsewhere. Refresh it, then try again.";

function initialsFor(name: string) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "ME";
}

function companyName(company: string) {
  if (company.toLowerCase() === "mam") return "MAM";
  if (company.toLowerCase() === "equipsy") return "Equipsy";
  return company;
}

/**
 * A compact top-bar account control that opens a private, self-service profile
 * form. It intentionally has no employee ID prop: persistence must be scoped
 * to the authenticated person by the server-side save handler.
 */
export function SelfProfileMenu({
  profile,
  onSave,
  disabled = false,
  accessPreview,
  isAccessPreview = false,
}: SelfProfileMenuProps) {
  const panelId = useId();
  const titleId = useId();
  const previewSelectId = useId();
  const personalEmailId = useId();
  const phoneId = useId();
  const birthDateId = useId();
  const workEmailId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const previewSelectRef = useRef<HTMLSelectElement>(null);

  const profileKey = [
    profile.name,
    profile.title,
    profile.company,
    profile.team ?? "",
    profile.manager ?? "",
    profile.workEmail ?? "",
    profile.personalEmail ?? "",
    profile.phone ?? "",
    profile.dateOfBirth ?? "",
  ].join("\u0001");
  const profileValues = useMemo(() => ({
    personalEmail: profile.personalEmail?.trim() ?? "",
    phone: profile.phone?.trim() ?? "",
    dateOfBirth: profile.dateOfBirth ?? "",
  }), [profile.dateOfBirth, profile.personalEmail, profile.phone]);
  const [savedLocally, setSavedLocally] = useState<{
    profileKey: string;
    values: SelfProfileChanges;
  } | null>(null);
  const [draftState, setDraftState] = useState(() => ({
    profileKey,
    values: profileValues,
  }));
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);
  const savedValues = savedLocally?.profileKey === profileKey ? savedLocally.values : profileValues;
  const draft = draftState.profileKey === profileKey ? draftState.values : profileValues;
  const displayName = profile.name.trim() || "My profile";
  const displayTitle = profile.title.trim() || "Team member";
  const organisation = companyName(profile.company);
  const today = new Date().toISOString().slice(0, 10);
  const hasAccessPreview = Boolean(accessPreview);
  const selectedPreviewPerson = accessPreview?.people.find((person) => person.id === accessPreview.selectedPersonId);
  const previewedPersonName = accessPreview?.previewedPersonName?.trim()
    || selectedPreviewPerson?.name.trim()
    || "this employee";
  const isPreviewingEmployeeAccess = isAccessPreview;
  const canEditSelfProfile = !disabled && !isPreviewingEmployeeAccess;
  const canOpenMenu = !disabled || hasAccessPreview;
  const triggerName = isPreviewingEmployeeAccess ? `Preview: ${previewedPersonName}` : displayName;
  const triggerTitle = isPreviewingEmployeeAccess ? "Employee access preview" : displayTitle;
  const triggerAvatarName = isPreviewingEmployeeAccess ? previewedPersonName : displayName;

  const closeMenu = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setDraftState({ profileKey, values: savedValues });
    setFeedback(idleFeedback);

    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [profileKey, savedValues]);

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        closeMenu();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => {
      if (isPreviewingEmployeeAccess && hasAccessPreview) {
        previewSelectRef.current?.focus();
        return;
      }
      if (canEditSelfProfile) firstInputRef.current?.focus();
    });

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [canEditSelfProfile, closeMenu, hasAccessPreview, isOpen, isPreviewingEmployeeAccess]);

  const isDirty = draft.personalEmail !== savedValues.personalEmail
    || draft.phone !== savedValues.phone
    || draft.dateOfBirth !== savedValues.dateOfBirth;

  function openMenu() {
    if (!canOpenMenu) return;
    setDraftState({ profileKey, values: savedValues });
    setFeedback(idleFeedback);
    setIsOpen(true);
  }

  function updateDraft(field: keyof SelfProfileChanges, value: string) {
    setDraftState((current) => {
      const currentValues = current.profileKey === profileKey ? current.values : profileValues;
      return { profileKey, values: { ...currentValues, [field]: value } };
    });
    if (feedback.tone !== "idle") setFeedback(idleFeedback);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEditSelfProfile || isSaving) return;
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (draft.dateOfBirth && draft.dateOfBirth > today) {
      setFeedback({ tone: "error", message: "Date of birth cannot be in the future." });
      return;
    }
    if (!isDirty) return;

    const changes: SelfProfileChanges = {
      personalEmail: draft.personalEmail.trim(),
      phone: draft.phone.trim(),
      dateOfBirth: draft.dateOfBirth,
    };

    setIsSaving(true);
    setFeedback(idleFeedback);
    try {
      const result = await onSave(changes);
      setSavedLocally({ profileKey, values: changes });
      setDraftState({ profileKey, values: changes });
      setFeedback({ tone: "success", message: result?.message ?? "Your profile changes are saved." });
    } catch (error) {
      // Server Actions deliberately return generic errors except for this
      // optimistic-concurrency case. Keep arbitrary server messages out of
      // the profile UI while still telling the employee what to do next.
      const message = error instanceof Error && error.message === STALE_PROFILE_MESSAGE
        ? STALE_PROFILE_MESSAGE
        : "Your profile changes could not be saved. Check the details and try again.";
      setFeedback({ tone: "error", message });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className={styles.root}
      data-company={profile.company.toLowerCase()}
      data-previewing={isPreviewingEmployeeAccess || undefined}
      ref={rootRef}
    >
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={isPreviewingEmployeeAccess
          ? `Open employee access preview controls for ${previewedPersonName}`
          : `Open ${displayName}'s profile`}
        className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ""}`}
        disabled={!canOpenMenu}
        onClick={() => isOpen ? closeMenu() : openMenu()}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.avatar} aria-hidden="true">{initialsFor(triggerAvatarName)}</span>
        <span className={styles.triggerCopy}>
          <strong>{triggerName}</strong>
          <small>{triggerTitle}</small>
        </span>
        <ChevronDown className={styles.chevron} aria-hidden="true" size={16} />
      </button>

      {isOpen ? (
        <section
          aria-labelledby={titleId}
          className={styles.panel}
          id={panelId}
          role="dialog"
        >
          <header className={styles.panelHeader}>
            <div className={styles.profileHeading}>
              <span className={styles.avatarLarge} aria-hidden="true">{initialsFor(isPreviewingEmployeeAccess ? previewedPersonName : displayName)}</span>
              <span>
                <strong id={titleId}>{isPreviewingEmployeeAccess ? "Employee access preview" : displayName}</strong>
                <small>{isPreviewingEmployeeAccess ? `Signed in as ${displayName}` : displayTitle}</small>
              </span>
            </div>
            <button className={styles.closeButton} type="button" onClick={() => closeMenu(true)} aria-label="Close profile">
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          {accessPreview ? <section className={styles.accessPreview} data-previewing={isPreviewingEmployeeAccess || undefined} aria-labelledby={`${panelId}-preview`}>
            <div className={styles.sectionHeading}>
              <Eye aria-hidden="true" size={17} />
              <span><strong id={`${panelId}-preview`}>Preview employee access</strong><small>View a real active employee&apos;s restricted interface without changing your sign-in.</small></span>
            </div>
            <label className={styles.previewField} htmlFor={previewSelectId}>
              <span>View as</span>
              <select
                id={previewSelectId}
                onChange={(event) => {
                  const personId = event.target.value;
                  if (!personId || accessPreview.people.some((person) => person.id === personId)) {
                    accessPreview.onSelect(personId);
                  }
                }}
                ref={previewSelectRef}
                value={accessPreview.selectedPersonId}
              >
                <option value="">My HR view</option>
                {accessPreview.people.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.roleLabel}</option>)}
              </select>
            </label>
            {isPreviewingEmployeeAccess ? <div className={styles.previewActiveNotice} role="status">
              <Eye aria-hidden="true" size={16} />
              <span><strong>Previewing {previewedPersonName}&apos;s employee access</strong><small>This is read-only. HR records, private details, and profile editing are hidden.</small></span>
              <button className={styles.returnToMyView} type="button" onClick={() => accessPreview.onSelect("")}><RotateCcw aria-hidden="true" size={15} /> Return to my HR view</button>
            </div> : null}
          </section> : null}

          {isPreviewingEmployeeAccess ? null : !canEditSelfProfile ? <p className={styles.profilePending} role="status">Your private profile is loading. You can still use the HR preview control above.</p> : <>
            <div className={styles.organisationSummary} aria-label="Your organisation details">
              <span><Building2 aria-hidden="true" size={15} /><b>Company</b><strong>{organisation || "Not listed"}</strong></span>
              <span><BriefcaseBusiness aria-hidden="true" size={15} /><b>Team</b><strong>{profile.team?.trim() || "Not listed"}</strong></span>
              <span><UserRound aria-hidden="true" size={15} /><b>Manager</b><strong>{profile.manager?.trim() || "Not assigned"}</strong></span>
            </div>

            <form className={styles.form} onSubmit={save}>
              <section className={styles.section} aria-labelledby={`${panelId}-contact`}>
                <div className={styles.sectionHeading}>
                  <CircleUserRound aria-hidden="true" size={17} />
                  <span><strong id={`${panelId}-contact`}>My contact details</strong><small>You can keep these details up to date yourself.</small></span>
                </div>

                <label className={styles.field} htmlFor={personalEmailId}>
                  <span><Mail aria-hidden="true" size={15} /> Personal email</span>
                  <input
                    autoComplete="email"
                    id={personalEmailId}
                    onChange={(event) => updateDraft("personalEmail", event.target.value)}
                    placeholder="you@example.com"
                    ref={firstInputRef}
                    type="email"
                    value={draft.personalEmail}
                  />
                  <small className={styles.helpText}>For HR contact only; changing it does not change your sign-in.</small>
                </label>
                <label className={styles.field} htmlFor={phoneId}>
                  <span><Phone aria-hidden="true" size={15} /> Phone</span>
                  <input
                    autoComplete="tel"
                    id={phoneId}
                    inputMode="tel"
                    onChange={(event) => updateDraft("phone", event.target.value)}
                    placeholder="Add a contact number"
                    type="tel"
                    value={draft.phone}
                  />
                </label>
                <label className={styles.field} htmlFor={birthDateId}>
                  <span><CalendarDays aria-hidden="true" size={15} /> Date of birth</span>
                  <input
                    autoComplete="bday"
                    id={birthDateId}
                    max={today}
                    onChange={(event) => updateDraft("dateOfBirth", event.target.value)}
                    type="date"
                    value={draft.dateOfBirth}
                  />
                </label>
              </section>

              <section className={`${styles.section} ${styles.readonlySection}`} aria-labelledby={`${panelId}-work`}>
                <div className={styles.sectionHeading}>
                  <ShieldCheck aria-hidden="true" size={17} />
                  <span><strong id={`${panelId}-work`}>Work contact</strong><small>Managed by HR to keep the directory accurate.</small></span>
                </div>
                <label className={styles.field} htmlFor={workEmailId}>
                  <span><Mail aria-hidden="true" size={15} /> Work email <em><LockKeyhole aria-hidden="true" size={12} /> Read only</em></span>
                  <input
                    aria-readonly="true"
                    id={workEmailId}
                    placeholder="Not listed"
                    readOnly
                    type="email"
                    value={profile.workEmail ?? ""}
                  />
                  <small className={styles.helpText}>Ask HR if this work email needs to change.</small>
                </label>
              </section>

              {feedback.tone !== "idle" ? (
                <p className={styles.feedback} data-tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>
                  {feedback.tone === "success" ? <CheckCircle2 aria-hidden="true" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />}
                  {feedback.message}
                </p>
              ) : null}

              <footer className={styles.footer}>
                <button className={styles.cancelButton} disabled={isSaving} onClick={() => closeMenu(true)} type="button">Cancel</button>
                <button className={styles.saveButton} disabled={isSaving || !isDirty} type="submit">
                  {isSaving ? "Saving…" : "Save changes"}
                </button>
              </footer>
            </form>
          </>}
        </section>
      ) : null}
    </div>
  );
}
