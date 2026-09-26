# ADR-015: Versioned work intents and independent scope evidence

Date: 2026-09-23. Status: human declaration, overlap display and saved-code comparison implemented. Pi coordination tools and contract negotiation remain separate unfinished work.

## An intent is advisory, never authority

Each declaration belongs to an actual run, task, project and repository. It records a revision, author, expected relative paths, optional symbol/API identifiers, change type, summary and optional completion estimate. Exact file paths and directory prefixes ending in `/` are supported; wildcard syntax, traversal, absolute paths, Git metadata and control characters are rejected. Symbols are literal identifiers, not parsed source-code assertions.

Only the current task owner who requested the run, or a project Maintainer, may declare while the run is queued, starting, running or waiting for input. Current run authorization, membership versions and Owner/Admin MFA apply. This human API does not expose user session cookies or database credentials to Pi. It is an incremental surface for M2-02; automatically reading/submitting intents through a run-scoped Pi tool is still pending.

Migration 011 creates append-only, project-scoped records and a same-task/run composite foreign key. The restricted application role has SELECT only. The database function serializes against the organization and run, validates JSON independently of HTTP, applies optimistic revision checks and emits a durable event plus audit entry. A repeated request with the same content returns the original revision; reused keys with changed content fail. Stopping a run freezes its history. A lost-response replay can retrieve an existing authorized record after stopping but cannot add or rewrite one. Starting a new run requires a new declaration, including when restoring code.

Natural-language summaries and identifiers are rendered as text. They cannot change roles, terminate a peer, acquire an external resource, execute code or grant access to a path. Updating an intent does not advance a run execution epoch or invalidate code results: interface contracts and integration policy will govern those decisions separately.

## Overlap evidence

The report compares the selected run's latest declaration with the latest declared revision of each other non-closed task's newest run, in the same project and repository. A fresh run without a declaration does not inherit an old run's intent. Completed runs in tasks awaiting review may still conflict, so they remain visible until a new run or task closure replaces them.

Paths compare at directory boundaries. Case and Unicode normalization are folded conservatively for the native macOS filesystem; display spelling is preserved. Equal symbol identifiers also warn, but this is not AST or semantic analysis. Disjoint paths do not generate a path warning. Each warning names the peer task, revision and actual matching scopes. It neither blocks work nor signals any process.

To keep responses bounded, compare the most recent 200 eligible peers, return up to 64 path pairs per peer and the latest 50 declarations in history. Truncation is explicit. Absence of a warning does not claim that undeclared tasks, omitted peers or business semantics are conflict-free. Existing durable project events invalidate the open scope panel, with five-second polling and visibility/network-resume fallback. Latency/load acceptance and dedicated user notifications remain pending.

## Actual code is checked independently

The authorized snapshot scope endpoint verifies the immutable manifest and blobs, then reads the original base tree from the administrator-imported repository. Git runs with controlled configuration and environment, without hooks, external diff drivers or text conversion. The comparator uses original blob identities and executable bits against captured working bytes, including locally committed changes, staged/unstaged final contents, untracked files and deletions. Renames appear as deletion plus addition.

It does not compare merely against the agent's current HEAD: doing so would miss committed changes. Restored workspaces have sanitized Git ancestry, so their comparison also uses the retained original repository base. A missing base, damaged artifact or unsupported filename fails explicitly. It never falls back to an AI-provided changed-file list or silently reports zero differences.

The response identifies snapshot ID, manifest hash, base SHA, working-code commit and frozen declaration revision. It computes undeclared changes from exact final bytes; it does not infer whether a declaration preceded every intermediate write. The append-only history shows when scope expanded. Transient writes that were later restored are outside this saved-code comparison. Current authorization is checked again after filesystem work.

Excluded private/generated/large/symlink/submodule paths are explicitly unassessed, including excluded paths found only in the original baseline. Their contents are not read for this comparison or exposed. The report is therefore not a complete filesystem or security audit. It displays the first 1,000 changes and exclusions, with complete counts and truncation flags. Neither an empty undeclared list nor a downloaded report grants merge approval.

The current implementation recomputes evidence on explicit inspection/download, rather than storing a new mutable verdict or polling file contents. It requires retained repository objects and snapshot artifacts. Continuous scans, report caching, retention/GC, contract revision binding and integration gates remain future work. The new table is additive and does not alter snapshot manifests, worker protocols or migrations 001–010.

## Validation

`tests/collab/work-intents.test.ts` covers concurrent idempotency and conflicting edits, immutable SQL privileges, malformed direct SQL, task/run foreign keys, role removal and regrant, project/repository separation, directory boundaries and Unicode spelling, frozen terminal history, real Pi changes, restored snapshots and damaged evidence. It uses real PostgreSQL, Git and native Pi tools; no external inference credentials are used.

`e2e/collab-intents.mjs` is part of the isolated identity browser suite. It verifies owner and observer access, Origin rejection, a committed response lost in transit, another browser's overlap display, terminal rejection and undeclared code in a real Pi snapshot. It also suspends visibility-based polling to verify event-driven invalidation. Durable-event and visibility/network-resume refresh are explicit. A later reproduction traced the initial intermittent warning timeout to a late run-configuration response replacing the selected repository; the tasks were in different repositories. The cancellation fix and deliberately delayed-response browser regression are described in [ADR-016](0016-contract-revisions.md). Safe screenshots are `work-intents*.png` and `scope-report*.png`. The default remains native without Docker; Docker isolation and coordination-tool parity are not claimed by these tests.
