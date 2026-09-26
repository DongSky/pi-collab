# ADR-026: Lease writes allow references from peer notifications

Status: implemented for native collaboration; migration 021.

## Problem

One full regression run produced an unexpected `reconciling` result while two real Pi processes exchanged coordination notes. A deterministic PostgreSQL test then reproduced a `40P01` deadlock: the output transaction held a peer run's `FOR UPDATE` lease lock and waited for the project's event counter; the notification held that counter and waited for a foreign-key reference to the peer run. Treating lost output as uncertain was correct, but this avoidable database conflict interrupted otherwise valid work.

## Decision

Migration 021 changes the run lock in `collab_worker.assert_lease` to `FOR NO KEY UPDATE`. Lease and state updates do not change run identity. The lock still serializes mutable state writers and conflicts with deletion/key changes, while allowing `KEY SHARE` references to an existing run. Workspace lease locking, expiry checks, executor/epoch fencing, event ordering and conservative handling of unknown effects remain in place. A null generation is explicitly refused at the shared lease boundary.

This is a new migration; applied migrations are not rewritten. No transaction retries or automatic reruns of AI/tool work are introduced. Docker is not required for the fix or tests.

## Verification

The regression uses two actual database connections plus an advisory-lock barrier installed only in an isolated test database. It pauses a coordination notification after allocating the project sequence, holds the peer's lease transaction, starts its output append, then releases the barrier. Before migration 021 the output receives `40P01`; afterwards both the durable notification and output succeed. Existing execution, authorization revocation, task handoff and real parallel Pi tests also exercise the unchanged fencing behavior. Test barriers and temporary databases are removed after execution.
