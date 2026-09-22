# Reviewed receiver definition fixture

Captured through the approved MAM n8n REST route on 2026-09-22 from receiver
`D6UG5ACZGILCpsOk`, version `07108502-d6a3-4396-b68d-5b9abe0a5d4e`.
Every complete node, connection and setting matched the release helper's fixed
`BASELINE` hashes before export. Tests use those fixed pins, never self-derived
replacement pins, then execute the helper-generated graph and exact Code sources.

The fixture retains workflow code/configuration and opaque credential references
(`id` and `name` only). It contains no secret credential values, actual employees,
leave payloads, executions, pinned data, ownership metadata or legacy receipts.
Activation fields are deliberately inactive and static receipt state is empty.
Tests never connect to n8n or use the credential references: HTTP/Outlook I/O is
synthetic. The pre-patch Code strings are hash evidence, not executed sender code.

Native HTTP Request parameter nesting is asserted independently against the
`HttpRequest/V3/Description.ts` schema from installed production n8n 2.32.6
(node typeVersion 4.2). Native credential connectivity still requires the separate
GET-only production probe; offline tests do not establish provider delivery.
