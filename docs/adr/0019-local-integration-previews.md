# ADR-019: Immutable local Git integration previews

Status: native preview implementation accepted for the documented scope. This is the combination/checking portion of the local integration queue. It does not yet advance a local or remote target branch, provide merge approval or complete the M2/M3 delivery loop.

## Admission and immutable identity

A project Developer or Maintainer requests a preview from current published task results, the registered repository's imported default branch/SHA and an immutable Maintainer-authored validation profile. Existing organization MFA rules apply. The database checks project/role scope before replaying an idempotency key. Different payloads cannot reuse a key.

The database expands all pinned result dependencies, rejects missing/withdrawn/stale/cross-repository inputs, limits the closure to 32 results and stores a deterministic topological order. Results for one task cannot appear twice. Each source records result/task/snapshot IDs, manifest hash, snapshot worktree commit, original base SHA and dependency result IDs. The target branch/SHA, complete source list, profile/config and input hash are fixed at admission. Changing any input requires a new preview. The current interface displays 100 current results and 50 recent previews; the initial queue limit is 20 active previews/project.

## Git construction

The executor creates a fresh independent checkout of the broker-imported repository. It never writes source task workspaces, the imported bare repository or the user's original checkout. Every source snapshot is reconstructed independently from its manifest and hash-checked blobs, and reconstructed Git commits must match the saved IDs.

Snapshot history deliberately omits original ancestors. Therefore the integrator computes each snapshot's actual working-byte delta against its original imported base and builds a synthetic commit with that base as parent. Paths omitted by snapshot policy are excluded from the delta rather than interpreted as deletions. Synthetic source commits are combined with real `git merge-tree` in the stored dependency order. Hooks, external Git configuration, lazy fetch, replacement objects and network protocols are disabled; commands receive argument arrays and a fresh environment. Git operations are bounded and cancellable. Source commits/combined tree/merge commits are recorded for every successful step.

A Git conflict stops the combination. Evidence identifies the result being applied and conflict paths with base/ours/theirs blob IDs. No automatic patch is applied to a source task. Binary/content/add-delete conflicts supported by Git can be reported; unsupported path/mode or evidence bounds fail explicitly. ADR-021 adds verified conflict blob browsing. Conflict-solving task creation, reviewer-approved repair and automatic suggestion limits remain follow-up work.

## Exact combined checks and exclusions

A successful combination is captured as a new immutable snapshot. The existing native command validator restores that snapshot into a second fresh workspace, runs the selected profile and records exact code/config/environment/exit/output-hash/cleanup evidence. Source results passing individually do not imply the combination passed. Source modification by checks, residual processes, missing evidence and command failure prevent `checked`.

The Git candidate commit and validated snapshot worktree commit are distinct: snapshot policy excludes private paths, generated outputs and unsupported filesystem entries. Excluded target paths are preserved in the private Git candidate, then omitted from the actual validation checkout. Evidence lists these omissions. `checked` certifies the recorded snapshot under the selected profile; it does not certify excluded content, a complete dependency/system environment or a required-check/merge policy. Contract inputs are the consistent union of source snapshot contract pins. Dependency code is combined into the candidate, not supplied as the source run's separate `../dependencies` layout; profiles must check the combined project.

## Queue, authority and failures

The durable queue serializes previews per repository/default target branch. Different repositories can be claimed independently by multiple executors. Development runs remain independent. Claim increments an epoch and assigns a 30-second lease. Heartbeats recheck requester organization/project authorization versions and the current target/results/dependency/contract state. Finalization rechecks them under the same organization serialization lock as authority changes.

States are `queued → integrating → checking → checked`, with `conflicted`, `check_failed`, `stale`, `cancelled`, `revoked` and `unknown` alternatives. Source withdrawal/new publication, contract/dependency updates and target changes invalidate old evidence; the read API reports current validity even for historical completed previews. Cancellation is available to the requester or project Maintainer and records a reason plus idempotency key. A queued cancellation has no process effects; an active cancellation waits for supervised work to exit.

An expired execution becomes `unknown` and continues to occupy its target. It is never reassigned or automatically retried. A late finish cannot overwrite unknown state. Actual database disconnection aborts the local check process; if completion cannot be stored, durable lease expiry preserves uncertainty. Before project commands launch, a failed private Git construction can safely report construction failure. Native supervision is for trusted local code; it is not adversarial host isolation. Administrative unknown reconciliation and integrator crash recovery need additional work before this queue is production ready.

## UI and upgrade

The task page contains the project Git integration panel: repository/profile selection, result selection, dependency order, status, input staleness, conflict attribution, cancellation and authorized evidence download. Lost admission responses retry the original payload/key. Visible-page, online/resume and project-event refreshes update shared observations.

Migration 016 adds the immutable integration records, dependency references and restricted executor functions. Earlier migrations are unchanged. Apply it before starting the new executor; the native supervisor handles one local preview at a time alongside its existing run/validation capacities. Docker previews are not dispatched.

ADR-020 adds versioned required-check policy and human review. Remaining delivery work includes local baseline advancement with durable Git side-effect reconciliation, remote Git/PR/CI, conflict resolution tasks, complete environment packaging, quotas/retention and Docker parity. No remote operation or model inference is performed by this feature.

## Evidence

`tests/collab/integrations.test.ts` uses actual PostgreSQL, Git, native Pi processes and Node checks. It exercises two overlapping Pi inputs, real combination checks, unchanged source repositories/workspaces, dependency ordering, idempotency/role/data scope, conflict attribution, failing combined checks, fabricated-success rejection, source withdrawal/target movement, active revocation, corrupt artifacts and a real TCP cut during a live check process.

The isolated full-stack browser flow creates source results through real Pi diagnostics and verifies admission retry, Origin/ownership checks, actual Git/command evidence, conflicts, cancellation, source withdrawal, another browser's reload and desktop/390px layout. Pi diagnostics are explicitly local tool execution, not external model inference. Screenshots are `test-results/collab/integrations*.png`.
