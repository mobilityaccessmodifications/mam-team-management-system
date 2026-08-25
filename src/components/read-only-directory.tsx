"use client";

import { Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";

import type { OrganisationPerson } from "@/components/organisation-tree";
import styles from "@/components/read-only-directory.module.css";

/**
 * A deliberately narrow directory for managers. It uses the existing public
 * organisation projection only: name, role, company and reporting line. HR
 * contact, employment and lifecycle fields stay in EmployeeDirectory.
 */
export function ReadOnlyDirectory({ people }: { people: OrganisationPerson[] }) {
  const [query, setQuery] = useState("");
  const visiblePeople = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return people
      .filter((person) => person.kind !== "org_unit" && person.isActive !== false)
      .filter((person) => !term || [person.name, person.position, person.company].join(" ").toLocaleLowerCase().includes(term))
      .sort((first, second) => first.name.localeCompare(second.name));
  }, [people, query]);

  return <section className={styles.directory} aria-label="Employee directory">
    <header className={styles.header}>
      <div>
        <span>Directory</span>
        <h2>Employees</h2>
      </div>
      <label className={styles.search}>
        <Search aria-hidden="true" size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or role"
          aria-label="Search employees"
        />
      </label>
    </header>

    {!visiblePeople.length ? <div className={styles.empty}><UsersRound size={24} /><strong>No employees match that search.</strong></div> : <ul className={styles.list}>
      {visiblePeople.map((person) => <li key={person.id}>
        <span className={styles.avatar}>{person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
        <span className={styles.person}>
          <strong>{person.name}</strong>
          <small>{person.position}</small>
        </span>
        <span className={`${styles.company} ${person.company === "equipsy" ? styles.equipsy : ""}`}>{person.company === "equipsy" ? "Equipsy" : "MAM"}</span>
      </li>)}
    </ul>}
  </section>;
}
