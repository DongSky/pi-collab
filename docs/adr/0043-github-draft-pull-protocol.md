# ADR-043: Version-bound preparation and draft PR protocol

Status: internal provider capability implemented. Migration 029's acknowledged pushes are the intended source; this module alone cannot establish database authority or durable idempotency.

Subsequent implementation: [ADR-044](0044-durable-pull-proposals.md) adds durable read-only preparation and its browser UI; [ADR-045](0045-durable-draft-creation.md) adds explicit creation, shared head reservations and initial ChangeRequest observations. Full revisions, CI and merge integration remain pending; this provider capability still cannot be called directly by Web routes.

## Provider constraints verified against official contracts

The [create PR endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request) accepts a head branch and a base branch. It has no expected-head-SHA or expected-base-SHA condition. A local permission transaction cannot make PR creation atomic with remote branch movement. Creating a PR can trigger notifications. Draft availability depends on the repository/account plan; a rejection must not fall back to a non-draft PR.

The [get PR endpoint](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request) reports current head/base state. Its `mergeable` value and test `merge_commit_sha` are not CI or review attestations. The [comparison API](https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28#compare-two-commits) limits complete-comparison file results to 300, even with commit pagination. Future complete diff evidence must not interpret a truncated provider list as the whole change.

The official [GitHub OpenAPI description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json) was inspected on 2026-09-23, including creation parameters, response codes and PR schema. Production requests continue to explicitly use API version `2022-11-28`.

## Read-only preparation

`GitHubTaskPullClient.preview` receives only a fixed repository binding, task/workspace IDs and the expected source SHA. A future broker must derive those from a positively acknowledged delivery; unknown or retired sends cannot qualify. It requests a single-repository token with `contents: read` and `pull_requests: read`, observes the generated task ref and the current default baseline, checks for existing open PRs, repeats the identity/version observations, and independently revokes the token. A failed cleanup cannot publish a usable preview.

This allows a newer default commit to be reviewed without pushing the already-delivered source again. The two observations must agree on the chosen baseline and the source must still equal the delivered head. They are bounded observations, not locks. Existing PRs are returned as scoped identities only: no body marker, matching title, absence on an earlier read, or user-editable content establishes ownership or settles an earlier unknown create.

## Exact reviewed request and one attempt

`PreparedTaskPull` derives the head from task/workspace UUIDs and the base from the fixed default branch. It binds operation/delivery/repository IDs, source and selected target SHAs, manifest hash, title and body. Its deterministic footer states those versions and explicitly does not attest CI, review or mergeability. The prepared request always sets `draft: true` and `maintainer_can_modify: false`; the latter is a provider option, not protection against other repository writers. The actual UTF-8 request length and SHA-256 are fixed. Returned copies cannot mutate the internal request; the provider client independently reconstructs and compares the consumed attempt before credential work.

The create token has only `contents: read` and `pull_requests: write`, plus optional read-only metadata. Broad tokens, extra permissions, missing expiry, multiple accessible repositories, changed identity/visibility/default branch or suspended installations are refused. The client exposes no raw token, arbitrary authenticated URL, contents write, issue-comment, reviewer or merge capability.

Preflight checks the selected head/base versions, detects an existing open PR without adopting or editing it, and repeats identity/version observations before a mandatory authorization callback. That callback must eventually be supplied by the durable broker and return true only after a positively acknowledged final SQL COMMIT. The callback receives isolated copies plus an independently reproducible evidence hash. Permission failure, denied authorization or cancellation before create sends nothing. Each prepared object can be consumed once; SQL must separately prevent another object/process from replaying the same operation before reading keys.

## Creation acknowledgement versus current revision

Once the POST is invoked, ambiguous failures remain `unknown`, including timeout, cancellation, redirects and malformed success responses. The documented create-endpoint 403/422 responses are recorded separately as `rejected`; they do not adopt an existing PR, and any later attempt still needs a new explicit durable request. The client never automatically retries a mutation. A positive scoped 201 records the PR identity and creation snapshot. A subsequent GET and repeated target observations determine whether the observed versions and reviewed title/body still match; title/body are stored as hashes in evidence, not trusted provider text. The latest sample is labelled `matching`, `changed` or `unavailable`. None is a merge gate or assurance against changes immediately after the sample.

Head or base movement after authorization can therefore yield a **created, changed draft**. It is not silently rewritten, closed or retried. Positive creation evidence survives a failed later GET or token revocation. Conversely, revoked credentials and a read that currently finds no PR do not prove an in-flight creation cannot arrive later. Caller errors and provider bodies are not exposed as error text. URLs are constructed from verified repository identity/PR number and checked against responses; returned clone, issue, diff or arbitrary links are never followed.

## Persistent integration still required

The next layer must persist a read-only proposal from an acknowledged delivery, show the fresh target version and exact generated title/body, and require an explicit confirmation that creation will notify repository participants. It must record current requestor/task/installation/binding versions, SQL-derived source identity, manifest/evidence/request hashes and one send intent before reading a write key.

PR admission must share the stable GitHub repository-ID/head-ref fence with push confirmations, so another platform push cannot change that head during a queued/running/unknown create. A known created PR needs a local ChangeRequest association and immutable revision observations; later pushes must invalidate old evidence through the PR/CI layer. Unknown creation must retain the head fence: process loss, missing PRs or a copied body marker are insufficient grounds for replay or release. Explicit administrative retirement must permanently fence the old head and continue with a new workspace/ref. A separate, explicitly reviewed existing-PR association may be designed later; it must not invent attribution for the original create.

Full diff hashes, trusted CI producer identity, signed/ordered webhook handling, SHA-bound reviews, remote protection enforcement and merge recovery remain open. This provider module deliberately cannot claim those requirements complete. Native remains the default; no new service processor, database migration, browser button, personal credential import or Docker dependency is introduced by this increment.

## Evidence

The protocol tests first perform a real authenticated task-branch push to a disposable Git HTTP receiver, then exercise an actual loopback REST server using generated RSA App credentials and scoped token verification. PR records are explicitly simulated provider records, not real GitHub PRs. Tests cover exact requests, all scope/identity checks, independent read-only preparation of a newer baseline, caller mutation, duplicate preparation consumption, existing PR observations, denied/cancelled authorization, post-gate head/base movement, external PR edits, malformed/lost replies, read/cleanup failures and delayed creation after cancellation and token revocation. Final acceptance counts are recorded in the implementation status.
