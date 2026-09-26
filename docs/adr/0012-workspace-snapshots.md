# ADR-012: Code snapshots and fresh-workspace continuation

Date: 2026-09-23. Status: implemented for trusted native execution with explicit format limits. Full handoff/evidence and disaster-recovery milestones remain incomplete.

## Capture and authority

A task owner with Developer authority, or a project Maintainer, requests capture of a terminal run with a stopped/archived workspace. The request includes run revision, idempotency key and handoff note; existing Owner/Admin MFA requirements apply. The executor independently checks the native exit receipt. Active, quarantined or unconfirmed workspaces cannot be captured.

Migration `008-workspace-snapshots.sql` persists requests, task context and organization/project authority versions. The worker rechecks authority before publication. Regrant cannot revive revoked requests. Ready artifacts remain shared project history after their author leaves. RLS covers listing and manifest access; manifest delivery rechecks access after reading storage.

Capture reads source HEAD, the stage-zero index and eligible working files, including untracked files. Local commits absent from the registered repository contribute their HEAD content. Source operations use no optional Git locks and disable fsmonitor, lazy fetch and replacement objects. External object alternates and symlinked Git metadata are rejected. Two scans must agree; Git writes and diff generation use a fresh scratch repository.

## Artifact and version semantics

Private `snapshots/<UUID>/` artifacts contain a JSON manifest, content-addressed blobs and binary staged/working patches. The manifest binds source run/workspace/repository/base SHA and HEAD, exported HEAD/index/worktree commits, task context, handoff note, modes, SHA-256 hashes, exclusions and omissions. Repeated handoffs retain parent snapshot ID and manifest hash. The working patch includes untracked additions; the separate index preserves their untracked status on restore.

Files and directories are synced before atomic publication. Complete artifacts may satisfy retries only after source identity, note/context and hash verification. Partial directories are ignored; hard-crash leftovers require the planned cleanup service. Lost database responses cause no tool replay.

Exported Git commits describe sanitized content and generally differ from the source SHA. Original SHA and repository base remain provenance. Source configuration, hooks, ancestor history, reflog, HOME, Pi sessions, model profiles and capabilities are omitted. An excluded secret therefore cannot survive in copied Git ancestry. Future integration must use this explicit source/base relationship instead of treating exported commits as original history.

## Exclusions and bounds

Private-path rules cover agent configuration, `.git`, `.env*`, SSH/cloud configuration and common credential/key files. Generated dependency/build/cache directories are excluded. Eligible blobs are scanned for common key/token/password patterns; a sensitive path in any layer is removed from every layer. These heuristics cannot prove the absence of every secret. The UI exposes exclusions and this limitation.

Symlinks, submodules and special files are excluded. Files above 2 MiB are excluded. Limits are 5,000 files per layer, 64 MiB of unique captured blob content and an 8 MiB manifest. Unsafe names and case/Unicode collisions fail explicitly. Unmerged indexes, intent-to-add, sparse/skip-worktree and assume-unchanged flags are rejected because the current format cannot preserve them faithfully. Full format support remains planned.

## Restore and rollout

The current owner/Maintainer selects a ready snapshot for the same task/repository and submits a new instruction/model selection. Existing admission checks still enforce current membership/MFA, task revision, idempotency, active-run exclusion and model availability. A composite foreign key records workspace-to-snapshot lineage. Old executors cannot claim restoration jobs; updated executors use `claim_snapshot_aware`, preventing silent baseline execution during mixed-version rollout.

Before Pi starts or receives a capability, the executor verifies hashes, reconstructs a controlled bare repository from blobs and creates a fresh independent clone. Working tree and index are restored separately. Temporary private Git attribute overrides prevent a second encoding/EOL/filter conversion during reconstruction and are removed afterward. All three restored layers are read back and compared before Pi launches. HOME, agent directory, session, workspace/run IDs, authority and model capability are new. Old files remain unchanged. Corrupt artifacts fail without falling back to another source. Old commands and external effects are never replayed.

## UI, verification and remaining work

The UI provides notes, capture status, changes/exclusions, authorized full-manifest download and explicit “恢复来源” selection. Original and exported SHAs are distinct. The chosen note enters the new prompt as material requiring revalidation. Snapshots do not certify tests or restore databases, services, installed dependencies or processes.

Six storage tests and three database/real-Pi tests cover local commits, staged/unstaged edits, binary/untracked files, UTF-16/raw-line-ending preservation, restored-layer verification, deletion/mode preservation, exclusions, invalid Git/index state, corruption, source identity, deduplication, scope/revocation, new-owner restore, parent lineage, retention references and old-worker compatibility. Browser acceptance uses real Pi diagnostic tools and a fresh browser context to save, inspect and restore; new capabilities and CSRF/authority boundaries are checked. It makes no external model calls.

Follow-up [ADR-013](0013-snapshot-validation.md) adds supervised native validation jobs bound to the manifest and working-code commit. Replayable environment evidence, dependency outputs, full index/submodule support, Docker parity, retention/artifact health, object storage, backup drills, cross-task forks and richer handoff context remain planned. These changes do not complete the full M1/M3 gates.
