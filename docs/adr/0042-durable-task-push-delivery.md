# ADR-042: Explicit durable task-branch delivery

Status: implemented for the native backend; external-account and full platform acceptance remain pending. Extends ADR-041 without automatically dispatching any existing confirmation.

## One job, one immutable request

Migration 029 admits a separate, explicit human send request. It names the confirmation and its authoritative manifest hash and requires `acknowledgePush: true`. Only the current task-owning Developer or a Maintainer may request it, subject to organization MFA rules. SQL fixes both the original confirmer's and dispatcher's authorization versions. Revocation followed by regrant never renews either grant.

Each preview/export can have exactly one delivery job, using the operation UUID already in its immutable manifest. Its actor-scoped idempotency key resolves before filesystem or credential access. A new key, different member, different confirmation or daemon restart cannot create a second job for that export. A delivery-owned confirmation cannot be withdrawn, including after a terminal or quarantined result. A known terminal result requires a deliberately new preview and confirmation for any later operation.

The Git service adds a fifth processor to the same two shared lanes. No extra daemon, Docker requirement, source checkout writer or change to the shared baseline is introduced. The browser persists the exact request in session storage before transmission; response loss/reload permits only same-request retry. Project readers can inspect the same durable result, while controls use current task authority.

## Final gate and remote effect

The broker holds one PostgreSQL connection and a session advisory lock with a fresh nonce. It independently verifies the export against SQL's manifest hash and prepares its exact immutable pack/request bytes before opening an installation key. The prepared intent must equal the SQL claim. SQL persists the request/pack SHA-256, size, task/workspace/repository/operation, expected-old SHA and new SHA before returning the sealed key.

A 500 ms monitor checks this same connection and both grants during preparation and provider preflight, with a separate two-second local query deadline. It never reconnects an attempt. The monitor is stopped and joined before the gate transaction, so it cannot interleave queries into that transaction.

The provider client requests a short-lived single-repository `contents: write` token. After the Git advertisement it again verifies installation identity, repository identity/visibility, branch protection, active rules, default branch and current task ref. The final SQL gate locks current authority and compares this observation with the confirmed destination, including the unchanged confirmed default SHA. SQL hashes the exact serialized observation independently and rejects evidence older than 30 seconds or more than five seconds in the future. The prepared attempt must match exactly.

Only a **positively acknowledged COMMIT** of this gate permits the one receive-pack request. A dropped gate COMMIT acknowledgement sends nothing and discards the connection. Even though no request was sent in that case, recovery conservatively retains unknown because the surviving SQL record cannot distinguish this from a crash immediately after dispatch. No SQL transaction is held across remote HTTP.

The gate is the last local authorization boundary. Cancellation or revocation after it cannot promise to retract a remote effect. The remote server still enforces expected-old-SHA comparison. Protocol outcome and token cleanup are recorded independently; cleanup failure never erases an acknowledgement or an unknown Git result. A live broker may record positive `not_sent` evidence when it knows its receive capability was never invoked. Recovery cannot infer that fact from a current remote SHA or token expiration.

## Recovery and permanent fencing

States are `queued`, `running`, `acknowledged`, `rejected`, `not_sent`, `unknown`, and `retired`. Orphan claims with no persisted gate become `not_sent`; those with a gate become `unknown`. Neither is reclaimed for execution. Known acknowledged/rejected/not-sent results consume the confirmation and release its destination. Unknown retains the global GitHub repository-ID/ref reservation.

An organization Owner/Admin who is also a project Maintainer and has MFA may explicitly retire an unknown job, supplying a reason of at least 20 characters and acknowledging that its effect remains unknown. This quarantines the old destination **permanently** through the same global unique index. Retirement is not a declaration that Git failed, a release operation, or qualification for future PR/merge. Continue in a new workspace with a new generated task ref. A late old receive can still apply to the fenced old branch; that cannot interfere with a new platform job for it because no such job is allowed.

Current-old SHA, desired SHA, token revocation/expiration, lost local artifacts and member changes do not establish remote settlement or attribution. Browser text makes this explicit. A crashed process can leave token cleanup unrecorded; the UI does not claim revocation or invent an expiry in that case. Administrative actions and gates/results append audit events. No raw credential or remote response body is returned to the browser.

## Boundaries and verification

This feature sends confirmed complete history to generated task branches only. It does not push default/integration branches, bypass protections, grant mergeability, open PRs, attest CI, or claim sensitive-byte detection is exhaustive. The native trust boundary and complete-history attestation limits in ADR-040/041 remain. Docker is optional and needs separate parity verification.

Acceptance uses actual PostgreSQL, native Pi tool commits, immutable exports, generated App credentials, loopback REST and a real Git HTTP receiver. Cases include concurrent requests/owners, both human grants, SQL payload/role/nonce restrictions, corrupt exports, stale baselines/rules, exact gate evidence and receipt validation, cancellation, independent credential cleanup, actual gate/settlement COMMIT-response loss, SQL owner loss, separate broker SIGKILL and delayed remote application after an old-SHA observation. The browser exercises same-request retry/reload, peer status, cancellation, acknowledged/unknown delivery, permanent retirement authority, CSRF and desktop/mobile rendering. These fixtures make no external-account or model-inference claim. Final run evidence is recorded in the implementation status document.

Final acceptance: **418/418** collaboration tests, typecheck, lint, full isolated browser regression and main four-account smoke passed. An initial concurrent full run had one unrecorded unknown in the existing validation group and six cascading admission failures; the group passed 10/10 independently and the complete run passed when repeated separately. No validator logic or assertion was relaxed; the unreproduced first failure is retained in the implementation status. The separate broker kill test also covers after the remote receive. Desktop and 390px screenshots were inspected. Migration 029 is now applied to the main local database and immutable; the sole native Git service was gracefully restarted with five processors and shared capacity two. No `next build`, Docker, personal credential, external account or model inference was used.
