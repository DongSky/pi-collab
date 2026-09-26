# ADR-035: Exact task-branch receive-pack with remote compare-and-swap

Status: internal protocol foundation implemented and tested against disposable real Git HTTP servers. [ADR-036](0036-task-push-history-exports.md) adds immutable native exports and complete new-history checks. There is no production push endpoint, GitHub write credential, durable push queue, PR or CI integration in this increment. This does not complete M3-01 or development-plan §7.2. Native remains the default; no Docker dependency is introduced.

## A generated branch and one exact mutation

The server derives the branch as `refs/heads/pi-collab/tasks/<task UUID>/workspaces/<workspace UUID>`. Each independent workspace has its own branch, including a new run after handoff. Subsequent publication from the same workspace may fast-forward that branch. The caller supplies no branch name, remote URL, refspec, force option or delete operation. An internal intent binds the durable operation, local repository identity, task, workspace, expected old commit (or absent ref), and new commit.

`PreparedTaskPush.prepare` requires a trusted, broker-owned, immutable bare SHA-1 repository. It rejects shallow/grafted/shared/alternate/symlink metadata, verifies Git objects, disables replace objects and commit-graph acceleration, checks commit types and requires the expected old commit to be an ancestor of the new commit. Source metadata remains subject to the trusted native host boundary: a same-user hostile process is not isolated by these checks. The future broker must exclude platform writers and construct the source separately from the agent's mutable checkout.

Preparation makes a bounded, non-thin pack of exactly the new commit's reachable closure minus the expected old commit's closure. It never packs all refs, executes a hook, reads a configured remote or obtains credentials. The request contains exactly one receive-pack command with the expected old SHA, desired new SHA and generated ref, followed by the pack. A frozen attempt records the request size, request/pack SHA-256 and full intent. Changes to a local branch after preparation cannot change those bytes.

The complete packet is already prepared before the authority callback. Preflight inspects the fixed repository's advertisement, requires SHA-1 and `report-status`, and compares the exact old ref. The mandatory final callback must persist the exact attempt and revalidate current authority before returning true. After that, only one receive request is sent. Git performs the old-value check and ref update atomically on the remote; two different commits competing from the same old SHA cannot both succeed. No client-side check or database lock substitutes for this remote condition.

## Acknowledgement is separate from later observation

The parser accepts only a complete protocol-v0 report containing `unpack ok`, an `ok` for the exact generated ref, and its final flush. Complete `ng` reports return a sanitized rejection reason. Malformed, truncated, oversized, redirected, mismatched, failed or cancelled responses after dispatch remain `unknown`; raw remote errors are never returned. The same prepared object cannot send a second time, including after a lost reply. This in-memory guard is **not durable idempotency**: the future database broker must prevent reconstruction and replay of unknown attempts.

`observeTaskPush` reads only a receive-pack advertisement and returns `at_expected`, `at_desired` or `changed`, the observed SHA and a response hash. It does not declare a job applied or aborted, attribute a write to a particular actor, or release a lease. A remote request may remain queued after the client disconnects: an observation of the old SHA can be followed by that original request applying later. The tests reproduce this with a real delayed receive, rather than assuming disconnection cancels the server.

Even seeing the desired SHA is current-state evidence, not proof of attribution or absence of a later external force update. Unknown-job settlement needs an explicit policy for remote in-flight effects and external branch changes. Reconciliation must never simply send the original push again. Local SQL transaction success, process exit and HTTP acknowledgement remain distinct facts.

## Bounds and integration gates

Preparation and sending each have a 180-second deadline; read-only observation has a 30-second deadline. The pack is bounded to 64 MiB, advertisements to 4 MiB/50,000 pkt-lines, and reports to 64 KiB. The protocol deliberately does not request sideband, report-status-v2, atomic multi-ref updates, push options, deletion or SHA-256 objects. An unsupported server fails before a write.

Before any browser or AI can publish through this foundation, implement all of the following:

1. Bind [ADR-036](0036-task-push-history-exports.md)'s immutable export and complete new-history checks to current SQL authority and authenticated remote baseline evidence. A clean final diff is not sufficient, and this protocol module alone is not a disclosure scanner.
2. Bind a current GitHub App installation and stable remote repository ID to the local repository. Revalidate rename/transfer/suspension/access and reject a generated ref if it is now the default, integration target or a protected destination. Require the provider's ordinary direct-branch semantics: an arbitrary Git server can have symbolic branch aliases that receive-pack advertisement alone cannot reliably identify. Add one-repository write tokens held only by the broker, exact-route transport, independent revocation and rotation/delegation rules. Existing GitHub read capabilities remain read-only.
3. Add a new migration **027 or later** for durable admission, member/MFA/task/source/binding versions, immutable confirmation, queue occupancy, audit and final dispatch authority. Migrations 001–026 are immutable. The final callback must record the exact request hash and unknown-effect boundary before network dispatch; a thrown/uncertain SQL response must not send.
4. Persist the original outcome and distinguish rejected, acknowledged and unknown sends; design late-remote handling and explicit administrator disposition before releasing unknown jobs. Add quota/cancellation/revocation and crash/SQL-response-loss tests across broker processes.
5. Expose a reviewed browser workflow and verify multi-member retries, stale confirmations, permission changes and actual Git effects. Then implement PR creation, signed/deduplicated webhooks, exact-SHA CI evidence and protected remote merging. A successful task push grants no merge permission and advances no local integration baseline.

This foundation introduces no service startup change or schema change. It has no callable production route. It accepts a trusted fixed-repository transport for testing and later integration; it must not be wrapped around a user-supplied URL or arbitrary write token.

## Evidence

`tests/collab/task-push-protocol.test.ts` uses real Git repositories and `git http-backend` on disposable loopback ports. It verifies branch creation and exact history, fast-forward updates, actual concurrent receive CAS, stale preflight, denied/failed final authority, cancellation, a committed push with its response dropped, a late receive applying after an old-state observation, immutable prepared bytes, an empty remote, unsafe metadata/corrupt objects, invalid intents/object types, unsupported advertisements and untrusted result bodies. No personal Git configuration, credentials, external account or model inference is involved.

References: [ADR-025](0025-github-installation-observations.md), [ADR-033](0033-workspace-git-broker.md), [ADR-034](0034-browser-workspace-git.md).
