# ADR-023: Attributable local Git promotion and terminal decisions

Status: **native Git effect primitive implemented and tested; durable admission/worker/UI subsequently added in [ADR-024](0024-durable-local-promotions.md)**. This ADR describes the effect foundation at migration 018; migration 019 supplies the subsequent workflow without changing migrations 001–018. Only disposable test repositories were advanced during validation. The full local/remote delivery scope remains in the development plan; Docker parity is unverified.

## Problem

A checked integration and satisfied reviews are observations, not lasting merge authority. Updating a branch and then recording success in PostgreSQL can lose the acknowledgement after Git has already changed. A lease expiring or a process disappearing does not prove that an old Git command cannot still arrive. Blindly retrying, clearing the queue or rewriting the branch would make parallel AI delivery unsafe.

There is a second problem with Git's file-based refs: a multi-ref `update-ref --stdin` transaction locks its affected refs together, but several ref lockfiles cannot be renamed as one filesystem operation. The protocol must not assume branch plus receipt updates are crash-atomic merely because Git calls them a transaction.

## Fixed input and exact checked code

The internal supervisor input identifies the operation, integration, repository, immutable request time, target branch/expected SHA, candidate commit/tree, input hash, review revision, policy/profile, checked snapshot manifest and worktree commit. It is schema-validated and serialized in one canonical order. It will be derived from authoritative database rows, never accepted as a browser's proposed Git write.

Preparation only accesses fixed broker-owned directories and requires a bare target repository. It checks the branch with Git, refuses symbolic target/decision refs, symlinks, special files and object alternates, and independently verifies immutable snapshot objects and the candidate commit bytes. The candidate must descend from the expected target.

The verifier reconstructs the expected Git tree from the original target plus exactly the checked snapshot's permitted delta. Every added/changed blob and executable mode comes from verified snapshot bytes; deletions use the same exclusion policy as source composition. The resulting tree must equal the candidate tree. Thus excluded target paths can remain **only unchanged**; a changed `.env`, ignored/generated path or other omitted candidate difference cannot be promoted by claiming the remaining snapshot passed. Inherited excluded content is still unvalidated, and the future admission UI must expose that limitation. No verification command runs repository code.

Candidate objects move through bounded Git pack/index-pack pipes with strict import verification. No remote URL, fetch helper, credential, hardlink or alternate is used. Hooks, external configuration, textconv/filter effects, lazy fetch and replacement objects are disabled. Commands have 30-second deadlines; each public primitive has a two-minute deadline, pack transfer is capped at 128 MiB, and existing snapshot/file/object bounds also apply. A failed preparation may leave unreferenced verified objects but cannot update the target.

## One changed ref at each effect boundary

A unique **promotion commit** has the candidate's exact tree, the candidate as its sole parent, and a deterministic platform message containing the complete fixed operation input. Its SHA is computable before admission. The author/committer timestamp uses the immutable request time rather than the worker's clock; actual execution time belongs in the future database audit. The commit adds provenance without changing code. The future workflow must explicitly bind both reviewed candidate and derived promotion SHA, rather than presenting them as the same commit.

The decision ref is `refs/pi-collab/promotions/<operation-id>`. Canonical receipt commits represent `prepared`, `applied` or `aborted`. Prepared/applied receipts point to the unique promotion commit, preserving its candidate graph through ordinary Git garbage collection. An aborted receipt has no parent, so it can close an operation before an old worker has even imported its code. Terminal receipts are never deleted or reopened by these primitives.

1. **Prepare:** verify code and import fixed objects, then create the prepared decision ref only if absent. A concurrent abort wins over this create; late preparation reports the actual terminal decision.
2. **Apply:** one Git transaction locks/verifies the prepared decision and compares the target against the expected old SHA, but changes **only the target ref**, to the unique promotion commit. A competing candidate or terminal abort makes the transaction fail. It does not attempt to change the receipt in that transaction.
3. **Seal:** the target equal to the promotion SHA, or its verified ancestry containing that unique commit, proves a historical application even if the process died immediately after the target write. A subsequent single-ref CAS records the applied receipt. Receipt objects are recreated if unreferenced objects were collected while work waited.
4. **Abort:** one transaction verifies/locks the observed target and creates/updates **only the decision ref** to aborted. If an apply races that observation, the target comparison fails and the caller reads the actual result. An already-applied operation remains applied. An absent receipt alone is never treated as completed cancellation; the terminal decision must actually be written.

Each actual ref mutation therefore relies on one ref's atomic replacement. Git's multi-ref lock/verify mechanism serializes apply versus abort, without requiring atomic replacement of two files. The code enables Git object/reference fsync. Tests simulate process death, not hardware power loss; deployment still needs storage durability/backup validation.

Observations distinguish the logical decision, raw receipt OID, unique promotion SHA, evidence from receipt/target/ancestry, current target SHA and whether that target still equals the promoted version. An applied historical receipt does not authorize resetting a subsequently moved branch or advancing a database pointer to an old SHA. Unexpected receipts, corrupt/missing objects and symbolic refs fail closed. Cancellation, timeout or command failure does not become proof of nonexecution; reconciliation uses a fresh read and the terminal CAS.

The managed target is exclusively written by the future broker using fast-forward/CAS operations. Out-of-band history rewrites are unsupported. A sealed receipt retains historical evidence after divergence; deleting/replacing receipts or an external rewind before sealing requires quarantine/manual recovery, not an automatic assertion that no write occurred. Native directory separation does not defend against hostile same-user host access. No `--force`, default-branch reset or automatic revert is provided.

## Database and product gates (subsequently implemented locally in ADR-024)

The runtime primitive deliberately has no identity context and is not itself a permission check. Before connecting it to users:

1. Add immutable, same-project promotion records, scoped read access, maintainer/MFA admission, request idempotency, original authorization versions, append-only audit and per-repository target serialization. Pin the final derived promotion commit alongside candidate, checks, review revision and exclusion acknowledgement.
2. Re-evaluate current original contributors, required checks, eligible independent approvals, blockers, policy, source versions/contracts, requester authority and exact target immediately before admitting the effect. Use the existing organization lock order; do not authorize from a cached `reviewSatisfied` response. Cancellation/revocation of an already-admitted external effect remains pending until the Git decision is reconciled.
3. Persist effect intent before launching Git. A worker/database disconnect must retain target occupancy and uncertainty. Never reclaim an old operation or advance another candidate merely because its lease expired. Reconcile by terminal Git decisions and ancestry, then conditionally update the database base pointer and append a new baseline event. A mismatched actual target cannot be silently adopted. The one-ref cancellation fence must close late old work before releasing occupancy.
4. Guard every old and new integration/promotion worker entry point against unresolved promotion effects. Preserve immutable task workspaces and old baselines; notify other AI tasks at safe boundaries, without forced rebases. Recompute candidates/checks/reviews for the new target.
5. Expose maintainer confirmation, fixed target/candidate/promotion SHAs, checked/excluded scope, queue status, lost-response retry and actionable reconciliation states. Verify two-user browser races, authorization changes, actual TCP/worker failure windows and independent review enforcement before enabling the action.
6. Implement the distinct remote GitHub App/PR/CI/webhook protocol and its provider-side expected-SHA protections. Local promotion must never imply remote publication, remote permission or branch-protection compliance.

## Evidence

`tests/collab/promotion-runtime.test.ts` creates real bare repositories, immutable source snapshots and actual combined Node checks. It verifies exact trees including binary/executable/deletion changes, unchanged excluded baselines, untouched original/source workspaces, competing candidates, cancellation races, fencing before preparation, an actual SIGKILL between target update and receipt sealing, ancestry recovery, divergence, GC retention, changed excluded content rejection, corrupt Git/snapshot artifacts, identity reuse, unsafe/symbolic refs, alternates, cancellation and disabled reference hooks.

These are internal Git effect tests. They do not prove the pending database authority workflow, browser promotion experience, remote delivery, external model inference, container isolation or full milestone acceptance.
