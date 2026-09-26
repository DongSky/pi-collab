# ADR-011: Native run reconciliation and logical archival

Date: 2026-09-23. Status: implemented for trusted, single-node native execution. Docker recovery remains unverified. Native code snapshot continuation is implemented separately in [ADR-012](0012-workspace-snapshots.md).

## Context

A lease expiry or lost RPC result does not prove that an AI or its tools stopped. Restarting a task while an old writer remains alive defeats task fencing. Process exit also does not prove whether an external action succeeded. Recovery must preserve these distinctions across executor restarts.

## Durable evidence

Native launch writes a private receipt outside the workspace: `runtime-receipts/<workspace-id>.json`, binding workspace, run, executor and original run epoch. An exclusive `launching` record precedes spawn; `started` records the process-group leader PID; `stopped` is written only after the ordinary group is gone and output streams close. Atomic replacement and file/directory fsync persist transitions. A workspace can never launch twice, including after executor restarts.

Recovery only observes. It never signals a PID loaded from disk, calls Pi, replays a prompt/tool, copies a capability or reuses an old directory. `stopped` is positive local shutdown evidence. For `started`, the kernel boot identity must match and both PID and process group must be absent. A reused PID conservatively blocks recovery. Missing, malformed, mismatched or incomplete launch receipts fail closed. A changed boot identity also blocks: a directory could have been copied from a still-running node. Legacy runs without receipts need a future operator attestation workflow; direct database edits are not recovery.

These guarantees apply to trusted native processes. Deliberately daemonized processes may escape a group; the same OS user can edit local receipts/files. This is not a hostile-code sandbox. macOS and Linux boot identities are supported. Docker recovery is rejected until its container observation is independently verified.

## Authority and persistence

Migration `007-run-recovery.sql` adds function-managed run actions, RLS, archive metadata and restricted worker functions. A project Maintainer submits a reason, expected run revision and idempotency key. Owner/Admin MFA requirements apply. The worker rechecks organization/project authorization versions; removal and regrant cannot revive a request. Organization administrators outside the project cannot bypass project authority.

Only one pending action is permitted per run. Duplicate submissions/completions are idempotent; different payloads under one key conflict. Requests survive restarts. Observation can repeat after a lost database response. The executor listens for pg idle-client errors so a dropped idle socket cannot terminate the supervisor before lease watchdogs stop its Pi processes. Lock order is organization authority → run → action/workspace/task → project event cursor, consistent with member revocation and completion.

Successful reconciliation marks the run `cancelled`, workspace stopped, advances its epoch and unblocks the task unless explicitly closed. It records `reconciled_without_replay`, evidence hash, applicant, reason and audit/events. **Original unknown commands stay unknown.** External effects still need inspection. A subsequent explicitly authorized run gets a fresh workspace from the selected repository baseline; old changed files are retained and not silently copied.

## Archival

Archival requires a terminal run, stopped/already-archived workspace, current Maintainer authority and reason. Files, outputs, commands and audit history remain. Initial `retain_until` is seven days; retries do not extend it. This is a minimum retention marker, not a deletion deadline. No garbage collector, branch deletion or physical removal is implemented. Snapshot lineage, reference checks and retention policy must precede cleanup.

## Evidence and remaining work

Eight recovery tests cover authority/MFA/version boundaries, 25 competing duplicate requests, lost completion-response replay, revoke/regrant, missing receipts, real Pi RPC timeout, actual executor SIGKILL, a cut TCP database connection, expired leases, surviving writers, receipt identity/boot/launch validation and a simulated reused PID, old-epoch rejection, preserved unknown commands, fresh workspace continuation and non-destructive archival. Browser tests cover authority/CSRF, lost action response, pending/blocked/resolved UI, archive, refresh replay and 390px layout using labeled protocol fixtures. They are not real provider inference tests.

Full snapshot/index coverage, verified environment manifests, launch-gap/changed-node operator attestation, Docker recovery, process-group escape containment, multi-node routing, retention garbage collection and live session-control transfer remain planned. This does not mark full M1/M3 acceptance complete.
