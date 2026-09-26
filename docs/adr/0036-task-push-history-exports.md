# ADR-036: Immutable task-push exports and complete new-history checks

Status: internal native export, verification and receive-pack preparation implemented. Durable push admission, authenticated GitHub write transport and browser push confirmation remain to be connected. There is no production push endpoint in this increment. Native remains the default; Docker acceptance is separate.

## Preserve commits, check the complete outgoing history

`exportTaskPush` accepts server-derived repository/task/workspace/run identities, the exact inspected workspace revision and HEAD, an operation ID, an export ID, and a fixed remote-baseline SHA with its observation hash. The source must be a stopped native workspace with positive exit evidence. Inspection before scanning and before completion binds the HEAD, index, working-file revision and receipt. Source Git metadata is guarded against symlinks, alternates, shared directories, grafts and shallow history. Replace objects and commit-graph acceleration are disabled.

The remote baseline is an **authorization prerequisite**, not a fact inferred from the local repository. The future broker must derive it from authenticated provider evidence for the same repository/binding and current access. Neither a caller-supplied SHA/hash nor a locally promoted repository HEAD proves that the remote already has those objects. The export helper deliberately provides no independent member or provider authorization.

The broker-owned repository supplies the known baseline history. The scanner independently hashes every new commit, tree and changed blob it reads. It enumerates all source parents, subtracts the complete known commit set, and verifies that every new parent edge terminates in either another checked new commit or known history. Unrelated roots and omitted parents fail. This includes side branches whose files do not appear in the final merge tree. A remote baseline that advanced after workspace creation need not exist in the workspace: subtraction happens against the known commit set, without fetching or modifying that checkout.

Every new commit is examined, even if later commits remove or replace its contents. For each tree:

- Unchanged path/mode/object references from the known baseline are preserved, including its existing excluded files. Their original objects come from the broker's baseline pack; no content is silently removed or rewritten.
- New or modified private/generated paths, symlinks and submodules fail the export. Explicit deletion of a known excluded path is preserved. Reverting an intermediate unsafe change later does not make the history acceptable.
- New/changed regular files retain exact bytes and executable modes. Size limits apply to intermediate files as well as the tip. Pattern checks inspect raw text and UTF-16 in either byte order; new path names and complete new commit metadata are also checked.
- New commit metadata must be bounded UTF-8; existing remote commit encodings are preserved verbatim. Trees must have supported modes, portable paths and no case/normalization collisions.

Secret patterns are a limited policy check, not proof that arbitrary binary, compressed or obfuscated data contains no confidential information. Human confirmation of the **entire outgoing commit range** remains necessary in the future push UI; reviewing only the final staged diff is insufficient. Rejected history is not automatically rebased, stripped or amended. The member must explicitly repair it and obtain a new preview/export.

## Separate export storage and verified replay

After scanning, the exporter creates a fresh `task-push-exports/<UUID>/git` bare repository with an empty template and no configured remotes. It imports an exact baseline pack and writes only independently verified new objects. The original commit IDs, trees, parents, messages, author metadata, binary bytes, CRLF and executable modes remain unchanged. Uncommitted index/worktree changes are not exported and remain in the source workspace. Source filters, textconv, hooks and executable project content do not run.

The export is checked with Git's strict full object verification and, when updating an existing task branch, the expected-old ancestry requirement. It retains one generated export ref. Pack/index/objects/ref metadata and directories are flushed before a completion manifest is published. The manifest contains the complete input, exit-receipt hash, policy version, checked commit/parent/tree records, changed-path counts, object type/size/SHA-256 records, the baseline pack hash and checked byte total. SQL must persist its expected SHA-256; the file's own claimed hash is not authority. Changes to the shared exclusion/secret rules must increment the export policy version so previous confirmations cannot silently acquire a new meaning.

Existing export IDs are never reused. A cancelled or failed export may leave an incomplete directory but no valid completion manifest; it is not rebuilt or automatically deleted by a retry. Retention and orphan disposition remain part of the resource-lifecycle work.

`verifyTaskPushExport` requires the authoritative manifest hash and fixed UUID path. It verifies path types, bare/no-remote metadata, HEAD and the sole ref, the baseline pack bytes, every checked object and Git connectivity. Corruption, missing evidence or unexpected refs fail; it never repairs the export from the now-mutable original workspace. `prepareExportedTaskPush` passes this verified repository and its exact intent into ADR-035's single-ref protocol. Subsequent source edits cannot change the already selected bytes. Whether an old export still has current permission/confirmation is a separate durable admission/final-gate decision.

## Limits and current integration boundary

The operation has a 180-second deadline. It permits at most 200,000 known baseline commits, 1,000 new commits, 32 parents per new commit, 5,000 tree entries per tree, 20,000 distinct checked objects, 2 MiB per changed file, 1 MiB per new commit object, 64 MiB total checked objects and a 64 MiB compressed baseline pack. Exceeding limits fails explicitly without truncating the exported history. These are supported pilot limits, not capacity-test evidence.

This module remains internal. Before exposing push, the broker still must:

1. Bind an authenticated remote observation, installation/binding versions and generated destination to current member/MFA/task authority. Prevent Git operations, snapshots and platform writers from changing the source while export/confirmation is established.
2. Persist immutable export/confirmation input, authoritative manifest hash, queue occupancy and audit in a new migration **027 or later**; migrations 001–026 are immutable.
3. Supply a one-repository write capability with exact provider routes, default/protected-target refusal, lifecycle/revocation checks and durable dispatch authority. Preserve uncertain remote-effect state, including a receive that completes after a disconnected caller observed the old ref.
4. Add browser outgoing-history review and confirmation, multi-member retry/revocation tests, PR creation, signed/deduplicated webhook processing, exact-SHA CI and protected merge.

Native same-user directory separation is not hostile-code isolation. These checks assume the broker's trusted files and current ownership; arbitrary same-user processes remain outside that boundary. No Docker, production service startup change, new database migration, personal credentials or external account is required by this increment.

## Evidence

`tests/collab/task-push-export.test.ts` exercises actual native Pi tool commits, separate immutable exports, independent Git object checks and a real loopback Git receive-pack. It covers original SHA/history/CRLF/binary/mode preservation; unchanged source and retained drafts; intermediate and merged-away secrets; excluded-path modification/deletion; commit metadata and UTF-16 checks; ordinary merges and unrelated roots; symlink/submodule/generated/large intermediate files; stale revisions and exit evidence; cancelled or reused IDs; later workspace changes; manifest/ref/pack/object corruption; forged metadata; intermediate-object hash tampering; filter/hook non-execution; known historical encodings; oversized commit graphs; and a newer remote baseline absent from the source checkout.

This is native storage/protocol evidence, not browser push or real GitHub-account acceptance. References: [ADR-034](0034-browser-workspace-git.md), [ADR-035](0035-task-branch-push-protocol.md), [ADR-006](0006-dual-runtime.md).
