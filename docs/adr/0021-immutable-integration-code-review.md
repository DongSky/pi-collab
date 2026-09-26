# ADR-021: Immutable integration code and conflict browsing

Status: implemented for native local integrations. This extends ADR-019/020 with readable code evidence; it does not resolve conflicts, edit workspaces or advance Git branches. Default development still requires no Docker.

## Fixed identities, not live worktrees

Project members, including read-only Reviewers and Viewers, may browse completed integration evidence within their project. A code list identifies the integration, input hash, original target SHA, Git candidate commit, checked snapshot manifest/worktree hashes or conflicting source result. A deterministic SHA-256 `diffHash` binds this identity and the complete ordered file metadata. Each selected file has its own derived `fileHash`. Subsequent pages and file requests carry the list hash; mismatches fail instead of silently displaying another revision.

Successful candidates compare the pinned target tree against the actual saved working bytes. Those bytes must agree with both the immutable snapshot and the Git candidate tree. Exclusions from either side remain explicit. Changing HEAD, the private checkout's files, another source workspace or the repository's current default ref cannot change the historical diff. Policy, dependency, source or authority changes are reported as current staleness, while historical code remains readable by currently authorized members.

The review revision from ADR-020 already binds target, candidate and snapshot identities. The browsing hash is derived evidence, not a new permission or proof that a person actually read every line. There is no automatic approval when a file is opened. Future anchored discussions can bind `revision + diffHash + path + fileHash + side + line`; this increment does not yet implement discussions or suggested patches.

For a failed Git combination, the reader exposes only the exact conflict paths and base/ours/theirs object IDs recorded by the integrator, plus exclusions. `ours` is the result of combinations completed before the conflicting source; `theirs` is that source's synthetic commit. A missing side is explicitly absent. Earlier evidence did not record side modes, so the conflict viewer says mode unknown rather than inventing a value. No full candidate exists for these records, and the interface does not imply a partial combination passed checks.

## Trusted reads and safe presentation

Request paths only select an entry in the authorized fixed list. They never become filesystem paths or arbitrary Git object expressions. Project RLS is checked before filesystem access and again before returning content, including revocation during a read. Responses use `Cache-Control: no-store`. No mutation, terminal or model permission is required or granted.

Git readers access broker-owned repository storage and the integration's private object database. Directory ancestors, symlinks, special files and alternate object stores are checked. Git receives an environment allowlist, disabled lazy fetch/replacement objects/network protocols and no host HOME or credentials. Objects read from Git are independently hashed over their exact type/length/body; commit and tree identities are verified during traversal. The reader does not trust mutable refs or Git's ability to inflate a corrupt loose object. Missing, corrupt or inconsistent artifacts fail closed.

Concurrent native promotion preparation can publish Git pack metadata while another reader enumerates it. An `ENOENT` from `lstat` of an `objects/pack/tmp_pack_*`, `tmp_idx_*` or `tmp_rev_*` entry restarts the **entire read-only validation**, at most three scans of 50,000 entries each. It never skips the missing entry, replays a Git effect or retries ordinary missing files. Every attempt rechecks the broker root and repository ancestors against their original device/inode identities; the successful scan checks them again before returning. Newly visible links, special files and alternate stores still fail, as do cancellation, replaced ancestors and continuous churn. This accommodates trusted broker writers; it does not turn native shared-user storage into a hostile-filesystem sandbox.

Unified text differences run in a disposable directory with an empty Git repository, controlled file names, `--no-index`, `--no-ext-diff` and `--no-textconv`. Project `.gitattributes`, diff drivers, hooks and textconv commands do not execute. Temporary files are removed after success or failure. The code viewer returns structured hunk rows with original line numbers rather than an executable or automatically applicable patch.

Snapshot private/generated-path rules also apply to historical target and conflict bytes. Content screening runs on all readable sides, including deleted historical files; if one side matches a secret pattern, all sides of that file are withheld. This is a bounded pattern filter, not a guarantee of finding every secret. HTML and other code render as React text, never executable markup. Invisible directional/control characters are shown as explicit `⟦U+…⟧` markers; hashes still describe the original bytes. File mode, byte length, content hash and line-ending style help distinguish changes not obvious in a text diff.

## Bounds and limitations

The reader supports at most 5,000 Git tree entries/list items; lists page in batches of 100. Each text side is limited to 256 KiB and 8,000 lines. Binary/non-UTF-8/oversized content is explicitly omitted, with available identity/size metadata, and is never counted as inspected text. Exclusion entries may refer to unchanged paths; the UI calls them files and exclusions rather than a changed-file count. Rename detection is not inferred: moves appear as deletion/addition. The existing snapshot excludes symlinks, submodules, generated paths and secret patterns; browsing does not change that coverage.

Two expensive code reads may run per Web process; further reads get a retryable 429. Git subprocesses have a 10-second timeout and output caps. A 20-second request deadline is checked by Git and filesystem traversal boundaries; ordinary filesystem reads remain bounded by existing snapshot limits, not a hard OS I/O deadline. These are local safeguards, not configurable deployment-wide quotas.

No migration is required. Migration 017 and earlier remain immutable. Existing compatible native integration artifacts can be browsed after deploying the new Web code; missing historical artifacts remain unavailable. Docker parity, downloadable binary review, complete environment packaging, comments, patch proposals, conflict-resolution tasks and durable Git promotion remain follow-up work.

## Acceptance evidence

`tests/collab/integrations.test.ts` uses real PostgreSQL, Git, native Pi diagnostics and supervised checks. It verifies actual added/modified/deleted bytes and hunk line numbers, modes, CRLF, binary/UTF-16/large limits, deleted-secret suppression, directional characters, pagination, stable history after source withdrawal and mutable-worktree changes, access/path/hash refusal, corrupted packs/loose objects/snapshot blobs, symlink refusal, external diff non-execution, revocation during reads, concurrency bounds, cancellation, add/add and three-sided conflicts. No external model inference is used.

`tests/collab/review-git.test.ts` deterministically moves real temporary metadata between enumeration and `lstat`, then verifies actual Git object bytes. Its regression cases cover newly visible links/alternates, replaced ancestors, missing ordinary files/repositories, the scan bound and cancellation. The concurrent candidate preparation and single-winner branch CAS remain covered by `promotion-runtime.test.ts`.

The isolated browser flow checks both members see the same fixed code, literal HTML cannot execute, hash/path errors remain scoped, exact conflict sides render, and desktop/390px layouts work. Screenshots are `test-results/collab/integration-code.png`, `integration-conflict-code.png`, and `integration-conflict-code-mobile.png`.
