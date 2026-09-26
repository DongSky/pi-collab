# ADR-031: Exact workspace Git previews and selection plans

Status: internal native inspection and planning implemented. Actual index/ref writes and bounded recovery are provided by [ADR-032](0032-native-workspace-git-operations.md), database mutation authority by [ADR-033](0033-workspace-git-broker.md), and browser confirmation by [ADR-034](0034-browser-workspace-git.md). The future-work descriptions below record the boundary when this planning foundation was introduced; later ADRs describe the implemented integration. Development-plan §7.2 and M3-01 remain incomplete. Docker remains optional and has separate exit-evidence acceptance.

## Preserve three independent versions

The workflow distinguishes HEAD, the index and the working files. Selecting working changes stages from index to working bytes; selecting staged changes for removal reverses HEAD to index. Neither operation takes the entire working directory as an implicit commit. A later commit confirmation covers the complete resulting index, including entries staged earlier; the interface must show that whole staged set before confirmation.

`inspectWorkspaceGit` resolves only a managed workspace UUID below the configured data root. Its run/executor/epoch identity must come from authoritative server state. It requires positive native exit evidence before and after inspection; a missing, mismatched or launch-gap receipt is insufficient. It accepts only the managed task branch, rejects a detached HEAD or symbolic task-ref alias, existing Git locks, unfinished merge/rebase/cherry-pick/revert/sequencer/bisect state, shared Git directories, alternates and symlink metadata. It never removes an existing lock. Special index flags, unmerged entries, unsupported paths and object formats fail closed.

Two complete scans bind the revision to the workspace/run identity, receipt hash, branch, HEAD, exact index bytes, raw HEAD/index references, sanitized file bytes/modes and exclusions. Independently hashed eligible blobs must agree with the raw references. A reconstructed raw HEAD tree must agree with the independently verified HEAD commit. Normal local Git commands remain available; subsequent file edits, local commits or even an index representation change invalidate an earlier revision.

These reads detect persistent changes; they are not a lock, cannot prove that an external same-user process never changed a file temporarily, and do not establish a hostile-code sandbox. The future execution path must acquire durable ownership, freeze platform writers and revalidate immediately before effects. New runs already use independent directories; no shared writable Git metadata or object hardlinks are introduced here.

## Exclusions are not implicit deletions

Inspection reuses the snapshot omission policy: private/generated paths, secret patterns, symlinks, submodules, special and oversized files. An omission in any layer suppresses that path and overlapping ancestor/descendant paths from all displayed content. A regular indexed file replaced by a working symlink must not appear as a safe deletion.

Raw reference metadata is retained internally. Any HEAD/index change touching an excluded path blocks commit planning. The one permitted operation is whole-file unstage back to its original HEAD reference (or removal of a newly indexed path); it neither reads nor returns secret content. Unchanged excluded HEAD entries are preserved by reference. Excluded working bytes are not hashed or certified, and the policy is not a complete secret detector. A commit cannot be represented as having reviewed those omitted contents.

## Server-derived hunk plans

The isolated diff helper runs without project textconv, external diff or attributes. Hunk IDs bind the revision, layer, path, modes, content hashes, coordinates and exact diff. Clients choose only server-derived IDs or an explicit whole file; arbitrary patches, duplicate paths/hunks, cross-layer IDs and stale revisions are rejected.

Partial operations are available for existing regular UTF-8 text files with bounded content. The planner slices byte-preserving line arrays at the validated hunk coordinates. This preserves CRLF, missing final newlines and insertion/deletion offsets. Partial selection keeps the existing index mode. Whole-file selection handles addition, deletion, executable mode, binary and unsupported text encoding. Renames are explicit deletion/addition selections, not inferred moves. Invalid file/directory or portable-name collisions are refused.

Staging uses **raw bytes without clean filters, EOL or working-tree-encoding conversion**. This is an explicit platform policy, not a claim to duplicate every repository's `git add` configuration. The future UI must show the policy and the resulting staged diff, and make omitted binary/large content clear. Users needing project conversion can use local Git first, then obtain a new preview. Selected output is checked again for secret patterns.

Plans contain the exact before/after index entries, selected changes, predicted tree, new blob bytes and deterministic tree objects. Tree ordering follows Git's byte ordering, including directory slashes. No files, source objects, index or refs are written. The public planning helpers re-inspect the workspace when consuming a revision; the captured view methods are internal immutable-data planners, not mutation permission checks.

Limits inherit snapshot bounds: 5,000 entries per layer, 2 MiB per included file, 64 MiB unique included content. Text diffs additionally allow at most 256 KiB/8,000 lines per side; an operation selects at most 200 paths and 256 hunks per path. Binary/encoding/large text contents are omitted from display with metadata rather than rendered misleadingly. Untracked files may be explicitly selected; the snapshot omission rules, rather than repository `.gitignore`, determine eligibility. API concurrency/admission quotas remain future work.

## Exact commit identity

A commit plan binds the already inspected index tree, parent SHA, branch, revision, operation ID, run/workspace, confirming member, message and fixed timestamp. The future admission transaction must derive member identity from the authenticated user, never a browser-supplied author. Display names reject Git header delimiters/control characters; a stable pseudonymous email is derived from the member ID. The platform is the committer, with explicit AI-workspace/member-confirmation provenance in the prepared object and plan. No cryptographic human signature is claimed. Empty commits and excluded staged changes are rejected.

Git can independently parse and hash the exact prepared commit bytes. Planning does not install the object, move HEAD, execute hooks or supply push credentials. Source index, working files and refs are unchanged.

## Required next execution protocol

1. Add migration 026 or later for durable workspace Git ownership, versioned/idempotent admission, current member authorization, final authorization and append-only audit. Migrations 001–025 are immutable locally.
2. Persist immutable selection/commit plans; freshly verify the same run receipt, HEAD, index and file revision before any effect. Prevent competing snapshot/staging/commit operations from presenting inconsistent evidence.
3. Stage in a dedicated owned native operation process with durable launch/exit evidence and a recoverable prepared decision. Unknown effects retain workspace occupancy/quarantine. A SQL connection loss or lease timeout alone cannot prove the filesystem writer exited.
4. Do **not** recover an index lock by checking its inode/marker and then unlinking/renaming its pathname. A paused old writer could resume after a new owner reuses the lock name. Cleanup and ownership transfer require positive old-process exit evidence; unresolved launch gaps stay quarantined. External Git lock files must never be guessed to belong to this service.
5. Commit with a prepared/applied/aborted decision and a single-reference CAS. Verify the exact symbolic HEAD relationship as well as the expected old branch SHA; detect the required Git ref-transaction capability before enabling writes. Preserve late-process fencing and reconcile unknown Git/SQL outcomes without replaying a commit or staging effect.
6. Connect read permissions and authorized mutation controls to the browser; show staged/working changes, whole-file/hunk selections, complete commit content, member provenance and stale-version/recovery states. Verify two-member concurrency and response loss using real native processes. Then add task-branch push, PR and CI delivery.

## Evidence

`tests/collab/workspace-git.test.ts` exercises real Git and an actual local Pi RPC process with no external inference. It checks live-writer rejection and stopped evidence; HEAD/index/worktree separation; no source writes; partial stage/unstage; pre-existing index preservation; binary/mode changes; CRLF, empty files, missing newline and offset-changing hunks; deterministic Git-verified trees/commit bytes; stale file/index/HEAD/run identity; forged selections; omitted staged secrets; working symlink/ancestor omissions; detached/symbolic branches and packed refs; lock/state/index flag rejection; corrupt objects; metadata symlinks/alternates; name/header protection; untrusted filter/diff non-execution; and independent file/directory transitions.

These are internal runtime tests. There is no new staging/commit browser UI to claim as tested in this increment, and no database migration or Git remote effect.

References: [ADR-006](0006-dual-runtime.md), [ADR-012](0012-workspace-snapshots.md), [ADR-021](0021-immutable-integration-code-review.md), [ADR-023](0023-local-promotion-decisions.md), development-plan §7.2.
