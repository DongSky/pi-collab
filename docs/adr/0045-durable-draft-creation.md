# ADR-045: Explicit durable draft creation and a shared GitHub head reservation

Status: implemented in migration 031, the native Git service and browser; validation and local deployment evidence is recorded in the implementation status. This adds actual draft creation, not CI, full diff revisions, review or protected merging.

## Explicit authority

A ready proposal is immutable preparation, not a send instruction. A separate action confirms its exact request hash and observation hash, complete title/body/repository, notification effect and the absence of an atomic remote head/base condition. The browser displays the full generated request content next to these acknowledgements. A checked box records the member's statement; it does not prove comprehension.

SQL derives all source identities from the saved proposal. It checks both the proposal author's original grant and the dispatcher's current task authority, authorization versions, task version and installation/binding versions. An old grant cannot be revived by removing and adding a member. Current task Developers or Maintainers follow the existing organization MFA policy; retiring an unknown operation requires a current organization Owner/Admin who is also a project Maintainer with MFA.

Each proposal admits one creation attempt. Its proposal ID becomes the operation ID already embedded in the saved body. Admission and exact-payload idempotency precede credentials. Reload retries the same actor/request key; another key or actor cannot turn the same proposal into another attempt. There are at most 20 queued/running creations per project.

## Shared head ownership

The new private head reservation table uses GitHub's stable repository ID plus the full task head ref, independently of local project or installation IDs. It contains either a push confirmation or a PR creation owner. Known terminal operations release their reservation; unknown and retired operations retain it. Preparing a proposal does not reserve a head.

Migration 031 takes a write-conflicting lock on the old push confirmation table, copies every reserved/quarantined push destination, and installs a trigger in the same transaction. Existing push procedures, including older running services, therefore participate in the same reservation. A PR cannot race an already admitted push, and an old push confirmation cannot bypass a PR reservation. The UI exposes occupied/not occupied without disclosing another project's owner.

Reservation ownership only coordinates platform operations. It cannot prevent GitHub users or other integrations from moving refs. Creating a PR still has no expected-head/base SHA parameter. Fresh preflight and post-create observations bound what was seen, not future branch state.

## At most one POST

One SQL connection, backend PID, advisory lock and unguessable nonce own a job. The service rebuilds the saved request and compares its complete structure and exact serialized bytes before opening the App key. It requests a single-repository token with contents read and PR write, never code write or merge permission.

While reading, authority checks run every 500 ms and a silent SQL response is bounded locally at two seconds. The provider rechecks installation, identity, visibility, exact head/base and existing PRs. Existing PRs remain observations; a matching title, marker or branch does not adopt them.

Immediately before the provider POST, SQL locks the current authority rows, checks the exact prepared request and fresh provider evidence, and durably records the one send gate. The service must receive the gate COMMIT acknowledgement before returning permission to the provider client. A lost COMMIT reply discards the connection and never authorizes a POST.

After the gate, cancellation or grant changes cannot promise that creation is undone. A valid result is recorded even if current authority has since changed. Losing the SQL owner before a gate permits a terminal not-created classification; losing it after a gate leaves unknown, even when the client probably never sent. A later worker only classifies the durable record and cannot replay it.

## Results and initial ChangeRequest records

States are queued, running, created, rejected, not_created, unknown and retired. Documented create denials are distinct from an ambiguous response. Credential issuance/cleanup is recorded independently; failed cleanup or a failed follow-up read cannot overwrite positively acknowledged creation.

SQL checks the result structure, exact gate evidence, identities, scope, snapshot types, version/hash claims and observation times. The exact result text and its SHA-256 are preserved. It independently checks that a claimed matching revision agrees with both the saved request and both observations.

Acknowledged creation registers an attributed ChangeRequest identity and immutable creation/follow-up observations. These preserve source/target SHA, exact evidence text and hash. Unknown results and pre-existing PRs cannot enter this table. Stable repository/PR identity uniqueness prevents one external PR from silently representing two operations.

These initial records are not the full ChangeRequestRevision model: complete Git diff hashing, subsequent durable reads/webhooks, trusted CI producers, review invalidation and protected merge decisions remain required. The UI labels all versions as observations and offers no review/merge action. A matching observation never claims that the remote is still unchanged.

## Unknown outcomes

No automatic retry, absence check, body marker, cancellation, token revocation or expiry can settle an unknown create. A request may still complete remotely after all of these observations. An authorized administrator can explicitly retire its record, retaining permanent head quarantine. Further work uses a new workspace and generated branch. Retirement neither closes nor adopts any remote PR.

Browser pending requests survive reload and use the original exact payload. Readers can inspect shared history; mutations require current scoped authority and same origin. Preparation, creation, cancellation and retirement remain separate visible actions.

## Verification and deployment

Tests use generated App credentials, actual native Pi/Git/PostgreSQL and real loopback HTTP/TCP transports. They exercise concurrent push/PR admission, raw evidence, roles/MFA, stale versions, drift, rejection, missing cleanup, forged gates/receipts, genuine dropped COMMIT replies, owner loss, silent SQL, actual broker SIGKILL and delayed creation after revocation. A transactional reconstruction of the preceding schema verifies backfill of real reserved/quarantined push records.

Browser acceptance covers explicit content/notification/version acknowledgement, actual lost response and reload retry, two-member history, cancellation, existing PR refusal, unknown retirement, persistent occupancy, roles/CSRF and desktop/mobile layouts. The fixture supplies explicit remote states; absent listings in later scenarios model external closure, not platform editing. It does not send external notifications or prove real GitHub account acceptance.

Apply migration 031 before gracefully replacing the single Git service. Seven processors share the existing two lanes. Migration 031 has been applied to the local main installation and all 31 source hashes verified; migrations 001–031 are now immutable. Final native collaboration tests passed 465/465, the complete isolated browser regression passed, and the upgraded main instance passed the four-account smoke. Native remains the default and has no Docker dependency. Docker parity, real Provider acceptance and the remaining delivery pipeline are separate gates.
