"use client";

import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Laptop,
  Mail,
  Search,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { OrganisationPerson } from "@/components/organisation-tree";
import type { EmployeeItAsset, ItAssetType } from "@/lib/it-asset-types";
import styles from "@/components/employee-team-directory.module.css";

const recordsPerPage = 8;
const assetTypeLabels: Record<ItAssetType, string> = {
  laptop: "Laptop",
  desktop: "Desktop computer",
  iphone: "iPhone",
  ipad: "iPad",
  tablet: "Tablet",
  mobile_phone: "Mobile phone",
  monitor: "Monitor",
  keyboard: "Keyboard",
  mouse: "Mouse",
  sim: "SIM / eSIM",
  other: "Other device",
};

type EmailState = { state: "loading" | "ready" | "error"; email?: string | null };
type DeviceState = { state: "idle" | "loading" | "ready" | "error"; assets: EmployeeItAsset[] };

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toLocaleUpperCase();
}

function companyLabel(company: OrganisationPerson["company"]) {
  return company === "mam" ? "MAM" : "Equipsy";
}

function assetDescription(asset: EmployeeItAsset) {
  return [asset.manufacturer, asset.model].filter(Boolean).join(" · ") || assetTypeLabels[asset.assetType];
}

function assetStatusLabel(status: EmployeeItAsset["status"]) {
  if (status === "assigned") return "Assigned";
  if (status === "repair") return "In repair";
  return "Available";
}

/**
 * Employee-safe directory. The parent supplies a team-scoped public list;
 * this component never edits records and only loads devices for the current
 * employee through a no-argument, server-authorised action.
 */
export function EmployeeTeamDirectory({
  people,
  currentPersonId,
  onRequestWorkEmail,
  onLoadMyDevices,
}: {
  people: OrganisationPerson[];
  currentPersonId?: string;
  onRequestWorkEmail?: (personId: string) => Promise<string | null>;
  onLoadMyDevices?: () => Promise<EmployeeItAsset[]>;
}) {
  const [query, setQuery] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [emailState, setEmailState] = useState<Record<string, EmailState>>({});
  const [deviceState, setDeviceState] = useState<DeviceState>({ state: "idle", assets: [] });

  const activePeople = useMemo(
    () => people.filter((person) => person.kind !== "org_unit" && person.isActive !== false),
    [people],
  );
  const personById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const visiblePeople = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return activePeople
      .filter((person) => !term || [person.name, person.position, person.company].join(" ").toLocaleLowerCase().includes(term))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [activePeople, query]);
  const selectedPerson = activePeople.find((person) => person.id === selectedPersonId) ?? null;
  const selectedManagerName = selectedPerson?.reportsTo ? personById.get(selectedPerson.reportsTo)?.name ?? "Not assigned" : "Not assigned";
  const selectedPersonIsSelf = Boolean(selectedPerson && currentPersonId && selectedPerson.id === currentPersonId);

  useEffect(() => {
    if (!selectedPersonIsSelf || !onLoadMyDevices || deviceState.state !== "idle") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setDeviceState({ state: "loading", assets: [] });
      void onLoadMyDevices()
        .then((assets) => { if (!cancelled) setDeviceState({ state: "ready", assets }); })
        .catch(() => { if (!cancelled) setDeviceState({ state: "error", assets: [] }); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [deviceState.state, onLoadMyDevices, selectedPersonIsSelf]);

  const revealWorkEmail = useCallback(async (personId: string) => {
    if (!onRequestWorkEmail || emailState[personId]?.state === "loading") return;
    setEmailState((current) => ({ ...current, [personId]: { state: "loading" } }));
    try {
      const email = await onRequestWorkEmail(personId);
      setEmailState((current) => ({ ...current, [personId]: { state: "ready", email } }));
    } catch {
      setEmailState((current) => ({ ...current, [personId]: { state: "error" } }));
    }
  }, [emailState, onRequestWorkEmail]);

  return <section className={styles.directory} aria-label="Employee directory">
    <header className={styles.header}>
      <div><span>Directory</span><h2>Team directory</h2></div>
      <p>Select a colleague to view their work details.</p>
    </header>

    <div className={styles.directoryDesk}>
      <aside className={styles.directoryList} aria-label="Team employees">
        <div className={styles.listTools}>
          <label className={styles.searchField}>
            <Search size={17} aria-hidden="true" />
            <span className={styles.visuallyHidden}>Search your team</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your team" type="search" />
          </label>
        </div>
        {!visiblePeople.length ? <div className={styles.listState}><UsersRound size={18} aria-hidden="true" /><span>No team employees match that search.</span></div> : <DirectoryRecordList people={visiblePeople} selectedPersonId={selectedPersonId} currentPersonId={currentPersonId} onSelect={setSelectedPersonId} />}
      </aside>

      {selectedPerson ? <EmployeeDetails
        person={selectedPerson}
        managerName={selectedManagerName}
        isSelf={selectedPersonIsSelf}
        emailState={emailState[selectedPerson.id]}
        onRevealWorkEmail={() => void revealWorkEmail(selectedPerson.id)}
        deviceState={deviceState}
        onRetryDevices={() => setDeviceState({ state: "idle", assets: [] })}
        canLoadDevices={Boolean(onLoadMyDevices)}
        onClose={() => setSelectedPersonId(null)}
      /> : <section className={styles.emptyDetail} aria-live="polite"><UsersRound size={28} aria-hidden="true" /><h3>Select a team member</h3><p>Choose a person to view their work details and reporting line.</p></section>}
    </div>
  </section>;
}

function DirectoryRecordList({
  people,
  selectedPersonId,
  currentPersonId,
  onSelect,
}: {
  people: OrganisationPerson[];
  selectedPersonId: string | null;
  currentPersonId?: string;
  onSelect: (personId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(people.length / recordsPerPage));
  const currentPage = Math.min(page, totalPages);
  const paginatedPeople = people.slice((currentPage - 1) * recordsPerPage, currentPage * recordsPerPage);

  return <>
    <div className={styles.records}>{paginatedPeople.map((person) => <button key={person.id} type="button" className={styles.recordRow} data-selected={selectedPersonId === person.id} data-company={person.company} onClick={() => onSelect(person.id)} aria-pressed={selectedPersonId === person.id}>
      <span className={styles.avatar}>{initials(person.name)}</span>
      <span className={styles.recordCopy}><strong>{person.name}</strong><small>{person.position}</small></span>
      <span className={styles.recordMeta}><i data-company={person.company}>{companyLabel(person.company)}</i><em>{person.id === currentPersonId ? "You" : "View"}</em></span>
    </button>)}</div>
    {people.length > recordsPerPage ? <nav className={styles.pagination} aria-label="Team employee list pagination"><span className={styles.pageRange} aria-live="polite">Page {currentPage} of {totalPages}</span><div className={styles.paginationControls}><button type="button" className={styles.paginationButton} onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1} aria-label="Previous page"><ChevronLeft size={15} aria-hidden="true" /></button><span className={styles.pageIndicator} aria-hidden="true">{currentPage} / {totalPages}</span><button type="button" className={styles.paginationButton} onClick={() => setPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages} aria-label="Next page"><ChevronRight size={15} aria-hidden="true" /></button></div></nav> : null}
  </>;
}

function EmployeeDetails({
  person,
  managerName,
  isSelf,
  emailState,
  onRevealWorkEmail,
  deviceState,
  onRetryDevices,
  canLoadDevices,
  onClose,
}: {
  person: OrganisationPerson;
  managerName: string;
  isSelf: boolean;
  emailState?: EmailState;
  onRevealWorkEmail: () => void;
  deviceState: DeviceState;
  onRetryDevices: () => void;
  canLoadDevices: boolean;
  onClose: () => void;
}) {
  return <section className={styles.detail} aria-label={`${person.name} directory details`}>
    <header className={styles.detailHeader}><div><span>Work directory</span><h3>{person.name}</h3><p>{person.position} · {companyLabel(person.company)}</p></div><button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close employee details"><X size={18} aria-hidden="true" /></button></header>
    <div className={styles.detailBody}>
      <div className={styles.detailGrid}><div className={styles.detailItem}><span>Job title</span><strong>{person.position || "Not recorded"}</strong></div><div className={styles.detailItem}><span>Reports to</span><strong>{managerName}</strong></div><div className={styles.detailItem}><span>Company</span><strong>{companyLabel(person.company)}</strong></div></div>

      <section className={styles.contactCard} aria-labelledby={`work-contact-${person.id}`}><div className={styles.cardHeading}><div><span>Contact</span><h4 id={`work-contact-${person.id}`}>Work email</h4></div><Mail size={17} aria-hidden="true" /></div>{emailState?.state === "ready" ? emailState.email ? <a className={styles.emailLink} href={`mailto:${emailState.email}`}><Mail size={15} aria-hidden="true" />{emailState.email}</a> : <p className={styles.mutedValue}>No work email recorded.</p> : <button className={styles.emailButton} type="button" onClick={onRevealWorkEmail} disabled={emailState?.state === "loading"}><Mail size={15} aria-hidden="true" />{emailState?.state === "loading" ? "Loading…" : emailState?.state === "error" ? "Retry work email" : "Show work email"}</button>}</section>

      {isSelf ? <section className={styles.devices} aria-labelledby={`my-devices-${person.id}`}><div className={styles.cardHeading}><div><span>My equipment</span><h4 id={`my-devices-${person.id}`}>Assigned devices</h4></div><Laptop size={18} aria-hidden="true" /></div><p className={styles.cardIntro}>Active devices assigned to your employee record.</p>{!canLoadDevices ? <div className={styles.deviceState}><ShieldCheck size={17} aria-hidden="true" /><span>Device details are unavailable in this preview.</span></div> : null}{canLoadDevices && deviceState.state === "loading" ? <div className={styles.deviceState}><span className={styles.spinner} aria-hidden="true" />Loading your devices…</div> : null}{canLoadDevices && deviceState.state === "error" ? <div className={styles.deviceState} data-error="true"><AlertCircle size={17} aria-hidden="true" /><span>Your devices could not be loaded.</span><button type="button" onClick={onRetryDevices}>Retry</button></div> : null}{canLoadDevices && deviceState.state === "ready" && !deviceState.assets.length ? <div className={styles.deviceState}><Laptop size={17} aria-hidden="true" /><span>No devices are currently assigned to you.</span></div> : null}{canLoadDevices && deviceState.state === "ready" && deviceState.assets.length ? <div className={styles.deviceList} role="list" aria-label={`${person.name}'s assigned devices`}>{deviceState.assets.map((asset) => <article className={styles.deviceCard} key={asset.id} role="listitem"><div className={styles.deviceIcon}><Laptop size={17} aria-hidden="true" /></div><div className={styles.deviceCopy}><strong>{assetTypeLabels[asset.assetType]}</strong><span>{assetDescription(asset)}</span></div><div className={styles.deviceMeta}><span>Asset no.</span><strong>{asset.assetCode}</strong></div><div className={styles.deviceMeta}><span>Serial</span><strong>{asset.serialNumber || "Not recorded"}</strong></div><span className={styles.deviceStatus} data-status={asset.status}>{assetStatusLabel(asset.status)}</span></article>)}</div> : null}</section> : <div className={styles.accessNote}><ShieldCheck size={17} aria-hidden="true" /><span>Device details are shown only for your own assigned equipment.</span></div>}
    </div>
  </section>;
}
