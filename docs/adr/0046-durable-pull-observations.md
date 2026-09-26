# ADR-046: Explicit, durable observations of attributed pull requests

Status: implemented in migration 032, the native Git service and browser; final verification and local deployment are recorded in the implementation status. Complete code revisions, webhooks, CI and protected merge remain separate work.

## Identity and current authority

Only a positively acknowledged creation registered in `pull_changes` can be refreshed. The source includes its stable repository ID, PR ID, node ID and number, current verified binding, and current installation/binding versions. A body marker, a matching branch, a pre-existing PR or an unknown creation cannot enter this flow. A missing or inaccessible provider response is a failed read, never proof of deletion or closure.

The current task owner with Developer permission or a project Maintainer can request a read, subject to organization MFA policy. Project readers can inspect saved evidence. New requests use current task/member authority, independently of the original creator's now-spent grant: a creator leaving a team must not make its existing PR impossible to inspect. Each admitted read captures authorization versions and must retain them until publication; regrant does not revive it.

The client cannot submit a provider URL, PR number or source/target SHA. A request includes the expected task version, current observation version and idempotency key. Exact replay returns the original job before credentials. One active reader per change and at most 20 active readers per project prevent competing publications. The current binding is checked again before publication.

## Read-only provider protocol

The observer requests a single-repository token with `contents: read` and `pull_requests: read`. A read-only installation is sufficient. It verifies installation and repository identity/visibility before and after the fixed PR GET, verifies the PR's identity and both repository sides, and revokes the token independently of cancellation. No create, edit, review, merge, listing/adoption or Git receive operation is exposed.

The response may legitimately show changed refs, source/target SHA, title/body hashes, draft/open/closed/merged state or maintainer editing permission. A closed PR can retain its head SHA after branch deletion, so observation does not require that branch still exist. The observed merge SHA is not CI or protected merge evidence; GitHub may return a temporary test merge SHA. Force-pushing back to an old commit is a new observation, not an older local publication.

The result contains bounded normalized provider evidence, observation/completion times, credential expiry and confirmed cleanup. Failed reads or unconfirmed cleanup do not advance the latest successful pointer. Existing creation receipts remain unchanged. This policy does not imply a failed read proves the PR has not changed.

## Ownership and ordering

Each job has one SQL connection, backend PID, advisory lock and nonce. Live authority monitoring runs every 500 ms and bounds a silent SQL reply at two seconds. Current task, user, binding, installation and observation-version rows are locked for final publication. SQL checks exact identities, scope, snapshot types, branch syntax, fresh times and cleanup evidence independently.

One transaction appends the exact observation text and its SHA-256, increments the local observation version, and advances the latest pointer. A dropped COMMIT reply is resolved by reading that original job; a second worker cannot repeat the provider request. Loss of the owner before publication fails the abandoned read and preserves all earlier history. Cancellation likewise leaves the current pointer unchanged. A user can explicitly submit a new read after a terminal failure.

Local sequence numbers order successful platform observations; they do not claim an external GitHub causal clock. Provider `updated_at` is informational. Future webhook payloads must trigger a fresh scoped observation, not overwrite this pointer with potentially reordered event data.

Read jobs do not occupy or mutate task heads. Pushes or external writers can move a branch during or after observation. These records preserve what the provider returned at the recorded time; they do not certify a stable combined code revision.

## Browser and deployment

The browser separates refreshing saved records from explicitly reading GitHub. Its periodic polling reads only PostgreSQL. It displays the latest successful snapshot with its time, up to 20 recent jobs, actor attribution, immutable evidence hashes, failed/cancelled states and same-key retry after response loss or reload. A recent failed read marks the preserved snapshot as possibly stale. Mutations require same origin and current scoped authority.

Apply migration 032 and gracefully replace the existing Git service. Eight processors share the same two lanes; native remains the default without Docker. When launched by `dev:local`, replace the complete supervised stack and reuse separately owned healthy PostgreSQL. Migration creates no automatic observations and preserves all initial creation evidence. Migration 032 has been applied to the local main database and all 32 migration hashes match their source files. Migrations 001–032 are immutable; subsequent schema corrections require a new migration.

## Verification and remaining delivery work

Acceptance uses generated credentials, native PostgreSQL/Pi/Git and loopback REST/TCP, including concurrent requests, current authority after original-author departure, changed/deleted refs, invalid/missing provider responses, cleanup failure, forged SQL evidence, cancellation, actual SQL disconnects, dropped COMMIT responses, silent SQL and separate broker SIGKILL. Upgrade verification applies 032 transactionally to existing creation records. Browser acceptance covers two members, actual response loss/reload, ordered history, failure preservation, cancellation, roles/CSRF and desktop/mobile layouts.

The final native collaboration suite passed 479/479, the focused observation suite passed 14/14, and the complete isolated browser regression passed. After the local main upgrade, the four-account smoke and typecheck passed; lint also passed.

These are metadata observations, not the planned full `ChangeRequestRevision`: complete Git object acquisition, merge-base/diff hashing and code browsing still need implementation. No timer-based remote monitoring, signed webhook, trusted CI producer, remote review or protected merge is enabled by this change. Real GitHub accounts, model inference and Docker parity remain separately unverified.
