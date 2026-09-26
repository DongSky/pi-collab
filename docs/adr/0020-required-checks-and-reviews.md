# ADR-020: Required integration checks and version-bound human reviews

Status: native implementation; extends ADR-019 with policy and review evidence. No Git ref update is authorized or performed. Docker remains optional and has no validated integration executor yet.

## Required checks

A project Maintainer publishes an immutable policy revision for an imported repository's default target branch. It selects one immutable validation profile (all of its 1–5 Node/npm steps are mandatory), 1–3 independent approvals, whether the Reviewer role counts toward the approval threshold, and a reason. Organization administrators must retain MFA. Project scope, optimistic version checks, an organization transaction lock and payload-bound idempotency are enforced in SQL. There is no bypass/disable switch or self-approval exception.

Each integration admission sends the policy ID observed by its caller, or null when none exists. A changed policy returns a conflict rather than silently using a different rule. An insert trigger pins the policy and includes its immutable ID in the input hash. The supplied profile must match the policy. Existing no-policy previews remain available as historical previews, but cannot receive formal reviews or satisfy review conditions. Publishing a first policy requires creating new integrations.

Policy changes invalidate queued, executing and completed integrations. Heartbeats stop obsolete checks; completion rechecks policy under the same authority lock. New policy versions never retag old results. Idempotent retries return the original candidate or policy even after newer revisions exist; they do not reactivate it.

Migration 017 wraps the prior admission function as a private helper and replaces the current-input predicate. Prior app access to that helper is revoked. The existing executor protocol remains compatible because the selected required profile already contains every mandatory step and migration 016's finalizer checks exact step identity, count, success, source stability and process cleanup. A worker cannot certify a subset of the required checks.

## Review identity and authority

A review applies to one checked integration. Its revision hash binds the candidate input hash, policy ID, target SHA, Git candidate commit, checked snapshot manifest hash and checked worktree commit. The input hash already binds the complete result dependency closure, merge order and immutable check configuration. This preserves the distinction between the Git candidate and the actual checked snapshot: excluded paths remain outside the checks, even when review conditions are satisfied.

Maintainers, Developers and Reviewers may submit `approve`, `request_changes` or `withdraw`, with a note. Viewers cannot submit reviews. The integration requester, every source-run requester and every source-result publisher are excluded from approval, including dependency sources. These are recorded platform identities, not inferred Git commit authors. These contributors may still request changes or withdraw their own prior decision. AI coordination capabilities do not grant review authority.

Records are append-only. Each reviewer has a monotonically increasing version per integration; two browser windows cannot overwrite the same version. Retries retain the original payload and idempotency key. A distinct new decision replaces that reviewer's effective decision while retaining history. Notes render as text. The detail endpoint includes the pinned policy/configuration and latest 100 historical review entries; the database retains all entries.

An approval counts only while its author remains an active eligible member with exactly the organization and project authorization versions recorded at submission. Revocation, role changes and regrant do not revive an approval. Existing administrator MFA protection prevents disabling MFA while the role requires it. Reviewer approval counting follows the pinned policy. At least the policy's distinct eligible reviewer count is required.

An outstanding `request_changes` blocks even if that reviewer loses access. Removing someone must not erase their objection. Only a new decision by the same currently authorized reviewer, or a new candidate with a fresh review process, resolves this state. There is no Maintainer dismissal override in this increment; a departed reviewer may require a fresh integration. `withdraw` removes only that reviewer's effective decision.

## What the condition means

`reviewSatisfied` requires a checked integration, current requester authority and inputs, the current pinned policy, enough eligible approvals and no outstanding change requests. It is a current read result, not a durable permission or a merge token. The UI says “检查与评审条件已满足 · 等待后续合并流程”. Consumers must never use a previous response to authorize a later Git side effect.

Required next work includes a transactional promotion protocol that rechecks all conditions, exact expected target SHA and permissions, reconciles uncertain Git ref writes, and settles the candidate-versus-checked-tree exclusion policy. ADR-021 adds fixed code/diff browsing. Remote PR/CI/webhooks, conflict-resolution tasks, reviewer assignment, review comments/discussions, automated coverage of contracts, policy path scopes and branch-management UI remain outside this increment. A per-repository policy for the imported default branch is not yet a general branch-protection system.

## Evidence and deployment

The default remains `npm run dev:local` without Docker. Apply migration 017 and restart web/executor after stopping any owned active work; earlier migrations remain immutable. Browser sessions using an old admission payload receive a policy conflict when a policy is configured and should reload. Migration tests use disposable databases; browser tests run a separate source copy and `.next` directory.

The integration suite exercises real PostgreSQL, Git, native Pi diagnostics and supervised Node checks. New cases cover required-step enforcement through the existing worker, immutable scoped policies, replay and concurrent publication, contributor rejection, exact revision binding, concurrent review updates, revoked/regranted authorities, persistent objections, policy-controlled Reviewer counting, target/source invalidation and a real running check stopped after a policy change. No external model inference is performed.

Browser acceptance covers Maintainer policy configuration, authorization/Origin checks, two actual required commands, self-approval refusal, lost review response retry, another user's live observation, stale edits across two independent sessions for the same reviewer, policy invalidation and desktop/390px layouts. Evidence screenshots: `test-results/collab/integration-reviews*.png`.
