# ADR-022: Reconstruct complete, pinned conflict-resolution workspaces

Status: **native repair-task workflow implemented**. Migration 018 connects human creation/assignment, durable execution, snapshots, mandatory validation, publication and replacement integration. Native execution is the default; Docker repair execution is refused pending parity verification. Migrations 001–017 remain unchanged. This workflow grants no Git target-ref promotion permission.

## Problem and implemented behavior

The preview in ADR-019 stops when Git first reports a conflict. Giving that partial checkout to a repair agent would omit all later selected results. Running another merge in an author's active checkout would also interfere with their ongoing work.

Preview and repair preparation now use the same source reconstruction code. Each source is rebuilt from its verified immutable snapshot relative to its original base commit. Dependencies must already appear in the supplied order, task/result identities cannot repeat, and all identifiers are validated. Source workspaces, the failed preview, the imported repository and the user's repository remain unchanged.

A resolution input pins its task ID, failed integration ID/input hash, repository, target branch/SHA, mandatory validation profile, policy ID, every ordered source result/snapshot/hash/base, the completed merge prefix, and the recorded first conflict. The database constructs this input from a current, governed conflicted integration. The runtime does not look up current authorization or policies and **must not be called directly with browser/agent-supplied inputs**.

The preparer allocates a new native workspace with an exclusive ID. Before proceeding beyond the first conflict, it reproduces both the original completed merge prefix and the exact recorded conflict result/path/object IDs. Missing, changed or unexpectedly conflict-free inputs fail preparation. It then commits Git's provisional conflict tree in that private clone and continues every remaining source in order. Later conflicts remain separately recorded, even when a subsequent step reports a clean merge.

The returned `preparedCommit` is provisional. It can contain text conflict markers or Git's selected side of a binary conflict. A clean Git index does not prove resolution. Evidence always says `requires_resolution`; it cannot be used as integration validation, a published result, review approval or merge authority.

For every conflicting step the evidence records the prior commit, source commit, provisional tree, result ID, each path's exact base/ours/theirs object IDs and modes, and structured Git conflict kinds/paths. Missing sides stay null. Rename, modify/delete and binary conflicts retain their distinct evidence. Git diagnostic prose is not copied into the artifact. The existing preview keeps its previous evidence shape, so historical code/review readers remain compatible.

## Canonical inputs and failure handling

The new workspace contains two sidecars outside its checkout:

- `resolution-evidence.json`: provisional composition and every observed conflict. This is preparation evidence, not a result.
- `resolution.json`: canonical pinned input, written last after successful construction and contract materialization. Its SHA-256 identifies the input separately from the original integration's database input hash.

Both files use exclusive writes, mode 0444, file fsync and directory fsync. Read-only permissions alone are not a native security boundary. `verifyResolutionInputs` compares the exact bytes against the caller-held canonical input, rather than accepting a hash claimed by the workspace. Bounded reads reject symlinks, directories, FIFOs, oversized files and concurrent mutation. Execution setup, snapshot capture and validation use this verifier. Snapshots retain the canonical input; restoration allocates another fresh workspace and recreates its sidecar from that input. Preparation evidence belongs to the initial workspace and is not recreated by snapshot restoration.

Cancellation or invalid/corrupt input never makes a partial workspace reusable. A caller must keep failed directories unavailable and reconcile/retain them under the existing workspace lifecycle. Preparation never retries into an existing directory, deletes an existing writer's checkout, starts Pi automatically or falls back to the latest source versions. Git composition has bounded output and 30-second child timeouts. Initial clone provisioning retains the existing bounded provisioning behavior and is not immediately interruptible by the composition signal.

Bounds are 32 ordered source results, 256 conflicting paths per step, 1,024 conflicting file records across the combination, a 1 MiB canonical input and 4 MiB preparation evidence. Existing snapshot bounds/exclusions still apply. Raw checkout disables a second working-file EOL/encoding/filter transformation. Excluded paths in the imported base are still inherited, as in existing native workspaces; preparation is not a sanitization or sandbox boundary. Docker parity has not been verified.

## Durable task and authority protocol

`POST /api/collab/integrations/:id/resolution` accepts the human owner, title, reason and idempotency key. A Developer may assign themselves; a Maintainer may assign an active eligible member. Same-project RLS, current MFA requirements and organization/project locks apply. Creation requires current source results/contracts, original requester authorization, target and policy. Only one repair task can be created for a given failed integration; retrying the original request returns the same task, including after explicit reassignment. A different request cannot silently replace it.

The task has frozen strict dependencies on every composed original source. A trigger rejects additions, deletion and replacement. Normal explicit reassignment remains available and cancels old control through the existing ownership protocol. Runs pin the original repository, target and source versions and use the existing leases/epochs and cancellation machinery. Currentness traverses the original run lineage, including nested repairs. It checks policy, target, source withdrawal/replacement, dependency/contract versions and the original integration requester's authorization version. Revoking and regranting that requester does not revive the old repair. Queued/active repairs cannot silently adopt replacements; humans must request a new current integration and create its repair.

`GET /api/collab/tasks/:id/resolution` exposes fixed provenance and currentness to project readers. The UI pins repository/profile controls, explains the frozen graph, and stops offering a new run for stale input. These display controls do not replace database enforcement.

## Validation, publication and replacement semantics

Snapshots carry the exact resolution input, with matching repository/base identities. Ordinary artifacts omit the optional field to preserve previous serialized bytes. Repair validation requires the original mandatory profile, exact snapshot provenance and source currentness. Before any project command runs, a conservative scanner rejects full-line conflict markers in UTF-8 and either UTF-16 byte order, including BOM-less input and a trailing odd byte. Literal marker examples must be escaped or encoded explicitly. This check does not infer correct binary, rename or deletion choices, nor does it prove semantic correctness. Existing snapshot exclusions remain explicit limitations.

After each validation command, the worker checks code, dependencies, contracts and the canonical resolution sidecar. A zero exit status cannot make mutated input pass. Successful evidence must carry the exact resolution pin and `resolutionMarkersAbsent:true`; the database enforces these fields. To publish a repair, a person must explicitly acknowledge all conflict choices and give an explanation of at least ten characters. Publication rechecks input currentness and records a separate immutable acknowledgement/audit entry. AI execution does not publish automatically.

The published result replaces the **whole covered combination** relative to the original target. The integration planner retains all originals for lineage and currentness while removing them from actual composition. It rejects explicit selection of both repair and covered originals, and competing repairs covering the same input. Nested repairs expand coverage transitively. An ordinary result depending on a covered source is ordered after the covering repair; invalid remappings/cycles fail rather than guessing an order. Bounds are 256 original lineage results and 32 actually composed sources.

Original run requesters and result publishers remain contributors through nested repairs. Republishing through another owner cannot bypass self-approval restrictions. A new repaired integration runs combined mandatory checks and starts with fresh version-bound independent reviews. Passing those reviews still does not update any local or remote Git branch.

## Upgrade compatibility

Apply migration 018 before deploying the new web code/executor. The new executor uses `claim_resolution_aware`, `pending_snapshots_with_resolutions`, `claim_validation_with_resolutions` and `claim_integration_with_resolutions`. Internal kernels are unavailable to application/executor roles; only the intended public adapters are granted. Old worker adapters skip repair runs and ordinary consumers whose direct input is a repair snapshot. This includes a strict consumer queued before the repair was published: dispatch inspects the result it would pin. Old snapshot/validation adapters also skip these inputs, and old integration workers skip combinations containing repair sources. Compatible ordinary work remains available; a repair at the front of a target queue retains ordering until a capable worker can service it.

There is no automatic downgrade for repair artifacts. Preserve migration history and upgrade the executor; do not edit already-applied SQL or strip provenance. Native mode isolates working directories and process/control identities, not the host OS. Docker, external model inference, live human editing, automatic conflict decisions, unknown integration reconciliation and durable target promotion remain separate work.

## Acceptance evidence

`tests/collab/resolution-runtime.test.ts` uses real Git, immutable snapshots and a real native Pi process with diagnostic tool commands, without external model inference. It covers complete source reconstruction beyond multiple conflicts, deterministic identities despite changed live workspaces, unchanged originals, modes, CRLF/UTF-16, binary/rename/modify-delete stages, original-failure mismatch, malformed topology, later corrupt input, incompatible contracts, canonical-input tampering/special files, cancellation and exclusive workspace IDs. Pi can inspect the fixed sidecar and edit its own combination without changing either author's files; that edit deliberately grants no publication or merge status.

`tests/collab/resolution-tasks.test.ts` adds real PostgreSQL/Git/Pi coverage for creation, RLS, assignment, frozen dependencies, lost-response replay, all old worker adapters, waiting consumers, snapshots/restoration, mandatory checks, marker rejection, acknowledgement, nested replacement/remapping/overlap, fresh independent approvals, original authorship, source withdrawal, reassignment, parent revoke/regrant, target/policy staleness at publication and validation-time sidecar mutation.

`e2e/collab-resolution-tasks.mjs`, invoked by the isolated identity/integration harness, exercises two authenticated browser contexts: assign and retry creation, retain three ordered inputs including one after the first conflict, run a real native Pi diagnostic, capture and validate, require/retry human publication, compose the replacement, refuse original/repair-author self-approval, invalidate after original withdrawal, and inspect desktop/390px layouts. No external inference or target-ref writes occur. Final run results are recorded in the implementation-status document.
