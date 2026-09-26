# ADR-028: Native GitHub synchronization shares durable target occupancy

Status: implemented with migration 023; native protocol acceptance. External GitHub accounts, Web submission/Git broker, push/PR/CI and Docker parity remain open.

## Behavior

A project Maintainer with MFA can request a synchronization through the explicit local administrator CLI. It fetches the observed remote default branch into a fresh private staging repository through the existing single-repository read client and loopback Git relay. The provider token is revoked before effect admission. Git/Pi never receives App private material or the provider token.

Real complete Git ancestry distinguishes equal, remote ahead, local ahead, diverged and changed remote default branch. Only remote ahead permits a fast-forward. Local ahead and divergence preserve every local commit; a changed remote default does not switch the local branch. The installed tip is the original remote SHA. Synchronization does not create a synthetic code commit, push to GitHub, or promise that the observed remote tip is still current after the fetch.

Existing workspaces retain their fixed inputs. A successful fast-forward atomically publishes the SQL baseline and one durable project event. Subsequent runs use the new baseline; queued integrations with stale targets become stale, and checked candidates must satisfy current-target gates again. Coordination context includes the latest sync ID alongside the current/workspace SHAs. No notice instructs an AI to silently rebase its workspace.

## Admission and target occupancy

Migration 023 stores the immutable request, actor, original organization/project authorization versions, installation version, stable repository ID and original local branch/SHA. All paths acquire integration dispatch lock 82467116 before organization locks. Admission excludes nonterminal promotions and integrating/checking/unknown integrations on that target. A promotion admission trigger excludes nonterminal syncs; the shared kernel for old/new integration adapters excludes them too. Different repositories can still progress independently after the short admission transaction.

Pending, fetching, applying and blocked syncs occupy their target. A timed-out process or lost connection never releases an admitted effect. The administrator uses the request key to inspect the original operation; a new key cannot bypass an unresolved operation. A session advisory lock serializes execution/reconciliation of one operation. All post-admission SQL uses that pinned connection. Network work holds no SQL transaction. A process that loses that connection cannot reconnect and admit/apply an old request later.

Fetch/classification changes only the private staging graph. Local objects may be packed into staging to calculate real ancestry. Acknowledged durable `input` precedes any preparation receipt or target write. Preparation imports verified objects, checks full connectivity and fast-forward ancestry, and creates a once-only prepared receipt. The final short organization/MFA gate rechecks original authority, binding, enabled installation/version and SQL baseline, then holds those gates across the Git CAS and SQL settlement. Object packing and all provider requests precede that final gate.

## Git crash and concurrency protocol

The receipt ref `refs/pi-collab/syncs/<operation>` has deterministic prepared/applied/aborted commits binding operation, repository, branch, old/new SHA and observation time. Prepared/applied receipts keep the remote graph reachable. Only one ref is mutated per Git transaction:

1. Preparation creates a receipt only if absent.
2. Apply locks/verifies that prepared receipt and CAS-updates only the target from the frozen old SHA to the observed remote SHA.
3. Sealing locks/verifies the new target and changes only the receipt to applied.
4. Abort locks/verifies the observed target and creates/changes only the receipt to terminal aborted.

We do not claim that renaming multiple loose-ref lockfiles is crash-atomic. Terminal abort prevents both a late preparer from reopening the decision and a paused applier from passing its receipt verification. A prepared receipt plus the exact remote target proves the desired postcondition after a crash between steps 2 and 3. Recovery seals that observation; it never invokes apply again. Unexpected target values, corrupt receipts, symbolic refs or unverifiable graphs retain uncertainty/occupancy rather than resetting a branch.

Unlike promotion's unique synthetic commit, the original remote SHA cannot uniquely prove which process wrote it. The receipt/postcondition protocol depends on the platform's managed-writer exclusion. A hostile or manual writer using the same OS account can install the same SHA independently; native mode does not attribute such a write uniquely or isolate malicious same-account code. An absent receipt plus the remote SHA is insufficient and is blocked. Applied receipts record historical postconditions; a subsequently unexpected target still prevents SQL settlement. No ancestry heuristic adopts an unobserved newer remote commit.

Git processes use the existing sanitized environment, disabled hooks/helpers/recursive submodules and an owned process group. Pack pipes are bounded at 256 MiB and local Git phases at 120 seconds; provider transfer limits from ADR-027 still apply. These are operational limits, not hard OS memory/disk quotas or hardware power-loss acceptance.

## Recovery and observability

Same-key replay returns a completed result without HTTP. Abandoned pending/fetching requests with no durable effect can be failed without touching the managed branch; staging directories are retained and never reused. Once input exists, reconciliation observes/seals an already-achieved target or terminally aborts the decision. Matching old SQL baseline plus applied exact Git target publishes the baseline/event once; matching old target plus aborted receipt releases occupancy. Any mismatch remains blocked.

A different current Maintainer with MFA can explicitly reconcile an operation by ID and reason, including after the original actor or installation is revoked. Reconciliation does not need a provider token/master key and cannot fetch/reapply a target. It records the current acting identity and original requester. This closes revoked work without granting new remote authority. There is no blind force-release or automatic branch repair endpoint.

The project API exposes the last 20 scoped status/branch/SHA records, and the browser distinguishes unchanged, fast-forward, local ahead, divergence, branch change and unresolved cases. Private credentials are not selected. RLS and roles deny direct state mutations by Web/executors. CLI submission remains an interim integration; the plan still requires a dedicated Git broker and authorized Web orchestration.

## Validation

Tests use generated RSA keys, localhost smart HTTP backed by real `git http-backend`, and isolated PostgreSQL. They cover real ancestry classification, exact SHA preservation, request concurrency, permission/MFA, frozen workspace input, baseline event replay, shared promotion/integration occupancy, abort-versus-late-writer races, interrupted receipt sealing, actual database backend termination, and a TCP proxy dropping the final COMMIT acknowledgement. A different maintainer reconciles a revoked request. Unexpected external target values stay occupied. No personal credentials, external inference or remote writes are used.

The isolated browser flow reads the same sync record from two authenticated contexts, selects the updated repository baseline, checks refresh/installation-disable persistence, and captures desktop/mobile layouts. It is protocol evidence, not an external GitHub App/account or Docker acceptance claim.

References: [ADR-024](0024-durable-local-promotions.md), [ADR-027](0027-managed-github-imports.md), `tests/collab/github-sync-git.test.ts`, `github-sync.test.ts`, and `promotions.test.ts`.
