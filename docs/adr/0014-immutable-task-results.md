# ADR-014: Immutable task results and pinned dependency inputs

Date: 2026-09-23. Status: implemented for direct native code inputs. Required-check policy, contracts and integration remain separate incomplete milestones.

## Publication is distinct from completion and merge

A current task owner with Developer authority, or a Maintainer, publishes a passed validation as a numbered task result. Owner/Admin MFA applies. Publication records the exact snapshot, manifest SHA-256, working-code commit and validation ID. A versioned task check prevents concurrent UI updates from silently changing publication intent; an idempotency key preserves a lost-response retry. The result's content is immutable to application roles. Publication advances the task's current-result pointer without setting the task to done or merge-ready.

The validation must belong to that task, reference its ready snapshot and record exactly the source run's dependency pins. The source run must use the new dependency protocol and have current direct and transitive dependencies. A successful arbitrary profile is still only evidence for its listed commands: authoritative required-check policy and human/integration approval are not implemented by this publication API.

Withdrawing a result appends a separate record with actor and reason, preserving the original result and every historical pin. The current pointer is not silently rolled back to an older version. A new explicit publication is required to provide another current result. Repeated withdrawal does not rewrite the first recorded reason. Existing authorized project members retain access to history after the author leaves.

## Admission and dispatch

Migration `010-task-results.sql` adds immutable results, withdrawals, run dependency rows, a task graph revision and a per-run protocol/revision. The accepted start command freezes its direct graph and currently available result IDs. At most 32 direct dependencies are allowed. Available means the current published result has not been withdrawn and its own dependency lineage remains current.

Missing **strict** dependencies wait for a consumable published result, regardless of whether the producer task is marked done. Their result IDs are fixed in the dispatch transaction once all strict inputs are available. Already-fixed IDs never change. A withdrawn fixed strict input keeps the queued run blocked; stopping it and explicitly submitting a fresh run is required to select a replacement. This avoids silently changing an accepted command's inputs.

Missing **soft** dependencies are preserved as null pins. They permit work against project-owned mocks or assumptions but prevent result publication. Later upstream publication does not retroactively prove the earlier run used it. A fresh run must acquire and validate actual inputs. Contract negotiation, structured mock confirmation and merge gates remain in the contract/integration milestones.

Graph edits now pass through a scoped database function. Organization locks precede graph/task/run locks, serializing changes against admission, publication and revocation. Cycle detection remains transactional. Graph revisions change on edits; app roles cannot modify the revision/current-result columns, pin rows or result contents. Existing restrictions on direct task-owner changes remain intact.

## Consumer workspaces and verification

Before Pi starts, the supervisor checks every direct input manifest/blob and creates a private code copy in `../dependencies/<upstream-task-id>/`, with the canonical pin list in `../dependencies/inputs.json`. This is adjacent to the consumer checkout; it does not modify the checkout, create shared Git objects or link to the producer's live files. Copies contain the snapshot's eligible working code. File modes discourage accidental writes; same-OS-user native processes can still chmod them, so this is not a hostile-code security boundary.

Copied direct inputs are limited to 20,000 files and 128 MiB in total, in addition to existing per-snapshot limits. A missing/corrupt input or unsupported runtime fails before Pi receives a model capability or begins tools. The prompt identifies the input directory and version list as project data, without promoting notes into platform authority. There is no automatic merge of input files into the consumer's code.

Capturing the consumer's snapshot verifies that its input copies still match the frozen upstream manifests. The snapshot carries the full direct pin list. Validation restores the same input copies into a fresh workspace, then compares them after every command alongside the consumer source. Evidence includes the pins, so old checks without this provenance cannot approve a dependent result. Changing a private copy cannot alter the published upstream artifact; it prevents a ready consumer snapshot or passing source-integrity evidence.

Direct inputs are copied as source artifacts, not installed packages or running services. An upstream result's own dependency provenance remains in its manifest; transitive inputs are not automatically flattened into one filesystem namespace. Full dependency closure packaging, generated artifact contracts and combined Git integration remain future work.

## Staleness and rollout

New upstream versions, withdrawals or graph changes do not rewrite active working directories. A recursive lineage check detects stale direct/transitive result references, missing soft inputs and changed graph revisions. The UI displays `needs_revalidation`; publishing new results from such a run is rejected. The AI may finish its current isolated work. The user can capture it, then explicitly resume in a new run under current inputs and run validation again. Keeping an old historical version is different from certifying it for current integration.

New executors use `claim_result_aware`, `pending_snapshots_with_results` and `claim_validation_with_results`. Legacy workers cannot claim newly tracked runs or dependency-bearing snapshot/validation jobs through their old entry points. Existing active legacy runs can finish, but untracked evidence cannot publish results. Legacy queued runs with dependencies must be stopped and resubmitted after the upgrade; they are not implicitly converted from the old task-done condition. Apply migration before restarting the updated supervisor; do not roll back the schema while references exist.

The default remains native execution. Dependency-bearing Docker runs are rejected pending a verified input mount implementation. A result does not approve Git push, review, merge or external side effects. Shared-resource fencing, source/target/contract-specific integration checks, required profile policy, artifact availability/retention, event-driven invalidation notifications and configurable quotas remain outstanding.

## Evidence

`tests/collab/task-results.test.ts` uses real PostgreSQL, actual Pi RPC/tool processes, captured files and native verification commands. It tests strict waiting despite done status, publication without merge, duplicate requests, app-role write denial, exact input copies, genuinely overlapping producer/consumer Pi lifetimes, new-version and transitive invalidation, missing soft inputs, withdrawal history, graph edits, legacy-worker exclusion, corrupted blobs and modified private input copies. These are diagnostic tools, not model-inference acceptance.

The isolated browser suite creates a strict downstream task, proves it waits, retries a lost publication response, consumes the published input through Pi, displays its version to another authorized browser, withdraws the result and observes revalidation. CSRF/scope and desktop/390px layouts are checked. The broader project-member regression also verifies that new column grants do not reopen direct ownership transfer.
