# ADR-024: Durable native promotion, final authority gate and baseline reconciliation

Status: implemented; validation evidence is tracked in `docs/implementation-status.zh-CN.md`. Migrations 001–018 are unchanged. Migration 019 introduces the native workflow and is now applied locally; it must not be edited. Remote Git delivery and Docker parity remain separate, unverified work.

## Admission and fixed identities

The app can request a promotion of an existing checked integration, its exact review revision, an explicit acknowledgement of excluded unchanged content, a reason and an idempotency key. It cannot supply a filesystem path, Git command or proposed branch write. Admission requires an active project maintainer with MFA, all current integration inputs and required policy, independent current approvals, and no outstanding request for changes. Approval contributors include the original authors of repaired combinations.

The database derives the canonical input, UTC millisecond request time and final promotion SHA. PostgreSQL's `pgcrypto` module is installed in a private schema; it calculates Git SHA-1 object identities, not an authentication credential. JSON field ordering, escaping and UTF-8 object lengths match the native primitive. Tests include a Unicode branch containing a quote and compare promotion and terminal receipt IDs across SQL and TypeScript.

One nonterminal promotion occupies each repository/branch. Admission shares the integration dispatch lock, followed by the organization's authority lock; both old and current integration worker adapters exclude occupied targets. A busy/unknown integration prevents promotion admission. The app has scoped read access and named function capabilities, with no direct promotion, Git receipt, effect-grant or baseline mutation privileges.

## State and authority at the effect boundary

Normal flow is `queued → preparing → applying → applied`. Preparation may close as `aborted`. `unknown`, `blocked`, `reconcile_queued` and `reconciling` retain occupancy. Lease expiry produces `unknown` and never reclaims an apply operation.

1. Preparation verifies the entire candidate and creates the once-only prepared receipt using ADR-023's one-ref protocol.
2. A database function rechecks the requester's original organization/project authorization versions, MFA, current sources/target/policy, eligible approvals and blockers. It commits an immutable effect grant with the exact approval IDs and an admission timestamp before any target write.
3. Immediately before target CAS, the supervisor stops and awaits its heartbeat, opens a dedicated database transaction, acquires organization then promotion-row locks and rechecks the exact same grant. It holds the requester's MFA user row against concurrent changes. Supported membership, policy, result, contract and review mutations use the organization lock. A concurrently replaced approval is a new grant even when the number of approvals remains sufficient.
4. This transaction remains open over the short, bounded Git ref update, receipt sealing and database settlement. The expensive snapshot/tree verification occurs before the gate. A socket error aborts the Git signal. The gate extends its lease to 150 seconds and has a 135-second idle-transaction ceiling; Git operations retain ADR-023's two-minute overall limit and shorter command deadlines.
5. An error or lost acknowledgement can still mean the Git write won. The committed effect intent survives transaction rollback. The target remains occupied until receipt reconciliation; current authority loss does not retroactively erase a historical effect.

The final lock is deliberately coarse for a small native deployment: a slow Git/disk operation may delay the organization's control requests and cause other lease watchdogs to stop conservatively. Multi-node scheduling, narrower proven lock domains and load validation remain future work. The app and executor do not expose arbitrary SQL; the executor is a trusted broker, not an untrusted agent. Native same-user host access remains outside this separation boundary.

## Cancellation, reconciliation and settlement

A stop request is pending until the terminal Git decision is observed. Even a queued cancellation writes an aborted receipt, fencing a preparer that might arrive late. Once an effect is admitted, stop/revocation may race and lose to Git; the UI reports the actual outcome.

An active maintainer with MFA can request reconciliation of `unknown` or `blocked`. A new executor epoch runs the abort primitive, which either seals already-applied evidence or permanently closes the unapplied operation. It never reissues apply. Old epoch callbacks cannot settle the new operation.

Settlement validates the operation ID, exact derived promotion and receipt OIDs, receipt ref, target and evidence shape. Applied evidence requires the committed effect grant. A sealed applied receipt and actual target equal to the promotion SHA advance the database only if its old base and default branch still match the fixed input. The same transaction appends exactly one baseline record/event and audit entry. Replaying a terminal finish returns its stored status without restoring an older base.

If either Git or the database target diverges, status remains `blocked`; no branch reset, silent adoption or automatic revert exists. A sealed aborted receipt only releases occupancy when the actual target still equals the fixed database base. Out-of-band changes require administrator investigation; unsupported repair/adoption tooling is not disguised as successful reconciliation.

## Baseline visibility and product behavior

`repository_baselines` supplies durable `repository.baseline_changed` entries in the existing project SSE feed, with the same project sequence and RLS checks. Old runs and workspaces retain their original base. The Pi context tool adds the workspace/current baseline pair and a change notice for reads at safe boundaries; it neither interrupts the model nor issues a rebase command. New runs use the refreshed baseline, while new integrations must reconstruct and recheck against it.

The browser exposes maintainer confirmation, full old/candidate/final SHAs, identical-tree provenance semantics, excluded scope acknowledgement, shared progress, explicit stop/reconciliation and downloadable evidence. Mutations retain their payload/key across lost responses. Other project readers can inspect progress but cannot promote or reconcile. Repository choices refresh after events and through the existing periodic refresh.

Local advancement is only in the platform's imported bare repository. The user's original repository and each task's checkout stay unchanged. Remote publication, protected-branch compliance, GitHub App credentials, PR/CI/webhook handling and remote expected-SHA reconciliation are not implemented by this workflow.

## Verification

`tests/collab/promotions.test.ts` uses a disposable PostgreSQL database, actual native Pi diagnostics, snapshots, required commands, independent reviews and real Git refs. It exercises admission/MFA/RLS, request races, exact SQL/TS identities, legacy dispatch exclusion, authority/approval changes, final-lock contention, stale epochs, forged success, once-only settlement, old/new baseline behavior, actual TCP disconnection after Git CAS and loss of the actual database COMMIT response. ADR-023's real SIGKILL and Git-only concurrency tests remain separate evidence for the lower-level effect protocol.

`e2e/collab-promotions.mjs`, run by the isolated identity browser harness, covers two independent authenticated sessions, authorization/CSRF, acknowledgement, response-loss retry, duplicate admission, actual Git write with an injected pre-settlement failure, explicit reconciliation, baseline refresh, evidence replay and desktop/390px layouts. This is native local diagnostic execution without external inference. Neither these tests nor successful unit checks prove hardware power-loss safety, hostile-host isolation or the complete product milestones.
