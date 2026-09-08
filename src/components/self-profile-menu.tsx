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
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "@/components/self-profile-menu.module.css";
import { useDialogFocus } from "@/components/ui/use-dialog-focus";
import { ModalBackdrop } from "@/components/ui/modal-backdrop";

/**
 * A profile DTO already authorised for the current viewer. The caller must
 * not substitute organisation-tree data for private contact fields.
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

/**
 * `hr-preview` is used only after an HR-authorised selected-employee fetch.
 * It makes the context explicit without changing the data the menu can show.
 */
export type SelfProfileMenuMode = "self" | "hr-preview";

export type SelfProfileMenuProps = {
  /** An authorised profile DTO for the person named in the trigger. */
  profile: SelfProfileData;
  /**
   * Persist only the editable contact fields. The caller must still check the
   * signed-in identity or HR capability and authorise the update on the server.
   */
  onSave: (changes: SelfProfileChanges) => Promise<SelfProfileSaveResult>;
  /** Use while the profile record is initially loading. */
  disabled?: boolean;
  /** Distinguishes an employee's self-service card from an HR-selected card. */
  mode?: SelfProfileMenuMode;
  /** Included in HR context copy only; it must be the authenticated HR viewer. */
  viewerName?: string;
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
  mode = "self",
  viewerName,
}: SelfProfileMenuProps) {
  const panelId = useId();
  const titleId = useId();
  const personalEmailId = useId();
  const phoneId = useId();
  const birthDateId = useId();
  const workEmailId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const profileKey = [
    mode,
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
  const [anchor, setAnchor] = useState({ top: 72, right: 16 });
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(idleFeedback);
  const savedValues = savedLocally?.profileKey === profileKey ? savedLocally.values : profileValues;
  const draft = draftState.profileKey === profileKey ? draftState.values : profileValues;
  const displayName = profile.name.trim() || "My profile";
  const displayTitle = profile.title.trim() || "Team member";
  const organisation = companyName(profile.company);
  const today = new Date().toISOString().slice(0, 10);
  const isHrPreview = mode === "hr-preview";
  const canEditProfile = !disabled;
  const contactHeading = isHrPreview ? "Contact details" : "My contact details";
  const saveDefaultMessage = isHrPreview
    ? "Employee profile changes are saved."
    : "Your profile changes are saved.";

  const closeMenu = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setDraftState({ profileKey, values: savedValues });
    setFeedback(idleFeedback);

    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [profileKey, savedValues]);

  useDialogFocus(isOpen, panelRef, canEditProfile ? firstInputRef : null, () => closeMenu(true));

  useEffect(() => {
    if (!isOpen) return;

    const updateAnchor = () => {
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (bounds) setAnchor({ top: bounds.bottom + 9, right: Math.max(14, window.innerWidth - bounds.right) });
    };
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [isOpen]);

  const isDirty = draft.personalEmail !== savedValues.personalEmail
    || draft.phone !== savedValues.phone
    || draft.dateOfBirth !== savedValues.dateOfBirth;

  function openMenu() {
    if (!canEditProfile) return;
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (bounds) setAnchor({ top: bounds.bottom + 9, right: Math.max(14, window.innerWidth - bounds.right) });
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
    if (!canEditProfile || isSaving) return;
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
      setFeedback({ tone: "success", message: result?.message ?? saveDefaultMessage });
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
    >
      <button
        aria-controls={panelId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`Open ${displayName}'s profile`}
        className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ""}`}
        disabled={!canEditProfile}
        onClick={() => isOpen ? closeMenu() : openMenu()}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.avatar} aria-hidden="true">{initialsFor(displayName)}</span>
        <span className={styles.triggerCopy}>
          <strong>{displayName}</strong>
          <small>{displayTitle}</small>
        </span>
        <ChevronDown className={styles.chevron} aria-hidden="true" size={16} />
      </button>

        {isOpen ? (
          <ModalBackdrop
            className={styles.profileOverlay}
            data-company={profile.company.toLowerCase()}
            style={{ "--profile-top": `${anchor.top}px`, "--profile-right": `${anchor.right}px` } as CSSProperties}
            onPointerDown={(event) => event.target === event.currentTarget && closeMenu(true)}
          >
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className={styles.panel}
            id={panelId}
            ref={panelRef}
            role="dialog"
            tabIndex={-1}
          >
          <header className={styles.panelHeader}>
            <div className={styles.profileHeading}>
              <span className={styles.avatarLarge} aria-hidden="true">{initialsFor(displayName)}</span>
              <span>
                <strong id={titleId}>{displayName}</strong>
                <small>{displayTitle}</small>
              </span>
            </div>
            <button className={styles.closeButton} type="button" onClick={() => closeMenu(true)} aria-label="Close profile">
              <X aria-hidden="true" size={18} />
            </button>
          </header>

          {!canEditProfile ? <p className={styles.profilePending} role="status">This profile is loading.</p> : <>
            {isHrPreview ? <div className={styles.hrPreviewContext} role="status">
              <Eye aria-hidden="true" size={15} />
              <span><strong>HR selected view</strong><small>{viewerName ? `Signed in as ${viewerName}` : "Authorised HR access"}</small></span>
            </div> : null}
            <div className={styles.organisationSummary} aria-label="Your organisation details">
              <span><Building2 aria-hidden="true" size={15} /><b>Company</b><strong>{organisation || "Not listed"}</strong></span>
              <span><BriefcaseBusiness aria-hidden="true" size={15} /><b>Team</b><strong>{profile.team?.trim() || "Not listed"}</strong></span>
              <span><UserRound aria-hidden="true" size={15} /><b>Manager</b><strong>{profile.manager?.trim() || "Not assigned"}</strong></span>
            </div>

            <form className={styles.form} onSubmit={save}>
              <section className={styles.section} aria-labelledby={`${panelId}-contact`}>
                <div className={styles.sectionHeading}>
                  <CircleUserRound aria-hidden="true" size={17} />
                  <span><strong id={`${panelId}-contact`}>{contactHeading}</strong></span>
                </div>

                <label className={styles.field} htmlFor={personalEmailId}>
                  <span><Mail aria-hidden="true" size={15} /> Personal email</span>
                  <input
                    autoComplete={isHrPreview ? "off" : "email"}
                    id={personalEmailId}
                    onChange={(event) => updateDraft("personalEmail", event.target.value)}
                    placeholder="you@example.com"
                    ref={firstInputRef}
                    type="email"
                    value={draft.personalEmail}
                  />
                  <small className={styles.helpText}>Does not change your sign-in.</small>
                </label>
                <label className={styles.field} htmlFor={phoneId}>
                  <span><Phone aria-hidden="true" size={15} /> Phone</span>
                  <input
                    autoComplete={isHrPreview ? "off" : "tel"}
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
                    autoComplete={isHrPreview ? "off" : "bday"}
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
                  <span><strong id={`${panelId}-work`}>Work contact</strong></span>
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
          </ModalBackdrop>
        ) : null}
    </div>
  );
}
