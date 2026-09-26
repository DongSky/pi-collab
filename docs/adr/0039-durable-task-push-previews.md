# ADR-039: Durable read-only task push preparation

Status: accepted for the native Git service. Browser history confirmation and remote write dispatch remain outstanding.

## Admission and source ownership

Migration 027 introduces private `collab_git.push_previews` records. A request contains only the reviewed source revision, HEAD, run revision and idempotency key. SQL resolves the run, task, workspace, repository, installation and binding; the caller supplies no identity, path, remote URL, baseline, expected-old ref or credential. The current task-owning Developer or a Maintainer may request/cancel a preview, subject to organizational MFA requirements. Reading completed metadata requires current project access.

Admission fixes organizational and project authorization versions, task/run versions, the stopped native source identity, installation version and a new monotonic repository-binding version. Every binding update increments that version, including refreshed synchronization evidence. The installation version remains distinct: the legacy sync adapter now names `installation_version` explicitly rather than relying on overlapping selected column names.

The request generates a unique export/preview ID and reserves an independent operation ID for possible later dispatch. Reserving that ID grants no write capability. The binding pins stable remote IDs, identity/visibility/default branch and all known integration-policy branch names. Unknown visibility, inactive/mismatched installations and unsupported binding state are refused.

An organization serialization lock, one-active-preview index and source-operation triggers exclude pending/running previews, unfinished workspace Git operations and pending snapshots from one another. Both orders of admission and actual concurrent requests are tested. The existing workspace Git state reports preview occupancy so its controls cannot claim the source is available. Ready/failed/cancelled previews release this read phase's source occupancy. Later source edits do not mutate the immutable export.

Requests deduplicate by run, actor and UUID with exact payload equality, before any key lookup or provider request. A different payload under the same key is refused. Current authority is still required to replay a request. Each project supports at most 20 queued/running previews, and listing returns the most recent 50 records for a run. Artifact retention and cumulative storage quotas remain separate unfinished work.

## Restricted reader and continuous authority

The native Git daemon schedules previews with workspace Git operations, import and sync using the same two execution lanes. Only the dedicated Git database role can claim/start/finish them. That role cannot directly read/write the private tables or list arbitrary credentials; the Web, executor, model gateway and resource broker cannot claim previews.

A claim fixes a random nonce and SQL backend PID while holding a session advisory lock. `begin_push_preview` rechecks the original authority/binding/source and records the single read attempt before exposing that installation's sealed key. It cannot be called again for the same attempt. Queued cancellation or stale authorization fails before reading the master key. The key buffer is wiped after App-key opening; the provider path remains ADR-038's one-repository read token and upload-pack only.

Network transfer and export do not hold a long authorization transaction. During preparation, the service checks the claim and current authority every 500 ms using its pinned connection. Each ownership query has an independent two-second local deadline; a silent SQL socket aborts the provider/Git read and is discarded. It is never reconnected to continue or publish that attempt. Independent provider-token cleanup still runs. These bounds assume a functioning local event loop; they are not hardware or load-test evidence.

The monitor is fully joined before publication. The final transaction reacquires the organization, member/MFA, task, run, workspace, binding and installation checks. Task-owner changes cannot cross that transaction before its evidence commits. A later authorization change does not erase historical preview records, and a ready preview must never be treated as current push authorization.

## Evidence publication

Before SQL settlement, the broker reopens the original export using its expected manifest hash and verifies its Git objects. It compares the recovered manifest and admitted input with the result it is publishing. SQL receives the exact serialized observation and manifest bytes, independently computes their SHA-256 values and checks the manifest hash, source/operation/export identities, generated ref, remote baseline and expected-old SHA, repository identity/visibility, installation IDs, read-only capabilities, token revocation, policy and bounded commit/object counts.

The database stores the complete observation, manifest and their authoritative hashes together with `ready` and an append-only audit entry in one transaction. It does not accept a file's own hash as authority, invent missing files, or rebuild an export from the mutable source. Provider observations and Git object validation are the trusted reader's responsibility; SQL hash checks bind those results, not independently prove remote state or reimplement the Git scanner.

Status is `queued`, `running`, `ready`, `failed` or `cancelled`. Public metadata contains no private key, token, SQL nonce/backend PID, host path or raw provider body. The detail function provides scoped destination/observation, commit identities and policy metadata for future review; it is not the complete outgoing-history browser UI.

## Interrupted reads and lost acknowledgements

This phase cannot perform receive-pack or update any shared source/baseline. If a running claim loses its SQL session, another service claim marks it failed with `task_push_preview_reader_lost`. The old claim cannot publish. Any late local read or export can only affect that request's unique private artifact directories. Releasing this read-phase occupancy does not permit an old remote write, because there is no such capability in this phase.

The failed request and partial/completed private artifacts remain identifiable by the original ID. A user must explicitly request a new preview with a new key/ID; the original request is not downloaded again and incomplete directories are not reused or deleted. No unverified orphan artifact is promoted to ready by recovery.

If the final COMMIT succeeded but its response was lost, a later same-key request reads the already-ready record. If it did not commit, the original reader is failed after its connection is gone. Neither case mints another token or repeats capture under the old ID. This behavior is tested with actual SQL-backend termination and a TCP proxy that discards the final COMMIT reply.

**Remote push has a different uncertainty boundary.** Once receive may have begun, an unknown result must retain destination occupancy; current ref observations, token expiry or this reader-recovery rule cannot prove a late write will not apply. ADR-035/037 remain mandatory for the future dispatch queue.

## Integration and remaining work

Apply migration 027 before using the updated Web Git-state query and restarting the native Git service. It has been applied to the local main database and is now immutable; further changes require later migrations. Native Node/Git/PostgreSQL remain the default. No Docker image, personal credential, external model or real GitHub account is required for local acceptance.

This increment provides persistent application functions and a production service handler, but no new HTTP preview endpoint or browser button. Next work must implement full outgoing-history browsing and explicit confirmation, persist the confirmed export/destination and one-owner dispatch queue, record final exact-byte authority before receive, preserve uncertain remote effects, and then add PR/CI/webhook/protected-merge delivery. Real GitHub-account and optional Docker parity acceptance remain outstanding.

Evidence: `tests/collab/push-preview-broker.test.ts` uses real PostgreSQL roles, generated accounts/App keys, actual native Pi commits and real loopback REST/Git transfer. It covers deduplication, authorization/MFA/scope, bidirectional and concurrent source exclusion, role/claim restrictions, cancellation, binding/authorization changes, artifact/SQL hash rejection, live revocation, silent SQL ownership, lost backend, publication locks and actual COMMIT-response loss. Existing read/export/protocol suites and browser regressions remain independently required.

Validation for this increment: 14/14 preview-broker tests, 388/388 collaboration tests, TypeScript and full lint passed. The isolated browser regression and four-session local smoke passed after migration 027; the main native Git service was restarted with one instance. Browser results cover existing flows; no outgoing-history or push button is introduced here.
