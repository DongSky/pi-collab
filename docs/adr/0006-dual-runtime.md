# ADR-006: Native by default, optional Docker execution

Date: 2026-09-23. Status: accepted product direction; implementation and verification ongoing.

The user explicitly prefers avoiding Docker and requests both native and Docker variants. pi-collab therefore uses the same web/API, PostgreSQL schema, authorization, task graph and Pi protocol in both modes. Only process provisioning and runtime isolation differ.

## Native profile

Local development starts a project-owned PostgreSQL process using the pinned embedded-postgres package. It does not install a system service, create an OS user or require a container daemon. Database files and generated credentials live under `.local/`; the app connects as a separate non-superuser/non-BYPASSRLS role. Production can supply a separately administered PostgreSQL service later.

Each agent uses a separate Pi process, HOME, agentDir, session storage and independent Git clone. Credentials and host environment variables are not inherited. Clones share neither writable Git metadata nor object hardlinks. Process groups allow the native adapter to stop an agent and ordinary descendant commands.

This prevents accidental cross-task writes and separates state, but processes with the same OS identity are not a hostile-code sandbox. An explicitly malicious shell can still attempt host filesystem/network access, and a daemonized process can evade process-group cleanup. Native mode is for trusted local use; sandbox-specific acceptance must not be reported as passed for this profile. A stopped parent is not proof that arbitrary descendants have stopped; unknown writer state requires quarantining its workspace.

## Docker profile

The optional backend runs the same Pi JSONL RPC protocol in an unprivileged container with a read-only image, per-workspace mounts, resource limits, no Docker socket, dropped capabilities and no-new-privileges. Network access stays disabled. A bounded stdio relay now connects per-run model and coordination capabilities and GET requests to the fixed npm registry; it is not a general HTTP proxy.

Image build, two real container Pi agents, gateway protocol tools, control transfer, npm environment reconstruction, stopped snapshots and browser handoff now have focused acceptance. See [Docker runtime](../docker-runtime.zh-CN.md). Container validation and complete Git delivery remain incomplete, so full parity is not claimed. Docker is not started by `dev:local`, `dev:services` or native tests.

## Consequences

- All functional tests run against both backends where applicable; mandatory-access-control tests belong to the isolated deployment profile.
- Permission, task ownership, Git revision checks and shared-resource brokering apply to both modes.
- Native mode cannot promise broker enforcement when a user separately gives a shell direct access to the same external resource. Such resources are outside the controlled execution boundary.
- Default dev port is 30142; 30141 remains available for explicit upstream comparison.
- The library package version includes a beta suffix. Real PostgreSQL startup, restart, migrations and RLS tests are required, not just a dependency installation check.
