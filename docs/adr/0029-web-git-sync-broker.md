# ADR-029: Browser-authorized sync runs in a dedicated native Git broker

Status: implemented with migration 024; external GitHub accounts and Docker parity remain open.

## User flow and scope

Project Maintainers with MFA can submit a GitHub sync, request cancellation, or reconcile an uncertain operation from the browser. Sync submission confirms the exact displayed local SHA/branch, the reason and permission to fast-forward to a verified remote commit. A stale view cannot silently authorize a different local baseline. Responses are durable admissions, not claims that Git has already run. Same-origin protection, resource-scoped authorization, request idempotency and lost-response retry apply to both submission and actions.

The existing classification, remote read limits, original SHA preservation and Git decision protocol from ADR-028 remain authoritative. This increment handles existing-repository sync and reconciliation. App registration, binding and new-repository import still use explicit local administration. It does not implement push, PR, CI/webhooks, credential rotation, new-repository Web import or the entire Git broker roadmap.

Follow-up: [ADR-030](0030-web-github-imports.md) adds new-repository Web import and recovery to the same restricted native service. The scope described above records the migration 024 increment.

## Process and database authority

The default native development launcher starts a separate Git broker alongside Web, executor, model gateway and resource broker. Its environment contains only its own `pi_collab_git` connection URL, data-root/path/locale settings; it does not receive an administrator password, Web authentication secret, model credential, resource credential or personal HOME. The standalone development launcher reads local configuration in a parent and starts the same restricted child. The production service requires explicit role/key configuration. The service does not create a missing Git master key.

Migration 024 grants the Git role only schema usage and seven narrow procedures: claim, begin, admit effect, final gate, reconciliation gate, finish and fail. It cannot select private credential tables, user/auth tables or arbitrary project state, change repository rows directly, or call other worker/broker authority helpers. Web, model/resource brokers and executors cannot call Git procedures or read Git credentials. Only `begin_sync` for an owned, current, authorized pending job returns that job's encrypted App key and installation identity. Master-key loading is lazy; reconciliation needs neither provider credentials nor network access. The returned owned key buffer is wiped after decrypting the App key.

These are code/process/SQL authority boundaries for trusted native services. Services currently share the local OS account; this does not isolate malicious same-account code or prevent a host administrator reading files. The Git broker is a trusted credential holder and trusted reporter of inspected Git state, not an untrusted-agent interface. Receipt validation does not prove that a malicious broker honestly inspected disk. Docker/OS-account separation and adversarial resource quotas remain distinct work.

## Queue ownership and interruption

Web admission uses the same dispatch-then-organization lock order and target occupancy as CLI sync, integration and promotion. Up to 20 unfinished syncs may exist per project. The native process has two execution lanes. A private dispatch row records queued/running/attention/done, sync/reconcile mode, the acting identity and frozen authority versions, cancellation, a fresh random claim ID and the owning SQL backend PID.

A claim takes the existing operation session advisory lock on one pinned SQL connection. The random claim ID plus backend PID fence every callback, including callbacks on another connection or after PID reuse. Network waits hold no SQL transaction. A live legacy CLI/service session cannot be commandeered. A database trigger also rejects an old CLI updating a row that has been transferred to broker ownership. Terminal observations can still be read; legacy CLI requests do not acquire broker control merely by repeating a key.

When a running dispatch row's session lock becomes free, another service detects that the original database session ended. It changes dispatch state to attention and audits the loss. It does not refetch, prepare or apply that operation. Occupancy remains until an explicit current Maintainer/MFA action queues reconciliation. There is no lease-expiry retry of a possible Git effect. Pinned connections are closed after each attempt so session locks cannot escape into unrelated pool work.

Reconciliation of an old CLI operation can transfer it to the broker only while the original session lock is free. A current maintainer may take over a revoked original request; that new action's authority versions are frozen and checked again at execution. Recovery observes/seals an achieved target or closes the Git decision, never reissues target application. Pending/fetching work without an effect intent can be terminally failed without reusing its staging directory.

## Final gate and cancellation

The final transaction locks organization authority, MFA enrollment and the owned dispatch row. It rechecks the original requester, binding/installation version, current local SHA/branch and cancellation. SQL records the transaction ID and gate kind. `finish_sync` requires a gate from that same transaction, not an earlier autocommit or forged client flag, and validates the exact deterministic Git receipt OID and target before publishing the baseline event. An explicit reconciliation gate permits recording an already-achieved effect after original authority changes. A failed apply gate permits only terminal closure, not an applied outcome.

Cancellation is a durable stop request. Before effect admission it prevents credential access or branch updates, depending on when it arrives. During bounded provider reads it may wait for that read/cleanup to finish; no immediate remote cancellation is promised. After intent admission but before the final gate, it writes the terminal abort fence. An action arriving after the final gate waits for its authority locks: it cannot retroactively undo a completed target update. The page describes confirmed results rather than promising cancellation always prevents an already-started effect.

Provider errors or lost acknowledgements are never raw browser/log content. A known pre-effect failure closes the request. Possible effects retain blocked/attention state. SQL COMMIT loss is recovered by inspecting durable state on a later attempt, not by retrying the Git write. A completed row yields one event and is not dispatched again.

## Verification

Dedicated-role tests verify scoped/MFA admission, stale baseline refusal, immutable retry payloads, credential/schema isolation, concurrent claim exclusion, backend/claim fencing, queued and in-flight cancellation, permission regrant/installation disable, same-transaction gates, invalid observations, actual backend termination, credential-free takeover and a TCP proxy dropping the final COMMIT acknowledgement. Existing CLI, import, promotion and integration tests remain applicable.

The browser flow submits and retries a lost admission response, drives a separate process using the Git role, kills it with SIGKILL after the real Git target CAS, observes attention, submits/retries reconciliation, and sees the new baseline in another authenticated browser. It also cancels a queued job and checks desktop/mobile layouts. Generated fixture keys and localhost smart HTTP are used; no personal credentials, external model, remote push or actual GitHub account is involved.

References: [ADR-028](0028-native-github-sync.md), `db/migrations/024-git-sync-broker.sql`, `lib/collab/git/sync-broker.ts`, and `tests/collab/github-sync-broker.test.ts`.
