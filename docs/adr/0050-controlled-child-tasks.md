# ADR 0050: Human-confirmed independent child tasks

Status: accepted for migration 062.

## Context

Multi-member parallel tasks do not model an AI proposing independent writable work for its own parent task. Sharing a live checkout would introduce competing writers; directly starting a process from a coordination tool would bypass user admission, budget and persistent command semantics.

## Decision

Store immutable proposals and explicit parent/root/depth relationships. An AI can propose through its existing lease-scoped coordination endpoint; only the parent run's initiating principal who still controls that run can confirm launch. Maintainers may reject and stop but cannot charge another principal by accepting for them.

Acceptance creates a normal task and calls the existing run submission transaction. It copies baseline/runtime/model and fixed dependency/contract constraints, not the live parent checkout or raw conversation. A proposal pins task objective, owner and dependency generation separately from lifecycle version so ordinary completion does not invalidate it. Current authorization, contract/dependency validity and repository admission remain mandatory.

The atomic scheduler additionally checks per-root descendant concurrency for every run of a child task. Counts include starting, running, waiting, stopping and reconciling. Tree depth and cumulative accepted children are bounded when accepted. Existing project, member, model and storage limits continue to apply.

Results return as immutable task-result references in the UI and scoped coordination context. Human adoption requires a stopped parent and current child result, then adds a strict dependency through the existing DAG validator. Subsequent parent submission freezes its inputs as usual. Adoption does not merge code, overwrite a live checkout, wake an AI or imply approval.

Recursive stop issues standard termination requests for descendants and closes their outstanding proposals; it preserves uncertain outcomes. Parent completion is independent of descendant completion. Relationships and actions are persisted, audited and idempotent, with RLS reads and narrow security-definer mutations.

## Consequences

The native and optional Docker backends reuse the same runtime and result pipeline. The Docker runner includes the additional coordination schema. Independent child tasks can use the platform's normal reviews and integrations without a second execution subsystem.

The first version excludes resolution-run derivation, copying active environment state, automatic spending, automatic wakeups and cross-member launch delegation. Source baseline and unchanged dependency contracts must still pass current admission; the UI describes these limits. A later launch pins the then-current result of an adopted dependency, as all strict dependencies do; an already running parent's pinned input never changes.
