# ADR-041: Durable human confirmation and unsent destination ownership

Status: implemented for native export confirmation. This is not a remote send job; production dispatch remains separate work.

Update: [ADR-042](0042-durable-task-push-delivery.md) now supplies the separate explicit delivery request and final gate. Migration 029 replaces withdrawal for delivery-owned confirmations and extends reservations through unknown/quarantined outcomes. The following describes the original migration 028 increment and its evidence.

## Complete, explicit human attestation

Migration 028 records a human confirmation against migration 027's immutable preview. The request binds the authoritative manifest and observation hashes, the complete repository identity/visibility/binding, generated task ref, expected-old SHA, new SHA and authenticated default baseline. It includes every outgoing commit's object SHA, exact-byte SHA-256 and changed-path count, sorted by commit SHA. SQL independently derives this entire scope from the saved preview and compares it for exact equality. Missing, duplicate, substituted or extra commit statements, altered destination data and absent disclosure acknowledgements are refused.

The browser requires the complete commit list, an explicit file-version mark for every changed path in each version, access to full commit metadata (display or raw download), and a separate acknowledgement for every commit's metadata, parents and files. Empty changes still require the commit acknowledgement. Non-text, large, redacted or excluded sides require a separate acknowledgement of external byte review and the precise unreadable/deletion/exclusion limits. The final form separately confirms the destination and disclosure of the complete history, including intermediate versions. Local file/commit marks still clear on reload; only submitting the final request creates a durable record.

This is a **member's attestation**, not evidence that software can prove a person read or understood bytes. An authorized API user can make the same explicit statement without using the browser. SQL ensures it describes the exact full export; the browser prevents accidental omission. Secret-pattern detection and unreadable inherited content retain ADR-040's limits. Confirmation never asserts that redacted bytes were displayed, that checks passed or that a branch is mergeable.

New application requests reopen and verify the original export using the SQL hash and compare every commit statement. They do not reconstruct missing files or inspect a caller-supplied path. Idempotent retries are resolved before filesystem work: a previously committed confirmation can still be returned if artifacts later disappear, without issuing provider credentials. A later send must independently reverify the artifacts; returning an old confirmation is not evidence that they still exist.

## Current authority and stable destination ownership

Only the current task-owning Developer or a Maintainer may confirm, with the existing organizational MFA rule. The confirming person may differ from the preview producer. Admission captures the confirmer's current organization/project authorization versions and checks the preview's frozen task/run/installation/binding versions under the existing organization serialization lock and relevant row locks. Project readers may see records but cannot create or withdraw them. Cross-project/organization lookup returns not found. Web/other service roles cannot directly mutate the private confirmation tables.

The destination reservation is unique on GitHub's stable repository ID plus the exact ref, across installations, local repositories, previews, members and organizations. The scope is currently `github.com`; another provider/host must extend the identity before it can use this table. Per-target serialization and a partial unique index prevent two active owners, including different ready previews from the same workspace. A project may hold at most 20 reservations.

Confirmation covers the fixed export, so subsequent workspace changes do not change its bytes or quietly become disclosed. Permission revocation/regrant, task ownership/version changes, installation changes and repository-binding revisions invalidate the stored authority. They do not silently release or renew its reservation. The public `valid` flag describes current **local** versions and permissions, not a fresh remote ref/protection observation. Remote identity, rules, SHA and token scope must be checked again for actual dispatch.

## Unsent withdrawal and retries

States in this increment are `reserved` and `withdrawn`. The current task controller can explicitly withdraw an unsent reservation with a reason. Withdrawal and confirmation have actor-scoped UUID idempotency keys and exact payload equality, with append-only audit events. A retried original confirmation returns its original ID/status; it never reacquires a withdrawn target or adopts new authorization versions. Reusing a key for a different payload is rejected. Historical records remain after withdrawal. The UI keeps these records and withdrawal controls accessible even when outgoing-history artifacts cannot be opened.

The browser writes the original request and key to session storage before sending and restores them after reload. Unknown responses expose same-request retry, including after the local review marks have cleared. Two browsers observe the same durable record and target occupancy. The confirmation endpoints are authenticated and no-store; mutation endpoints are same-origin. Full-scope requests are bounded to 256 KiB so the existing 1,000-commit export limit remains representable.

Actual SQL COMMIT-response loss exposed a checked-out `pg` connection error event that could escape the rejected query promise. `asUser` now handles that connection's error event, preserves the original error if rollback also fails, and discards damaged connections. It does not retry a transaction. The original durable record decides the outcome of a later explicit request.

## Dispatch boundary and upgrade requirement

No current daemon consumes these reservations, reads a write key for them or sends receive-pack. Applying a future migration must **not** automatically send existing confirmations. A separate explicit dispatch request must bind the chosen confirmation and current authority. Before introducing possible remote effects, replace the unsent withdrawal transition with one that excludes admitted/possibly-started sends, and retain the global destination owner through uncertain sends. Artifact disappearance, token revocation, current old-ref observations, cancellation and permission changes cannot release an unknown remote attempt.

Next work remains the durable send queue, exact-byte final SQL send gate, fresh provider checks, one send attempt across processes, persisted Git/credential outcomes, and explicit unknown-effect handling. PR/CI/webhooks/protected merging, external accounts/models, retention/quota lifecycle and optional Docker parity are still outside this evidence. Native remains the default. This increment needs migration 028 and current Web code; it does not add a Git daemon handler or require Docker. Migration 028 has been applied to the main local database and is now immutable; later schema changes require a new migration.

## Verification

The confirmation tests extend `push-preview-broker.test.ts` using real PostgreSQL, two native Pi commits including an intermediate version, immutable Git exports and disposable authenticated upload-pack fixtures. They cover complete-scope SQL checks, concurrent idempotency, member/preview competition, grants/MFA, withdrawal/replay, revocation/regrant, binding changes, corrupt/missing artifacts, mid-read authority changes, task-row locking and actual lost COMMIT replies. No confirmation test sends receive-pack.

The outgoing-history browser workflow now verifies full per-version acknowledgement, confirmation/withdrawal response loss and reload, second-member occupancy, authority invalidation, readonly/CSRF boundaries, history corruption and desktop/390px layouts. Focused browser evidence is distinct from the complete isolated browser regression.

The full native collaboration suite passed **406/406**. After explicitly making a missing repository binding return false instead of a nullable validity flag, the final preview/confirmation suite passed **24/24**, including eight new confirmation tests and that missing-binding assertion. TypeScript and full lint passed. The complete isolated browser regression passed with both the new workflow and existing identity, membership, run, resource, contract, result, review/repair/promotion and GitHub import/sync flows. Final desktop and 390px screenshots were inspected, and the main four-user smoke passed after migration 028. The main Web and Git daemon instances were reused.
