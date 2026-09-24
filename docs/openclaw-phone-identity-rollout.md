# Verified OpenClaw phone identities

S01 is installed by migration
`20260922230000_openclaw_verified_phone_identity.sql`. Its production migration
record matches the reviewed file hash. The migration deliberately adds no phone
mappings; live entries can only be created through the authenticated
SystemAdmin RPC below. Directory contact fields never authorize WhatsApp access.

## Enrollment is a release prerequisite

The migration deliberately creates **no mappings**. Directory contact numbers
are self-editable, and historic documentation asking HR to verify ownership is
not evidence that verification happened. Authorized HR must independently confirm
each employee's ownership/control of their WhatsApp number, retain evidence in
the approved confidential record system, and approve the exact person/account/
canonical-number assignment. A phone contact edit, OTP pasted into chat, or
user-editable metadata is not an enrollment path.

An active SystemAdmin performs the approved assignment through the authenticated
RPC below. Ordinary HR/contact editing privileges are insufficient; HR without
SystemAdmin authority hands the independently verified assignment to an existing
authorized SystemAdmin. Do not grant a new broad role simply to enroll a number.
The RPC records the actual authenticated actor, linked portal user, old/new
number and revision, evidence reference and time in a private append-only audit
table. No caller can supply the actor or directly edit the registry/audit tables.
Service-role clients may read integration snapshots but cannot enroll identities.

## Operator workflow

Use an existing authenticated People System SystemAdmin session, with its current
non-anonymous session and controlled database role. Do not mint JWT claims,
reuse a service key in a browser, or use user metadata to obtain this role.
The following calls are API examples, not a script to run against production.
All values shown are synthetic.

1. Independently verify ownership, exact employee and active linked account.
   Convert the approved number to canonical E.164 and validate its numbering
   plan. The database rejects local formatting, extensions and multiple numbers;
   it never guesses a country. Record an opaque evidence reference, 3–200 ASCII
   letters/digits or `:._/-`; keep evidence content, codes and HR notes out of it.
2. Call `get_openclaw_phone_identity(p_person_id)` and inspect the current record.
   `null` means no previous enrollment; a revoked record has `phone: null` and a
   revision. Never treat a revoked record as first enrollment.
3. Call `set_openclaw_phone_identity` with the exact observed revision, approved
   number and evidence reference. The transaction rechecks SystemAdmin access,
   active MAM scope and account linkage under the bridge locks, enforces number
   uniqueness, writes the audit and returns the new revision.

```ts
const personId = "10000000-0000-4000-8000-000000000001"; // synthetic
const current = await authenticatedClient.rpc("get_openclaw_phone_identity", {
  p_person_id: personId,
});
if (current.error) throw current.error;
const enrolled = await authenticatedClient.rpc("set_openclaw_phone_identity", {
  p_person_id: personId,
  p_expected_revision: current.data?.revision ?? null,
  p_phone_e164: "+61400000001", // independently verified synthetic example
  p_evidence_ref: "synthetic:ownership-check-001",
});
if (enrolled.error) throw enrolled.error;
```

To revoke, read the current revision and call the same setter with
`p_phone_e164: null` and a reference to the revocation decision. Revocation works
after archive, account disable or company removal. The row and its new revision
remain, while its number is released for a separately verified assignment.
Re-enrollment (even of the same number) always creates a new revision. To transfer
a number, first revoke its old assignment, then independently approve/enroll the
new assignment; the unique constraint rejects implicit reassignment.

`40001` means the record changed: reload and review the new state before deciding
whether to retry. Never blindly retry with a fresh revision. `23505` means a
number is already assigned; resolve its ownership through the controlled process.
`42501` means the operator or enrollment target is ineligible. Invalid formatting,
missing evidence or revoking an already revoked identity returns `22023`.
Failed operations roll back both the identity and audit write. Audit records in
`private.openclaw_phone_identity_events` remain available to separately authorized
database audit operations; neither employees nor the integration receive them.

## Atomic identity and protocol compatibility

Allowlist v1/v2, legacy leave snapshot, current v3 snapshot and self-profile
snapshot all derive from the verified registry. Self-profile reads are one
statement-consistent snapshot of registry, person, linked account and profile.
They provide no authorization for subsequent writes, which revalidate separately.
An already returned read response cannot be recalled by later revocation.

Enrollment/revocation takes advisory locks in the existing order: hierarchy,
leave grants, OpenClaw bridge. Submission uses the same locks and compares the
fresh source fingerprint before reading any successful receipt/nonce result.
The DB also checks canonical sender equals the selected employee's enrolled
number, and the sealed `phoneIdentityVersion` equals the current enrollment
revision. Revocation/re-enrollment therefore invalidates prepared tokens and
successful-receipt replays, even when the same person gets the same number again.
A confirmation committed before a revocation remains an existing leave request;
revocation does not cancel previously submitted leave or erase its audit.

The external allowlist response and v3 request/response envelopes are unchanged.
The opaque v3 draft token now contains the enrollment revision. Old v3 tokens
without it fail closed and require a new preparation. The already retired v1/v2
HTTP protocol also has its database commit path retired; old drafts cannot bypass
verification by calling a legacy RPC. Read-only snapshot envelopes remain usable.

## Release invariants

For a new installation or key rotation, verify the exact MAM production targets
and migration history before applying anything. Use the reviewed forward
migration and GitHub deployment flow; never install historical contact-based
allowlist SQL over the verified registry. Keep inbound access denied while
deployments are mixed or the synchronizer is stale. Enroll only independently
verified assignments through the SystemAdmin RPC above. The allowlist snapshot
must be complete and authoritative: an empty snapshot means deny all. Never
send real test messages or create real leave requests as a release smoke test.
Bridge writes recheck live identity even when the allowlist cache is fresh.
Pending confirmations must be restarted after a deployment; old tokens cannot
be migrated to verified identities.

Do not roll back to contact-based identity resolution or populate the registry
from the directory to restore access. A failed rollout stays disabled until a
forward fix and verified enrollment are approved. Hosted advisors, PostgREST,
full production migration chain and VPS behavior remain release checks; local
synthetic tests do not establish those outcomes.
