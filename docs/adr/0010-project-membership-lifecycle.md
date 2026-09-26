# ADR-010: Project authority, membership revocation and emergency governance

Date: 2026-09-23. Status: implemented and verified for native project membership/assignment flows.

## Membership and authority

Project membership is a retained record with `active` and monotonically increasing `authorization_version`. Deactivation does not delete task owners, run requesters or audit history. Effective project access requires both active organization membership and active project membership. Re-granting access advances the project version instead of reviving old authority.

A new run binds organization and project authorization versions in the same acceptance transaction. Worker callbacks, lease checks and the model gateway require both versions to remain current. A role change or project deactivation cancels queued work and requests active runs to stop. Even a later upgrade cannot restore an old run capability. Runs in another project remain authorized when their own memberships have not changed.

Maintainers can add existing active organization members, choose project roles, deactivate and reauthorize project membership. New accounts still use organization invitations. Owner/Admin actors must have MFA for sensitive project administration; ordinary organization members with explicit Maintainer roles retain optional MFA under the first-version policy. Direct web-role inserts can only install the creator's initial Maintainer membership. Subsequent grants use narrow audited functions or invitation acceptance.

Member changes require an expected version, preventing a stale settings tab from overwriting a newer decision. No-op saves preserve the version and do not stop work. A project membership operation cannot remove/demote the last effective Maintainer, including two concurrent self-demotions.

## Emergency governance

Organization security revocation is not blocked merely because a user is the sole project Maintainer. An organization Owner/Admin can list project governance metadata (ID, name, effective Maintainer count and their own role), while ordinary project contents remain protected by project membership.

Emergency self-enrollment requires current organization administration, MFA and a 10–2,000 character reason. It grants an explicit Maintainer membership and appends `project.emergency_access` with the reason. It does not make every organization administrator an implicit member. The normal project page and audit API remain inaccessible before the grant.

An inactive target cannot regain project membership by accepting an invitation. Changing an inviter's project role/active state revokes their outstanding project invitations; re-granting the inviter cannot resurrect those links.

## Task reassignment

Maintainers can reassign an unfinished task to an active Developer/Maintainer using the task's current revision. The assignment stops old queued/active runs and retains their original requester and workspace identity. A new owner must submit a new run and wait until any prior writer is confirmed stopped. Unknown/reconciling work still blocks restart. This is task assignment, not live session-control transfer or snapshot-based resume.

Web-role direct updates to task ownership are revoked. Task creation RLS also validates actor/assignee eligibility, in addition to service checks. UI retains historical owner names and marks inactive assignment; records are not silently reassigned when someone leaves.

## Transaction order and streaming

Membership administration, start/stop admission and invitation acceptance serialize using the organization advisory lock. Invitation acceptance acquires that lock before its invitation row lock. Revocation locks the entire affected run set before emitting project events, avoiding a cycle with another run completing and requesting the same project event row. Task reassignment locks runs before the task row to match executor completion.

Project SSE checks current organization/project authorization versions each iteration, including slow consumers under backpressure. A changed version closes the old stream with an authorization event; removed members also lose transcript, repository, model and audit APIs. A project role change does not revoke otherwise valid login sessions or unrelated project access. Reconnecting explicitly reauthorizes against current permissions.

## UI, audit and verification

Project settings provide add/update/deactivate/reactivate controls, task reassignment and paginated project audit history. Organization settings expose governance metadata and the reason-based emergency action. Audits remain append-only to the web role and project-scoped for reads.

Fourteen dedicated real-PostgreSQL tests cover role/MFA boundaries, stale versions, concurrent last-Maintainer protection, cross-project access, inactive invitation rejection, invitation/revocation lock contention, multi-run completion/revocation contention, task handoff, audit pagination and actual Pi/ordinary descendant shutdown. Browser tests cover the corresponding member UI, project SSE closure within five seconds, independence of another project, reassignment, actual MFA-enrolled administrator emergency access, audit reason and desktop/mobile layouts. Browser run state transitions are explicitly protocol fixtures; native Pi stopping is tested separately.

Native run reconciliation and logical workspace archival are implemented separately in [ADR-011](0011-native-run-recovery.md), and native code snapshots in [ADR-012](0012-workspace-snapshots.md). Verified environment handoff, live control requests/transfer, personal MFA disaster recovery, project deletion/archive and notification delivery remain planned work. This decision does not assert those milestones or full-platform acceptance.
