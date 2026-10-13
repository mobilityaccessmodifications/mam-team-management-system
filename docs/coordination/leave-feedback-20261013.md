# Leave feedback — 13 October 2026

## Confirmed scope and authority

The user confirmed both decisions through the consolidated clarification form on
13 October 2026 (Australia/Melbourne):

- “确认，测试和审查通过后发布生产”. Implementation, tests, independent review,
  reviewed production database/workflow changes and GitHub-to-Vercel production
  release are authorised for this scope. No separate request to continue is needed.
- “保留，顺延到下一个工作日上午10点”. The certificate deadline is 10:00 am
  Australia/Melbourne on the Monday strictly after the final leave date, moving to
  the next Victorian business day when that Monday is a public holiday.

The user's later correction, “这个disclaimer你就写在邮件里面就行了，不用改系统”,
limits this certificate policy to email wording only. Do not change the system's
deadline calculation, overdue checks, evidence notices, reminders or payroll
behaviour. The required-note and default-open form changes remain authorised.

The scope is aligned and approved, not awaiting confirmation.

## Latest email scope — supersedes the broader email work below

The user explicitly narrowed the email request to “邮件模版就改n8n就行了啊，
就加一段话而已” and authorised one manual preview. The confirmed preview address is
`marketing@mobilityaccess.com.au`, with no CC/BCC. Release the email-only paragraph
independently of the form/backend work. Keep the current live template, routing,
credentials, provider expression and durable receipts unchanged apart from the
small grey Sick/Carer's policy paragraph. No new employee-note rows, certificate
state fields, metadata RPCs, application changes or database changes for email.
Earlier outcome items 3/4, metadata acceptance and the service getter handoff are
withdrawn from this release; retained drafts and tests are historical only.
The original required-note/default-open form requirement remains authorised.
The one synthetic Marketing preview supersedes the earlier no-test-mail exclusion
only for this exact mailbox and one preview, with no real employee data.

The parent's application-mail source and its existing tests are restored exactly
to the base Git blobs. The two withdrawn metadata helper/test drafts are archived
with hashes under `mam-leave-feedback-evidence-20261013/withdrawn-email-metadata`.
Only the original four form/browser files remain modified in that candidate.

The n8n-only candidate is one added HTML paragraph; removing that line reproduces
the current live Code SHA exactly. Its focused checks passed (5 Node tests,
including 8 Python publisher tests). The publisher's native read-only inspect
passed with zero entered writes and an exact saved/published/project/preserved-body
match. Independent review `sa-0-9ef0d370` is pending. Publish and the single preview
remain NOT SENT/NOT APPLIED; do not report completion from this checkpoint.
Gateway `/me` checks verified AI sender and Marketing reader through the dedicated
MAM Keychain wrapper. The actual published renderer/provider expression must be
used for the preview; no production leave webhook or employee queue is invoked.

The first independent review is FAILED for publication (preserve its verdict),
although the paragraph itself passed. S1: the publisher authenticated its verifier
before checking the exact origin pin. L1: its mutation-receipt shape needed native
contract evidence. No production write/send was attempted. Fix owner
`sa-0-21a0b98d` owns only the bounded repair in
`/Volumes/UG/MAM/opencode/mam-leave-feedback-publisher-fix-20261013`.
Parent independently verified the approved SSH host matches configured n8n DNS,
the remote user is codex, the discovered container is n8n-n8n-1 and the installed
version is 2.32.6. Exact installed public handler/service/finder source is retained
with hashes in `email-only/runtime-public-source/manifest.json`; no private rows,
environment or credentials were fetched. The sender's inert harness passed,
including no external requests, one synthetic POST, read-only verification and
duplicate-send rejection. None of this is provider/inbox delivery evidence.

The original backend-note owner returned INTERRUPTED with no summary. Its owned
worktree and 21 changed/new paths remain preserved; no release is credited from
that partial result. Recover its existing source/evidence rather than restarting
or discarding it, after the independent email-only priority is delivered.
The email owner returned its final disclaimer-only result and retained RED plus
37/37 Node GREEN (including 8 Python publisher methods). Its five source hashes
match the inspected/reviewed original candidate. The FAILED publication review is
still authoritative; that earlier owner's test pass is not permission to publish
the rejected helper. The bounded fix and follow-up review remain separate gates.

## Required outcomes

1. Require a nonblank employee note for every new leave application, including
   self-service and authorised on-behalf/selected-profile application paths. Reject
   missing, empty and whitespace-only notes. Retain the existing 2,000-character
   limit, input safety, authentication and authorisation. Do not invent notes for
   existing requests or change historical-import provenance.
2. Open the existing **Note & files** section by default. Users may still collapse
   it. Keep supporting files optional at initial submission and allow later upload.
3. Show the employee note in eligible employee/reviewer/HR leave emails while
   preserving existing private-note exclusions for payroll/account copies. Escape
   dynamic body values and preserve recipient routing, sender, CC/BCC and no-resend
   protection. A legacy missing note must not suppress an authorised historical
   request's later decision/cancellation email or be replaced with invented text.
4. For Sick leave and Carer's leave, show **Certificate attached:** `Yes` or
   `Not yet – certificate to be uploaded`, using confirmed persisted supporting
   evidence. A selected file, pending upload or failed upload is not evidence of a
   successful attachment. No certificate bytes are added to email attachments.
5. Add small grey English policy text to Sick/Carer's leave emails: certificates
   must be uploaded by the deadline above; unpaid will be processed if missing,
   unless annual leave is formally requested in People Hub. Preserve the existing
   public-holiday exception in the wording. Do not add automatic leave-type,
   approval, balance or payroll mutations.

## Excluded effects

- No historical email replay or test emails to real employees.
- No edits to real employee notes, requests, evidence, pay or balances.
- No change to approval authority, category eligibility or recipient routing.
- No broader UI redesign, unrelated refactor or other release integration.

## Acceptance

- Positive and negative synthetic form/Server Action/database tests cover the new
  required-note boundary and existing authorisation, idempotent retry and legacy
  workflow compatibility.
- The real request component defaults to an open extras section and rejects
  whitespace-only notes, including direct form dispatch.
- Email tests exercise both relevant leave types, both attachment states, newline
  and HTML escaping, eligible audiences, private-note exclusions, nonapplicable
  categories, legacy null notes and unchanged event/routing/no-resend behaviour.
- Certificate status reflects the server-confirmed evidence when the email is
  prepared, not a file selected in the browser. Test successful, pending and failed
  uploads separately. Preserve the existing submission/upload workflow, partial
  commit/retry safety and no-resend keys; do not add a new upload or resend process.
- Required project lint/type/unit/build, affected SQL/browser/bundle gates and
  independent source-bound review pass before release.
- Verify exact MAM Supabase target and migration readback, n8n saved/published
  definition/version readback, reviewed GitHub merge and matching Vercel production
  READY/fixed alias. Keep deployed-source evidence separate from actual employee
  login and inbox delivery; real-recipient tests are excluded by scope.

## Ownership and starting evidence

- Coordinator: this Hermes MAM conversation. Owns integration, target checks,
  approval boundary, final production changes and readbacks.
- Email discovery: read-only subagent `sa-0-f6db2056`; its findings are not release
  evidence and do not grant implementation authority.
- Candidate worktree: `/Volumes/UG/MAM/opencode/mam-leave-notes-feedback-20261013`.
- Branch: `codex/leave-notes-feedback-20261013`.
- Initial base: `de5bf28526bb676289392b50b010ece9f4b63d7a` (fresh origin/main,
  includes the separately released annual continuous-accrual change).
- Existing main checkout and its unrelated untracked files remain untouched.
- MAM n8n prescribed `python3 scripts/verify.py` completed successfully from its
  approved root. No workflow write or test send has occurred.

## Current implementation handoff

- Parent owns the real request-form change, browser fixtures, email-content
  metadata adapter, outbox and reminder-route integration. Default-open, required
  notes, whitespace rejection, the existing length limit and collapsed-invalid
  field focus are implemented locally. Focused form Node tests passed (30 tests);
  real Chromium form tests passed (8 tests, phone/desktop). These are synthetic
  component checks, not employee authentication or production acceptance.
- Parent's certificate metadata/outbox checks passed (25 Node tests). Evidence is
  under `/Volumes/UG/MAM/opencode/mam-leave-feedback-evidence-20261013`, including
  retained RED/GREEN logs and real command-exit sidecars. The service-only getter
  still depends on the database owner's native implementation/readback.
- Backend owner `sa-0-06a8a78b` works only in
  `/Volumes/UG/MAM/opencode/mam-leave-required-note-database-20261013` and owns
  action/assistant note validation, the forward migration, native regressions and
  guarded database release helper. Its same migration supplies the read-only,
  service-role-only `get_leave_notification_details(p_request_id uuid)` contract.
- Email owner `sa-1-d59ad913` works only in
  `/Volumes/UG/MAM/opencode/mam-leave-feedback-email-20261013` and owns the actual
  live-source renderer delta, email tests and inert-tested code-only publisher.
  Neither child may publish, commit, send mail or change production.
- Form/backend integration and their production release remain pending. No database
  migration or GitHub/Vercel application release is credited.

## Verified email-only delivery — 13 October 2026

- Fresh independent S1/L1 review PASS: `email-only/fixed-independent-review.json`,
  SHA `98ac672436daa8d71117962572906c0ca4266549d57d4bbece3a5bcadeebe7a0`.
  Historical FAIL remains preserved. Seven reviewed source bindings match exactly.
- Workflow `D6UG5ACZGILCpsOk` is active. Saved and published version both read back
  as `9e6247ad-af9c-44e0-9de1-83db95dc7d0c`. Only the grey certificate-policy
  paragraph changed; non-Code preserved body SHA remains
  `030564b7824b834d1b82c24c21f164833abaad893549ad2a2d4d2c20329278d9`.
- One synthetic preview was rendered from freshly read published Code and the
  unchanged provider expression, without a production webhook or employee queue.
  Sent from `ai@mobilityaccess.com.au` to `marketing@mobilityaccess.com.au` only,
  no CC/BCC or attachments. Subject: `[PREVIEW] MAM leave notification — cbf2ab3b`.
- Provider returned 202. Exact sent-item and Marketing inbox readbacks verified
  sender, sole recipient, grey 12px policy, original signature and no attachments.
  Their normalized body hashes match. Plan, exclusive send intent, provider receipt
  and message readback remain in `mam-leave-feedback-evidence-20261013/email-only`.
  No resend is authorised by this success; earlier NOT APPLIED/NOT SENT checkpoints
  are historical. Required-note/default-open UI/backend remains NOT RELEASED.

## Required-note production candidate — final verification checkpoint

- The user renewed same-scope production authority: “改动好的就上线”. No email
  resend, system certificate-deadline change or staff-record mutation is authorised.
- UI/backend integration includes only required new-request notes, default-open
  Note & files, safe rejection mapping, assistant missing-note handling and tests.
  Existing blank requests, retained receipts and historical imports stay compatible.
- Full application check passed: lint, typecheck, 1262/1262 Node tests and production
  build. Chromium composed gate passed 144 unique cases; its 24 primary skips are
  exactly the 24 passing dedicated contact cases, with zero unexecuted cases.
  Bundle gate passed. Failed earlier runs remain preserved as historical evidence.
- Full native SQL gate passed all 179 byte-exact ordered migrations, nine note
  transaction/rollback cases and every remaining declared native regression.
  Five obsolete positive SQL fixtures now supply synthetic notes; assertions,
  SQLSTATEs, dates, accounting, security and old/import blanks remain unchanged.
- Release helper now pins the already-applied annual-continuous-accrual predecessor
  20261013120000. Only its two predecessor literals changed. Six Python methods
  and nine native PG16 transaction cases passed; core migration bytes unchanged.
  Hosted PG17 project, exact predecessor source and note pre-image were verified
  read-only; prepare produced an immutable predecessor snapshot.
- Candidate evidence is in `mam-leave-feedback-evidence-20261013/note-release`.
  Independent final review, clean committed source, new-head CI, reviewed database
  apply/readback, GitHub merge and matching production READY are still pending.
- Ego task space 75/page p1 is the owned read-only production smoke-test page at
  the fixed MAM alias. No request or employee record was submitted or changed.
