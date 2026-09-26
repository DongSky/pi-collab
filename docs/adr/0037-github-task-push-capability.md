# ADR-037: One-repository GitHub task push capability

Status: accepted for the internal native provider client; durable broker, browser confirmation and external-account acceptance remain outstanding.

## Context

ADR-035 fixes the exact single-ref receive-pack bytes, while ADR-036 preserves and checks the complete outgoing history in an immutable export. Neither grants a GitHub credential or establishes current platform authority. A write client must narrow the App's installation grant, pin the repository identity and disclosure destination, check current provider restrictions, and preserve ambiguous Git effects independently of credential cleanup.

## Decision

`GitHubTaskPushClient` accepts a prepared task push, a verified repository binding and a mandatory final authorization callback. It exposes no token, authenticated arbitrary fetch, URL, refspec, force option or Git command. This internal client is callable only by the trusted Git broker; its callback does **not** itself implement durable SQL authorization.

The binding fixes the local repository UUID, GitHub repository/node/owner IDs, owner login, repository name, default branch, privacy, explicit visibility and integration branch names. Unknown visibility is refused. The generated task/workspace UUID branch cannot equal the default or an integration branch. Provider-returned clone URLs are ignored. A rename, transfer or privacy change invalidates this binding; accepting refreshed metadata requires a new upstream authorization/confirmation flow, which is not yet implemented.

Before requesting credentials, the client verifies the App, installation, account, suspension state and `contents: write` installation grant. Token creation names exactly one repository ID and explicitly requests only `contents: write`. Only an accompanying `metadata: read` permission is allowed. The response must have a bounded valid expiry and the installation-repositories endpoint must prove that the token exposes exactly that repository. A broader installation grant does not widen the token request. The existing read client continues to request read-only tokens and report `push: false`.

Repository metadata is checked using both the scoped listing and the stable repository ID endpoint. Existing task branches require matching branch and exact Git ref observations, with a commit object and no protection. Both lookups may report absence only while access to the same repository remains verified. The active-rules endpoint is queried for the generated branch name even when it does not exist yet. **Any active rule, including an unrecognized rule, refuses this path.** It includes inherited/organization rules; the client does not attempt to exercise App bypass or infer that a rule is harmless. Evaluate/disabled rules are not returned by that endpoint. Missing/malformed rules evidence fails closed.

After Git advertisement, the client repeats the installation, repository, task-ref and rule checks. It verifies that the prepared callback still names the exact operation, identities, old/new SHA, ref and byte hashes, then passes an immutable attempt plus a fresh observation and its SHA-256 to the authorization callback. The future broker must compare that evidence with the authorized binding/export and persist its final dispatch decision before returning true.

The private transport only generates the matching `github.com/<owner>/<name>.git` advertisement and receive-pack routes. Before sending, it independently checks request length, the exact one-ref command, complete request SHA-256 and pack SHA-256. A copied token is never passed to a Git subprocess, Git configuration, agent, browser or error response. Redirects and automatic mutation retries are disabled. Remote compare-and-swap is still required: if another writer changes the ref after all observations and the final callback, the receiver must reject the stale expected-old SHA. Tests exercise this race with a real Git receiver.

Repository administration is not atomic with receive-pack. A rule, privacy or ownership setting can change after preflight; the client cannot promise that its earlier observation remains true during the remote effect. Remote enforcement, a dedicated task namespace, least-privilege installation and later current-binding checks remain necessary. This increment is not acceptance of all live GitHub administration races or of protected remote merge.

## Git effects and credential cleanup are separate outcomes

The result retains `outcome`, sanitized `failure`, `receiveStarted`, the latest complete provider observation and credential status. Git outcomes are acknowledged, rejected, not sent, unknown or absent if preparation/provider authorization failed. `receiveStarted` records entry into the sole authenticated receive request; it is not proof that a packet reached the server or that a write succeeded.

Credential status distinguishes no request, issuance unconfirmed, revoked and revocation unconfirmed. A lost issuance response is never retried. A syntactically valid received token is retained only long enough for independent cleanup, even if its scope/expiry or subsequent provider evidence is rejected. Revocation uses a separate five-second signal and still runs after caller cancellation. If cleanup fails, the original acknowledged or unknown Git outcome remains intact. A successful revocation is not a transaction rollback and cannot establish whether an in-flight remote request has finished.

The protocol permits only one receive per in-memory preparation. Reinvoking this client can still request a new token before detecting a changed remote ref or a consumed preparation. This is **not durable idempotency**, and it does not protect against constructing another preparation after restart. The future queue must deduplicate and exclude that action before requesting credentials. Unknown effects must retain target occupancy; seeing the expected-old ref does not prove a delayed receive will never apply (ADR-035). No automatic resend, forced unlock or unknown-to-failed conversion is provided here.

## Shared HTTP limits

`GitHubHttp` supplies the existing read client and this writer with generated fixed-host REST requests, exact success status checks, no redirects/retries, a ten-second per-request deadline and a streamed 2 MiB JSON limit. Response reading is independently cancelled on deadline. Optional 404 handling is GET-only and used for the explicit branch/ref lookups. The complete writer is bounded to 180 seconds; each Git request is bounded to 60 seconds within that deadline. Errors omit provider bodies and credential-bearing transport details.

## Integration boundary and follow-up

No production endpoint, queue handler, database migration, service startup change or browser push control is introduced. Applied migrations 001–026 remain immutable. New database work starts at 027 or later and must:

1. Derive authenticated remote baseline/ref evidence, persist binding and installation versions, hold workspace/snapshot exclusivity while exporting, and bind the immutable manifest hash to current member/MFA/task authority.
2. Persist full outgoing-history confirmation, deduplicated admission, generated destination occupancy, dispatch intent, exact prepared bytes and final provider evidence before receive. Compare the fresh provider default SHA with the authorized baseline and require new confirmation if policy-relevant evidence changed.
3. Retain Git effect and credential cleanup evidence independently through process death, lost SQL responses and cancellation. A process unable to prove no dispatch must remain under reconciliation; token expiry alone does not prove a remote effect cannot arrive later.
4. Add browser history review/confirmation, current-authority revocation and multi-member acceptance, read-only uncertain-outcome observation, PR/CI/webhooks and protected merge.

Native operation remains the default and needs no Docker. Optional Docker parity is a separate acceptance track. Same-user native filesystem/process access is not hostile-code isolation. Real GitHub accounts, credential rotation/revalidation and an authorized external repository trial remain required before claiming provider acceptance.

## Evidence and references

`tests/collab/github-task-push.test.ts` uses generated RSA keys/tokens, a real loopback REST server and real `git http-backend` receive-pack. It covers successful creation/fast-forward updates, stable identity and visibility, broad/expired tokens, installation changes, ref type and protection, rules on absent branches, final provider rechecks, denied/failed/cancelled authorization, post-gate competing writers, altered authorization identities/send bytes, repeated preparation, actual committed writes with lost replies, and separate or combined revocation failure. Existing read-client tests validate the extracted HTTP path. These are internal native protocol tests, not browser push or live GitHub acceptance.

Official endpoint descriptions were checked against GitHub's public REST OpenAPI:

- [Get rules for a branch](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).
- [Get a reference](https://docs.github.com/en/rest/git/refs#get-a-reference).
- [Create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).
- [ADR-035](0035-task-branch-push-protocol.md), [ADR-036](0036-task-push-history-exports.md), [ADR-025](0025-github-installation-observations.md), [ADR-006](0006-dual-runtime.md).
