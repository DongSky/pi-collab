# ADR-030: Browser imports use the restricted native Git service

Status: implemented; local protocol and browser verification recorded in the implementation status. Actual GitHub accounts and Docker parity remain separate acceptance work.

## Authorization for new repository access

An existing binding already scopes synchronization to one project repository. Importing a new repository can spend broader installation access, so the Web admission and recovery APIs require both current organization Owner/Admin and current project Maintainer, plus MFA. A project Maintainer alone cannot enumerate installation choices or import arbitrary repositories through a guessed connection ID. Organization administration without project membership does not grant project content access. The same dual authority is checked again before any credential access and before publication, using frozen organization/project authorization versions.

The first Web import form takes a registered team installation, GitHub numeric repository ID, project-local name and reason. Installation choices expose only the identifier, account login and App slug. There is no arbitrary URL, local directory, remote helper, shell command or key upload in this flow. Private App enrollment remains explicit local administration. Project-level installation delegation and an upstream repository picker remain future work.

## Durable execution

Migration 025 adds a private import dispatch queue and idempotent operator actions. The dedicated `pi_collab_git` role gets four additional procedures: claim, begin, finish and fail. Private authority helpers, arbitrary table access and administrator credentials remain unavailable. Import and sync share the service's two native execution lanes; lanes alternate which queue they try first. No Docker daemon or image is involved.

An admission reserves a fresh import and repository ID before any I/O, with at most 20 unfinished imports per project. Imports keep the existing global remote occupancy rule and fetch only the verified default branch with a narrow read token and loopback relay. GitHub tokens never enter Git/Pi arguments, environment or persisted remote configuration. The existing transfer limits, Git object verification, original commit history and LFS/submodule limitations from ADR-027 still apply.

Every attempt holds one pinned SQL connection and the same per-import session advisory lock as the administrator CLI. A random claim ID plus backend PID fences callbacks. A guard rejects legacy CLI mutation after Web takeover. SQL transactions are not held while downloading or scanning files. Publication inserts the repository, binding, completion and audit event in one transaction with current authority and installation checks; until that transaction commits, agents cannot select the imported repository.

## Cancellation and recovery

Queued cancellation needs neither a key nor provider access. During transfer, cancellation can wait for bounded reads and credential cleanup, then prevents publication. Cancellation after publication records the action without deleting the existing repository. A cancelled operation cannot be revived by a later reconcile action. All created directories are retained; subsequent new requests use new IDs and directories.

Loss of the owning SQL session moves the dispatch row to attention. Another service cannot automatically download again. An explicitly authorized operator may reconcile or terminate the original operation. Reconciliation reads the original authenticated completion receipt, verifies its identity and Git objects/HEAD, then attempts the same atomic registration. It performs no provider request and does not decrypt an App private key, but **does require the original Git master key** to verify the HMAC. Missing or invalid receipts, changed authorization/installation, or corrupted Git objects cannot publish a repository. Terminal failures preserve directories and require a fresh explicit import request for a new download.

The receipt is written and fsynced only after provider-token revocation and confirmation that the normal Git process group has exited. It is shared with administrator imports, allowing an interrupted CLI import to be reconciled through the browser. Reconciliation never reuses an incomplete writer's directory for a new download. COMMIT acknowledgement loss is resolved through durable rows; a completed import cannot be transferred again. This is trusted native process isolation, not protection against hostile code running as the same OS user or an administrator editing the managed files.

## Verification scope

Database/real smart HTTP tests cover dual-role/MFA admission, exact idempotency, arbitrary-role and helper denial, connection/nonce fencing, live-owner exclusion, cancellation, permission regrant and installation disable, actual backend termination, missing/corrupt receipts and Git objects, legacy CLI takeover, and a TCP proxy dropping the final COMMIT acknowledgement. Generated fixture keys are used exclusively.

The browser flow checks admission and action response-loss retries, member/CSRF denial, an actual separate Git process killed with SIGKILL after writing its completion receipt, explicit recovery with no provider traffic, another user's repository selection, cancellation, refresh persistence and desktop/mobile layouts. These protocol fixtures do not stand in for actual external account/model acceptance.

References: [ADR-027](0027-managed-github-imports.md), [ADR-029](0029-web-git-sync-broker.md), `db/migrations/025-github-import-broker.sql`, `lib/collab/git/import-broker.ts`, `tests/collab/github-import-broker.test.ts`.
