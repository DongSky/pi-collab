# ADR-025: GitHub App credentials and scoped repository observations

Status: implemented foundation for GitHub connectivity; validation is tracked in the implementation status. Migration 020 adds installation credentials, repository linkage and administrative disable. It does **not** implement remote clone/fetch/push, PR creation, webhook delivery or protected-branch merge. Native local operation remains the default; no Docker is required.

## Trust and identity

Only explicit local administrator commands read an operator-supplied private-key file. They do not discover `gh`, SSH, Git or Pi credentials. The file must be regular, owned by the operator, have no group/other access and no hardlink/symlink, and fit the 16 KiB bound. RSA keys must be 2048–8192 bits. A separate private 32-byte `git-master.key` encrypts normalized keys with AES-256-GCM. Authenticated context pins connection, organization, app, installation and account IDs. The public fingerprint is SHA-256 of the SPKI public key, not of private material.

Encrypted keys live in the private `collab_git` schema. The Web, executor, model gateway and resource broker have no SQL grants to it. Public records contain identity, bounded observations, fingerprints and audit references. The App key itself has provider-wide App authority: installation scoping is enforced by the trusted Git client and future broker, not by pretending that an App signing key is intrinsically limited to one repository. Hostile access as the same OS user remains outside native directory separation.

The connection binds stable numeric GitHub app, installation and account IDs. A repository binding pins the stable numeric repository ID; current owner/name are display/routing metadata reacquired through a repository-scoped token. Returned clone URLs and hyperlinks are never followed. Only generated HTTPS `api.github.com` endpoints are used; no configured endpoint, proxy, remote helper, arbitrary URL or redirect comes from browser/database/CLI input. Enterprise Git hosts remain future provider work.

## Bounded read protocol

1. Sign an RS256 App JWT with `iat = now - 60s`, `exp = now + 540s` and the pinned app ID. Query `/app` and the exact installation, then verify app/account/installation equality, nonsuspension and contents permission.
2. Request an installation token with exactly one numeric `repository_ids` entry and `contents: read`. No broad default-permission or all-repository fallback is allowed.
3. Require a fresh bounded expiry and an explicit permission response containing only read contents/metadata. Even though permissions are optional in GitHub's general schema, absence cannot prove the narrow scope and is rejected. List accessible repositories with page size 2 and require exactly one total repository with the pinned ID/account.
4. Validate the canonical name/default branch and read its branch SHA. Reject archived/disabled repositories, invalid branches, identity changes and inconsistent privacy fields. Optional omitted visibility is recorded as unknown; the provider's required private flag remains separate evidence.
5. Revoke the token with a separate bounded cleanup signal, including after cancellation or bad scope/expiry. A failed revocation prevents a successful observation. Crash/disconnect before a token is received may leave an unrecorded token until provider expiry; no retry is made automatically. Tokens are never returned or persisted.

Requests use an explicit API version, disable redirects and have 10-second deadlines, a 30-second overall read deadline and a 2 MiB streamed response limit. Cleanup has a separate five-second deadline. Provider bodies, tokens and transport exception details are not used in errors or logs. Rate limits, malformed responses and lost acknowledgements fail closed. The transport dependency injection exists only for deterministic tests and is not an operator configuration surface.

The observed `protected` boolean is not proof of required-check producers, required reviews, up-to-date protection or atomic expected-target enforcement. Capabilities explicitly remain `push=false`, `pullRequest=false`, `protectedMerge=false`. Future writes must perform their own current authorization and provider-side conditional-effect protocol; cached observations are never a write grant.

## Durable registration and binding

Registration requires a local administrator command acting for an active organization Owner/Admin with MFA. It checks authority under the organization lock before network work, releases the transaction during HTTP, then rechecks the original authorization version before storing the encrypted connection and one audit. Same-key retries bind the same public key fingerprint and request; another organization cannot silently adopt an existing installation registration.

Binding requires an active project Maintainer with MFA and an enabled installation from the same organization. The command observes the remote through the narrow protocol, then rechecks original organization/project authorization versions and the exact installation version. It requires the existing imported repository's current default branch and base SHA to equal that observation and refuses pending local promotions. It changes provider metadata only. It does not alter Git files, initialize remotes, modify the base or grant remote writes.

A remote repository ID may have only one managed local binding in this installation of pi-collab. This conservatively prevents separate project queues from silently managing the same remote target before a provider-wide queue exists. Bindings and successful registration are idempotent and audited. Public SQL roles cannot bypass the named administration operations or read encrypted keys.

Owner/Admin with MFA can disable an installation through the browser. It uses optimistic versions, a reason, same-key retry and an audit; version changes invalidate binding authority. This disables local remote access association and does not uninstall the App from GitHub or erase existing code. Re-enable, key rotation and re-binding require a future explicit re-verification workflow; there is no unsafe toggle that revives old observations.

## Product visibility and limits

Project readers see the remote repository link/stable ID, observed remote SHA, current local SHA and observation time. The UI says the remote may have changed and that local advancement is not remote publication. Organization administrators can inspect and disable registered installations without receiving private material. Only the explicitly invoked local CLI registers keys and initial bindings at this stage.

The remaining Git delivery work includes direct managed remote import/fetch, broker credentials and durable queues, selective commit confirmation, controlled task-branch push, PRs, key rotation/revalidation, signed deduplicated webhooks, exact-SHA CI/producer validation, provider-side protected merge and unknown-effect reconciliation. The complete M3 milestone remains open.

## Evidence and provider references

Tests use generated RSA keys, a local HTTP protocol service, temporary PostgreSQL databases and real imported Git repositories. They verify signatures and scopes rather than mocking the client's returned verdict. Cases cover crypto context substitution, file permissions, identity mismatch, extra scope, suspension, redirects, response bounds, cancellation and token cleanup; SQL/RLS, concurrent retries, exact baselines, cross-organization linkage, authority/installation changes during network waits and administrative disable. Browser acceptance uses two authenticated sessions and the same HTTP fixture. These are protocol and local authority tests, not real GitHub App installation or external account acceptance.

The implementation was checked against GitHub's public REST OpenAPI description and documentation on 2026-09-23:

- [App JWT claims and RS256](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [Installation repository listing](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)
- [GitHub REST OpenAPI description](https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json)
