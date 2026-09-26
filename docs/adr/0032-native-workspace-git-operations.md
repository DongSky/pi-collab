# ADR-032: Native workspace Git writes use a fenced operation process

Status: internal native staging/commit execution and bounded recovery implemented. **No application route, AI tool or browser control calls these primitives yet.** Database admission/final authorization, shared occupancy with other workspace operations, audit/API integration and browser acceptance remain required. This does not complete development-plan §7.2 or M3-01. Native is the default; Docker parity is separate.

## One durable owner per workspace

An independent bare control repository at `workspace-git-control/<workspace-id>.git` stores immutable operation states as commits. A single `refs/heads/operations` reference changes by expected-old-SHA CAS. Each commit links its predecessor. Permanent `refs/requests/<operation-id>` allocations prevent an old ID from being reused after a later operation. A losing reservation may consume its ID without acquiring ownership; it has no source effect and must not be replayed with a guessed new identity. The future database API will map response-loss retries to the original durable operation.

The control repository is outside the source checkout. Its state binds the managed workspace, stopped run/executor/epoch, exact preview revision, selection/commit plan hash, original HEAD/index hash and exact expected output. It contains no model/provider credential or source file content. This local journal fences filesystem workers; it **does not replace database authorization or grant access to any project**.

The state progression is `reserved → running → prepared → authorized → applied`, with a pre-effect `aborted` alternative. Cleanup completion and native process exit are additional requirements: an applied receipt alone does not make the workspace available to another operation. A new operation requires terminal effect state, recorded cleanup and positive exit evidence for the last execution/recovery group, then a fresh source inspection and a winning CAS.

## Fence before launch effects

Every execution and recovery runs in a fresh detached native process group with an isolated environment. Before touching source locks or objects, the child CASes the reserved state to one containing its random attempt ID, PID and current boot identity. Duplicate or delayed children that lose this CAS cannot touch the checkout.

An unstarted reservation may be cancelled by CAS. This safely fences even a child paused before its launch CAS; no inference about a missing PID is required. Once a child wins, another owner/recovery cannot proceed until both its PID and process group are absent on the same boot. A boot mismatch or unavailable inspection remains unsafe. Recovery never signals a PID read from disk; the launcher force-stop handle refers only to the process it actually spawned.

Recovery is itself a recorded process owner. A delayed cleaner cannot outlive a handoff and subsequently unlink another platform operation's lock, because no handoff is admitted until that recovery group has exited. All state callbacks use the expected prior control SHA; a delayed callback cannot overwrite a newer owner.

## Lock the actual HEAD before checking its meaning

The child obtains its own `index.lock` exclusively, writes and syncs an operation marker, and records its file identity. It rebuilds the approved plan from freshly inspected source and verifies all newly installed blob/tree/commit objects independently. No project clean filter, external diff or hook executes; source metadata/object hardlinks are refused.

A real Git `update-ref --stdin` transaction prepares either `verify HEAD <old-sha>` for staging or `update HEAD <prepared-commit> <old-sha>` for commit. It dereferences HEAD within the transaction. The executor requires both the actual HEAD lock and the expected task-branch lock, then checks the exact symbolic HEAD target, direct branch identity, raw index and working bytes while those locks are held. It refuses detached/changed HEAD, a symbolic task-ref alias or a Git backend/version that cannot provide these locks.

Addressing HEAD is deliberate: a branch-only transaction could observe another HEAD and omit locking it; merely finding a HEAD.lock afterwards could mistake a concurrent Git process's file for the transaction's lock. Directly addressing HEAD requires Git to acquire that lock itself. On local Git 2.50.1, combining explicit `symref-verify HEAD` with a verification/update of its referent is rejected as duplicate updates, so it is not used as an assumed portable capability.

The final parent callback receives the exact prepared state and an at-most-once `effect()` function. A future broker can hold its final SQL authorization transaction around that function and persist an effect intent before calling it. No default authorization is supplied by the launcher. Denial, disconnection while awaiting permission or a stale revision prevents application. Immediately before the effect, the source is rechecked under the same locks; authorization is recorded in the control journal before a possible write.

## Effects preserve the draft

Staging encodes a complete Git v2 index from the approved entries, including every unchanged entry. It writes the already owned lock, handles short writes, fsyncs and rehashes it, then atomically renames it over the source index and syncs the directory. It does not write working files or refs. Binary files, execution modes, deletion and partial hunk selection retain ADR-031's exact raw-byte semantics. Index stat/cache extensions may change; special index flags remain unsupported and are rejected during inspection.

Commit installs the exact prepared object, with the member-confirmed author/provenance and platform committer described in ADR-031, then commits the prepared Git transaction. Only the expected task branch is advanced; the source index and all remaining working drafts stay unchanged. Normal Git reflog behavior is retained. No push, remote credential or protected-branch permission is involved.

The applied control receipt is persisted after the effect. It preserves historical attribution after later ordinary local Git commits. It does not claim that an applied commit/index is still current. A crash before that receipt is an admitted unknown effect; it is not automatically retried.

## Recovery observes; it never replays

After positive old-group exit evidence, a newly fenced recovery process classifies an admitted stage by its exact post-index hash versus original index hash, or an admitted commit by its exact task-branch SHA versus original SHA. An already persisted applied/aborted decision is retained. Unexpected intermediate/later content without an applied receipt remains unknown. Recovery never stages again, repeats a commit, resets working files, rewinds a branch or treats a lost acknowledgement as failure.

Only the operation's own index lock can be automatically cleaned, with matching recorded identity and marker/planned-content evidence. Ownership is retired in the control journal **before unlinking or consuming the lock by rename**; a crash in that narrow gap leaves an unknown lock instead of permitting a later cleanup to delete a reused inode. Source cleanup runs once. The worker checks source lock absence before recording normal cleanup completion; process exit is checked separately.

Git owns its HEAD/ref transaction locks and can remove them itself when its input pipe closes. Recovery therefore **never deletes a residual HEAD/ref lock based on an old inode**, even if that inode was recorded while the transaction was prepared. Killing the entire group can leave those locks; replacing an index lock, missing ownership records, interrupted ownership retirement or changed post-effect content also retains quarantine. A new operation is refused. There is no force-unlock API in this increment. Explicit administrator disposition or recovery into another independently verified workspace is future work; no current test certifies that path.

The launcher force-stop operation intentionally leaves effects for observation. Normal pre-effect denial can abort and cleanly release. Current limits are a 120-second operation-process lifetime and bounded Git commands/outputs. These are trusted native development guarantees, not hostile same-OS-user isolation, resource containment, hardware power-loss certification or disaster recovery. Root/control directories and audit retention need the later lifecycle/backup work.

## Verification and remaining integration

`tests/collab/workspace-git-operation.test.ts` uses actual Git processes and, for the complete draft→stage→commit path, an actual local Pi RPC tool process without external inference. Tests cover selected vs remaining bytes, exact confirmed commit/index preservation, binary/mode/deletion and unstage, permanent operation IDs, competing reservations and duplicate/delayed starts, final denial, source changes, hardlinks, live-owner recovery rejection, ordinary Git lock contention, same-SHA HEAD redirection, and actual SIGKILL before/after effects. Recovery-process interruption, stale CAS callbacks, changed output, foreign locks and lingering Git locks must retain the appropriate unknown/occupied state. No test substitutes a fake successful callback for an actual index/ref change.

Migration 026 now binds these primitives to durable project/run authority, member identity, idempotency, final effect intent, occupancy shared with snapshots and authenticated audit; see [ADR-033](0033-workspace-git-broker.md). The Web process has no native write endpoint. Next add versioned previews and file/hunk selection, complete staged-content confirmation, recovery states, and two-browser response-loss/concurrency tests. Migrations 001–025 remain unchanged. Task-branch push/PR/CI remains later work; Docker needs its own process/exit and filesystem acceptance.

References: [ADR-031](0031-workspace-git-plans.md), [ADR-023](0023-local-promotion-decisions.md), [ADR-006](0006-dual-runtime.md).
