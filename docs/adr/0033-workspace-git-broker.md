# ADR-033: SQL authority for native workspace Git operations

Status: implemented service protocol; browser integration is described in [ADR-034](0034-browser-workspace-git.md). Docker acceptance remains pending.

## Authority and admission

Migration 026 adds a private `collab_git.workspace_operations` ledger and action history. The Web role receives only authenticated request, list and cancel/reconcile procedures; the dedicated Git role receives only narrow claim, begin, intent, gate, acknowledgement, finish and failure procedures. Neither role gains direct ledger writes. The Git service does not receive account-table or general project-table access. Migrations 001–025 remain unchanged.

Admission derives run/executor/epoch/workspace from SQL. It accepts only a native, positively stopped run's workspace in `stopped` state; the native runtime independently verifies the exit receipt. Only a current project Maintainer or the task's current Developer owner may request a change. Existing organization MFA requirements apply. Admission captures organization/project authorization versions, task version and run revision. Commit author ID, sanitized name, operation ID and timestamp are server-derived; only the message and exact reviewed revision come from the request. The Git author email and provenance remain the pseudonymous format specified in ADR-031, not an impersonated or signed identity.

The request contains either file/hunk stage/unstage selections or a commit message, explicit acknowledgement, expected run revision and exact Git revision. Repeating `(run, actor, idempotency key)` must preserve the whole payload and returns the original job. Project members can read a bounded history without claim nonces, backend PIDs or raw internal control records. Every admission, action, durable effect intent and terminal/unknown decision appends audit evidence.

## One workspace owner across Git and snapshots

A partial unique index retains ownership for queued, running **and attention** jobs. There is a fixed limit of 20 unfinished workspace Git jobs per project. Both request directions serialize under the organization's existing authority lock: Git admission refuses a pending snapshot; a snapshot insertion trigger refuses an unfinished Git job. An archive is logical metadata only, and a new AI run always uses another workspace; final Git authorization requires the original workspace still be stopped.

Snapshot completion occurs after an immutable artifact has been captured. Duplicate late snapshot readers cannot overwrite an already complete nonempty artifact directory. Once a snapshot is failed/revoked, later completion cannot make it ready. Thus a late duplicate reader does not publish a newly mutable historical snapshot when Git ownership has already begun. This change preserves existing snapshot worker protocols; it does not claim an exclusive snapshot-worker lease. Future workspace mutation/deletion facilities must join this occupancy protocol before deployment.

## SQL and native fencing are both required

Each broker attempt pins one connection and owns an operation-specific session advisory lock, fresh claim nonce and backend PID. Another lane cannot claim the live job or use a callback on another connection. A newly observed orphaned running claim becomes `attention`, never another execute attempt. Explicit cancellation/reconciliation can be taken over only by a currently authorized operator; it cannot replace a live SQL owner. Reconciliation records that operator's own authorization versions without changing the original request or its author.

The broker first validates the read-only plan so ordinary stale revisions and invalid selections fail before launch intent. It then durably records launch intent **before** native reservation. Native reservation repeats source checks. After the child prepares the exact operation, SQL stores its complete immutable effect request before any effect permission is sent.

The final SQL transaction holds the organization authority lock and shared user/run/task/workspace row locks, checks original membership versions, task/run versions, current ownership, stopped state and cancellation, then allows the child to apply at most once. The child's effect receipt must match the stored request and be acknowledged in that same SQL transaction. The native control CAS, actual Git locks, exact source checks and process fencing from ADR-032 remain additional requirements.

An effect acknowledgement is **not** release. `effect()` resolves at the native `sealed` checkpoint before cleanup/exit. SQL keeps the job `running` until `child.done` and a fresh observation confirm a matching terminal receipt, completed lock cleanup and positive process-group exit. Final settlement can record already authorized historical effects after a subsequent revocation; it does not authorize another mutation. Task ownership changes that race the final effect wait for its acknowledgement transaction.

There is no distributed transaction between SQL and Git. On connection loss or shutdown the broker stops only its own live native child handle, destroys the SQL connection and does not reconnect/replay. A later authorized reconciliation transaction can fence a matching unlaunched reservation, observe an already settled receipt, or launch a fresh fenced native recovery process after positive old-writer exit. Recovery observes existing index/ref effects and cleans only owned locks; it never stages or commits again. SQL verifies request identity and requires a durable effect intent for any recovered application. Cancellation is ordered against the final gate and cannot undo an effect already admitted; a later cancellation/reconciliation can honestly report `applied`.

## Deliberate unknown states

If launch intent is durable but no matching native control state can be established, occupancy remains. An old process might still be delayed before reservation CAS; absence alone cannot authorize handoff. A control record for another operation, unconfirmed process exit, foreign/remaining Git locks, changed unknown output or failed reconciliation authority likewise retains attention. An explicit action cannot force these states to success or release. Administrator disposition/recovery into a separately verified workspace is still future work.

The two native service lanes rotate among workspace operations, GitHub import and GitHub sync. Local workspace operations and their reconciliation never request a GitHub key or network transport. Production local-only service startup needs the restricted Git database URL; the external Git key path is enforced lazily when a GitHub operation actually needs credentials. Same-OS-user/native execution remains the trusted development boundary, not a hostile-code sandbox.

## Verification and remaining scope

`tests/collab/workspace-git-broker.test.ts` uses temporary real PostgreSQL databases, generated fixture accounts, actual local Pi tool processes and real Git effects. It covers deduplication, current roles/MFA/ownership, narrow grants, snapshot exclusion, cancellation, permission/version races, pinned SQL claims, same-transaction acknowledgement, cleanup-vs-acknowledgement occupancy, missing native evidence, actual backend termination, actual native SIGKILL after commit and TCP-dropped COMMIT replies. Recovery checks one existing commit/index effect, not a substituted successful callback. No personal credentials or external inference are used.

The service/admission helpers remain private native capabilities. Authenticated HTTP admission/read routes and browser selection/confirmation are now described in ADR-034; the Web process still does not execute native writes. Task-branch push, PR/CI, protected remote merge, lifecycle/backup/DR and Docker parity remain separate outstanding work. This is not completion of development plan §7.2 or M3-01.

References: [ADR-031](0031-workspace-git-plans.md), [ADR-032](0032-native-workspace-git-operations.md), [ADR-029](0029-web-git-sync-broker.md), [ADR-012](0012-workspace-snapshots.md).
