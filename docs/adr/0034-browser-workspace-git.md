# ADR-034: Versioned browser review and confirmation of workspace Git changes

Status: implemented for trusted native workspaces. Remote push/PR/CI and Docker parity remain outside this increment.

## Read authority and exact source versions

Authenticated routes expose the selected run's operation history, read-only Git summary and one requested file in either the working or staged layer. The Web process derives workspace/run/executor/epoch from RLS-protected SQL rows. Clients cannot supply source directories, executor identities or owned-lock evidence. Reads require a stopped, unarchived native workspace; the native scanner independently verifies positive writer exit and rejects Git locks/unfinished operations. An unfinished Git job, including attention, prevents a new preview.

The reader uses at most two concurrent process-wide slots, a 20-second deadline and request cancellation. It rechecks project RLS, membership/task/run versions and operation occupancy after filesystem work, before returning content. Responses are not cached. Every file request contains the exact summary revision; source/index/HEAD changes require a new preview. Existing raw-byte scanner limits, secret/path exclusions, unsafe-metadata rejection and no-filter/no-textconv policy remain in force. No new migration or filesystem write permission is added to the Web process; migrations 001–026 remain immutable.

`workspace-schema.ts` contains the shared browser-safe validators. Runtime re-exports preserve the internal API without pulling native process/filesystem code into the client bundle. The read response omits the native exit-receipt hash and executor identity. File content displays escaped control characters, complete bounded text, file modes, byte hashes, line-ending counts and trailing-newline state. Non-text/encoding/size omissions are explicit and have no hunk controls; exclusions never return raw content.

## Selection and complete staged confirmation

Each selected run has a **工作区 Git** panel with separate working and staged lists. A user may stage/unstage whole files or server-derived hunks. One file has only one selected direction per request; the UI lists the exact selected action, requires acknowledgement of the raw-byte policy and submits the fixed revision. Selections do not automatically include other drafts. Excluded staged paths block commits and offer only whole-file unstage, restoring the original HEAD reference without displaying excluded content.

The commit form requires a message and explicit acknowledgement of every staged file at the same preview revision. Text files expose all diff hunks and bounded complete before/after text. For omitted content, the member must explicitly attest that they checked complete bytes externally against the displayed hashes; merely receiving a hash is not presented as inspecting the content. The final confirmation covers all staged files and the message; unapplied staging selections prevent accidental commit of an earlier index. SQL still enforces current member/MFA/task authority, exact source revision and native ownership through ADR-033. Browser checkboxes are user confirmation, not a substitute for server authority or a claim that an API caller has read every line.

The UI explains server-derived member attribution, unsigned provenance and local-only task-branch commits. It does not predict an exact commit SHA before SQL assigns operation identity/time; the applied history shows the actual SHA. Confirmed stage/commit requests clear prior previews. External changes cause either a stale file-read response or a durable pre-effect abort; the user must read the new revision and confirm again.

## Retry, concurrency and recovery

Before sending a write/action request, the browser saves its validated exact payload and idempotency key in `sessionStorage`, scoped to the authenticated member and run. Storage failure prevents sending. An unknown transport/5xx result retains this record and offers only **重试同一 Git 请求**; reload restores the original payload. A confirmed response or definitive client error clears it. Changing tasks cannot repurpose a pending request for another run. No credential or source-file bytes are stored by this retry feature.

The current member's capabilities and latest 50 operation records are refreshed independently of expensive code previews. Live/unknown ownership disables further writes; all authorized project readers can see durable history. Current authorized controllers can cancel or request reconciliation with a reason and fixed key. Cancellation does not undo an already applied effect. Reconciliation follows ADR-033: observe/fence the original operation, require positive exit and owned cleanup, never repeat an effect. Missing evidence or residual locks remain occupied; no force-release button is added.

Read failures clear old preview data, and component lifetime/version guards discard late responses after task changes or preview invalidation. Role revocation is checked by both the lightweight state endpoint and every server mutation. A stale browser control cannot confer permission.

## Evidence and remaining work

Service tests exercise real PostgreSQL, Git and local Pi tool processes: exact working/staged reads, no source mutation on preview, stale revision rejection, read-vs-control scope, removed project access, excluded-secret reads, forged/traversal paths and archived-source rejection, in addition to the native effect protocol tests.

The isolated browser suite creates two authenticated member contexts and a real Pi-generated draft. It checks partial staging while another draft hunk remains, whole-file binary staging, excluded-content unstage and commit blocking, per-file commit confirmation, same-key retry after an actually lost response **and browser reload**, competing member admission, stale source changes, real committed Git output with SQL backend loss, explicit original-operation recovery, changed roles, no-store/CSRF and desktop/390px layouts. Its diagnostic worker uses generated fixture state and real Pi/Git, with no external model inference or personal credentials. Screenshots are in `test-results/collab/workspace-git-*.png`.

Remote task-branch push, PR/CI/webhooks/protected merge, credential lifecycle, administrator handling of irreducible unknown state, backup/DR and Docker acceptance still remain. This does not complete development plan §7.2 or milestone M3-01.

References: [ADR-031](0031-workspace-git-plans.md), [ADR-032](0032-native-workspace-git-operations.md), [ADR-033](0033-workspace-git-broker.md).
