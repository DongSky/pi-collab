# ADR-013: Supervised checks on immutable snapshot versions

Date: 2026-09-23. Status: implemented for trusted native execution. This is evidence for specified checks, not integration, review or release approval.

## Version and authority

Migration `009-snapshot-validation.sql` adds immutable repository-scoped validation profiles and durable validation jobs. A project Maintainer creates a new profile version instead of modifying a command that old evidence references. Each version specifies one to five Node/npm steps, argument arrays and a one-to-600-second timeout per step. Shell command strings, browser-supplied host paths and inherited process configuration are not invocation parameters. Repository scripts are still arbitrary trusted code.

A current task owner with Developer authority, or a Maintainer, requests checks for a ready native snapshot using a profile for the same repository/project. Owner/Admin MFA requirements apply. The request freezes snapshot ID and manifest SHA-256 plus profile ID; admission is idempotent. The organization advisory lock serializes admission against role changes. Both organization and project authorization versions are captured and rechecked at claim, heartbeat and publication. Regrant never reactivates old authority. Project-scoped RLS also applies to lists, configuration and evidence downloads. App connections cannot update profiles/jobs or call executor functions.

The actual code identity is the snapshot manifest's **worktreeCommit**, including staged, unstaged and eligible untracked content. `exportedHead` is only the sanitized committed baseline, and original HEAD is provenance. Passing evidence cannot be transferred to another snapshot/profile or treated as evidence for an original branch with excluded files.

## Execution and evidence

The existing native supervisor claims validation jobs independently of AI inference. It restores verified snapshot bytes into a fresh independent clone/HOME/agent directory. It never uses the original agent's working directory, credentials or installed dependencies. Node is invoked by the supervisor's absolute executable; npm is invoked via the installed CLI script, without a shell at this boundary. npm scripts may invoke shells themselves. Dependency installation must be an explicit configured step. No model access is necessary.

Every attempt exclusively creates `validation-executions/<job-id>/admitted.json` before preparation. This marker and the new workspace prevent re-entering an attempt after a crash. No uncertain command is automatically replayed. Mac/Linux process groups are owned by the live supervisor; termination escalates from SIGTERM to SIGKILL. A parent exit with surviving ordinary descendants fails the check. Stream closure and absent process group must both be confirmed; otherwise the attempt is unknown. Each step's eligible working files are rescanned against the input manifest, so commands which leave changed source cannot certify that input version.

Evidence records snapshot/profile/configuration, manifest/config hashes, working-code commit, actual exit code/signal, timestamps, cleanup and source comparisons, Node binary hash/version, npm CLI hash when used, OS/architecture/kernel and environment-policy version. Raw stdout/stderr is not saved or exposed: the observed merged stream has a maximum 1 MiB hashed prefix, byte count, and explicit overflow failure. These records certify observed commands, not the correctness of arbitrary project tests. A dishonest script can report success just as it can in an ordinary CI system.

`validation-executions/<job-id>/evidence.json` is written after execution, with a private file mode and fsync. The authoritative project-visible record is the database publication; a local file by itself does not approve anything. A lost database response never causes execution to repeat. Restored workspaces and files are retained; no automatic deletion currently runs.

## Queue and failure semantics

States are queued → running → passed/failed/cancelled/revoked/unknown. A short admission lock serializes quotas. Only one pending/running/unknown attempt is allowed for a snapshot; at most two running/unknown checks per project and one per requesting user, plus one validation slot per supervisor. These are separate from AI quotas and are not yet configurable. Unknown attempts retain their quota occupancy.

Leases last 30 seconds with five-second heartbeats. A stop flag or changed authority aborts the live process through its supervisor. Cleanup may renew the current lease but cannot restore execution permission. Expired leases become unknown and are never reassigned. Publication rechecks executor/epoch/current lease and authorization. Confirmed cleanup after revocation can publish revoked; unconfirmed cleanup remains unknown even after revocation. Existing terminal results cannot be overwritten by late callbacks. Audit records cover configuration, requests, starts, stops and final states.

Database connectivity loss aborts execution and suppresses passing publication. A supervisor SIGKILL can leave its detached process alive; a replacement supervisor records unknown and does not signal a PID from persisted data. Administrative reconciliation of validation jobs is still pending, so there is no UI action that pretends to clear this uncertainty. Operators must retain the job/workspace and investigate; direct database edits are not a supported recovery procedure.

## Product and acceptance boundaries

The task view supports immutable profile creation, explicit snapshot/profile selection, durable retries after a lost response, status, cancellation and authorized evidence downloads. Labels say “指定检查通过”; they do not say “可合并”. Snapshot exclusions, fresh dependencies and remaining review/combination checks are visible.

Tests exercise real command processes and SQL, including competing claims, source/environment binding, immutable profiles, scope/MFA/revocation, no inherited secrets, npm execution, nonzero exit, timeouts including SIGTERM resistance, leftover descendants, output limits, source mutation, TCP interruption, supervisor SIGKILL, corruption and no replay. Browser acceptance creates a profile, loses/retries a response, runs a command against the actual snapshot's working content, inspects evidence, rejects unauthorized/CSRF requests and cancels a queued check. It uses desktop and 390px layouts and makes no external model request.

Native execution remains for trusted users on one host and shared local data root. It does not sandbox malicious scripts, prohibit networking, prevent daemonization outside process groups, or isolate arbitrary external resources. Environment fingerprints are not a hermetic environment archive: OS tools, npm's full dependency closure and external services are not completely captured. Docker validation is deliberately unavailable until implemented and verified.

Follow-up [ADR-014](0014-immutable-task-results.md) adds immutable task-result publication, pinned direct inputs and validation provenance for those inputs. Next work: authoritative required-check policy; output artifacts/redacted diagnostics; validation reconciliation and retention; full dependency/environment reproduction; integration-candidate checks against source/target/contract revisions; Docker parity. Full M2/M3 acceptance remains open.
