# ADR-027: Managed native GitHub imports retain original Git history

Status: implemented with migration 022; external GitHub account and Docker acceptance remain open.

## Scope

An explicit local administrator command can now import a new GitHub repository directly into a project. It uses a registered App installation and an active project Maintainer with MFA. The existing local-import-plus-binding path remains available. Neither path grants push, PR or protected merge authority. Synchronizing an existing repository's remote target remains separate work, because it must coordinate with active local integration and promotion queues.

The import fetches the exact observed default branch and its full reachable Git history. It preserves the provider's original commit IDs, verifies the fetched tip against the observed SHA and runs strict object/connectivity checks. It does not create a synthetic source commit from an archive. Tags, other branches, Git LFS payloads and submodule repositories are not fetched; LFS pointers and submodule references remain in Git. An imported snapshot is not proof that the remote still has the same tip at the end of the operation.

## Credential and transport boundaries

The existing GitHub read client verifies stable App/installation/account/repository IDs and mints a single-repository, read-only token. Its trusted import callback receives an upload-pack capability, not the token or an arbitrary authenticated URL. Only canonical `https://github.com/<verified owner>/<verified name>.git` advertisement and upload-pack endpoints can be requested. Redirects are refused. Renamed/replaced paths cannot silently broaden a token restricted to the original repository ID.

Git talks to a short-lived loopback relay using an independently generated local capability. The relay checks Host, denies browser Origin and arbitrary paths/methods, and only forwards the two read protocol operations. Git receives neither App private material nor the GitHub token in argv, environment, configuration or diagnostics. Provider headers/bodies and raw Git stderr are not error messages. No remote helper, Git credential helper, project hook, checkout, submodule recursion or inherited personal Git configuration runs during import.

Git runs in an owned process group. Cancellation kills the group and checks that normal descendants have exited before a receipt can be published. Limits include a 180-second provider/transfer deadline, 60 seconds per upstream Git request, at most 16 relay requests, two simultaneous relay handlers, 4 MiB per request and 256 MiB total streamed response data. The receipt validator bounds the resulting repository at 50,000 filesystem entries and 512 MiB on disk. Native Git is not an adversarial-code sandbox or a hard CPU/memory/disk quota; platform resource quotas and Docker parity remain separate acceptance work.

The token is revoked with an independent cleanup deadline after the callback, including after cancellation or failure. A ready import receipt is written only after revocation succeeds. A crash before receiving/revoking a token can leave that provider token until expiry; no automatic token creation retry occurs.

## Durable admission and recovery

Migration 022 records the project, actor, exact organization/project authorization versions, installation version, request content, stable remote ID and a freshly allocated repository UUID before any download. RLS exposes scoped status; Web, executor and model/resource broker roles cannot mutate import state or read Git credentials. Concurrent requests share the same idempotency record. Active/completed imports reserve the remote ID; an already bound repository cannot gain an independent second target queue.

A session advisory lock on the import ID admits one administrator process. Network work holds no SQL transaction or organization lock. All later database operations use that same pinned connection: losing it aborts the transfer and prevents a late process from reconnecting to publish its result. Each import has an exclusive directory. Failed or abandoned imports never share/reuse that directory with a later request.

After Git has stopped, object/ref checks have passed and the token has been revoked, the importer writes and fsyncs an HMAC-authenticated receipt under the separate Git master key. The receipt binds the operation, repository, project, installation version and verified remote evidence. Settlement rechecks current authority against the original versions, then atomically registers the repository and binding, marks the import completed and appends its completion audit. Files are never deleted in response to an uncertain SQL acknowledgement.

Same-key retry behaves as follows:

- A live session lock returns busy; it cannot start a second download.
- A completed row returns the original repository identity, without any HTTP request.
- An abandoned fetching row with a complete valid receipt rechecks its private files, Git objects/ref/HEAD and original authority, then settles the same repository without network access.
- A missing/incomplete/tampered receipt or corrupt Git data fails the request. Revocation/regrant and changed installation versions also refuse publication. The directory stays retained; a new explicitly requested attempt gets a new repository UUID.
- Failed requests remain failed on replay. They do not silently retry a provider request or edit the old directory.

This recovery is safe without reusing or deleting a potentially late writer's directory. It does not certify arbitrary hostile descendants, replace backup/retention, or claim tested recovery from hardware power loss. Physical storage failure still requires object/backup checks.

## Evidence

Tests use generated App keys, an actual localhost HTTP protocol service running `git http-backend`, real Git/Pi processes and isolated PostgreSQL databases. They verify original commit/history preservation, private material separation, strict route scope, drift/redirect/size/cancellation failures, concurrent request admission, current authority, a real server-side database disconnect and a TCP proxy dropping the actual final COMMIT response. Corrupt receipt/pack and symlink cases cannot register repositories. A real native Pi starts a task from the imported commit without remote credentials.

The full browser harness imports real Git data through the same protocol fixture, checks two authenticated users' status visibility, selects the imported original SHA, checks administrator disable and history persistence, and inspects desktop/mobile layouts. These are local protocol acceptance tests, not an external GitHub App installation or remote account acceptance.

References: [ADR-025](0025-github-installation-observations.md), [Git smart HTTP protocol](https://git-scm.com/docs/http-protocol), and `tests/collab/github-import.test.ts` / `github-pack.test.ts`.
