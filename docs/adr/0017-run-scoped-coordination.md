# ADR-017: Run-scoped Pi coordination and durable task notes

Status: implemented for trusted native development; external model acceptance and Docker parity remain pending.

## Decision

Each native run exposes four version-1 Pi extension tools: `collab_get_context`, `collab_declare_intent`, `collab_propose_contract`, and `collab_send_note`. Underscores replace the planning document's provisional dotted names for provider compatibility. The executor explicitly loads one managed extension; automatic project/global extensions, context files and skills remain disabled. Startup requires a capability-authenticated registration handshake before the run can execute its driver. Missing extension registration fails the run and stops Pi.

The supervisor opens an ephemeral loopback endpoint for that run, with a random capability bound by closure to its executor ID, run ID and epoch. No caller-supplied identity or repository can replace that scope. The database checks the current lease, status, organization and project authority on every call, including reads and idempotent replays. A stopped, expired, revoked or old run cannot reuse its tools. Regranting membership does not revive the old authorization version. The capability is separate from model access and conveys no browser session or SQL credentials. The extension removes its capability environment variables before launching ordinary shell tools. The endpoint closes during run teardown.

Loopback requests reject Origin, Cookie, incorrect Host, unexpected methods/endpoints and unrecognized fields. Limits are 64 KiB requests, four concurrent requests, 120 requests/minute/run, 200 successful mutations/run, and 20 notes/minute/author/project. The latter two limits are durable database checks under the organization lock. Lost responses preserve the same request UUID and exact payload; a modified replay fails. There is no automatic retry of an uncertain write with a new UUID. Under a database failure the endpoint returns an unknown outcome with same-request retry guidance. Rate limits are initial fixed policy, not configurable scheduling.

This is a trusted local process boundary, not a same-user hostile-code sandbox. A separate process with equivalent host privileges can inspect process memory/files. The tools do not claim resource fencing, isolated networking or protected deployment credentials. Docker runs do not receive these tools until their network and authority paths are separately verified.

## Narrow actions and provenance

`get_context` reads only the bound task: fixed dependencies/contracts, whether their lineage is still current, current contract revision metadata, latest scope, overlap warnings, related tasks and task notes. Exact pinned contract bodies remain in `../contracts.json`; context output carries hashes and IDs instead of duplicating all definitions. Related tasks are same-project direct dependency neighbors, tasks sharing a published contract, or tasks whose latest run uses the same repository. This definition also gates AI note targets and explicit affected tasks in an AI contract proposal. Humans with task control may leave notes to any task in their project.

Context displays at most 100 related tasks and current contracts, compares 200 peer declarations, shows 20 overlap entries with eight paths/symbols each, and pages five full notes at a time. Truncation and the next note cursor are explicit. The database allocates note order under the project row lock, preserving commit order so paging cannot skip a later-committing earlier sequence. Notes do not depend on an active recipient run to persist. Resource availability explicitly says the shared-resource broker is not yet implemented.

`declare_intent` uses the same optimistic revision history as human edits and marks AI provenance. It cannot overwrite a later human declaration or claim exclusive access to a path. Actual diff evidence remains independent. `propose_contract` fixes the producer task and repository to the run, checks the expected parent, and stores source run/epoch. It does not expose human approval, override or publication functions. The executor SQL role cannot call those human endpoints directly. Published versions still require the existing human confirmation/override protocol.

`send_note` appends a typed question, finding, blocker or handoff with source user, source task/run/epoch, target task, request UUID and up to eight immutable result/contract revision references. References must resolve within the same project. Neither human nor executor roles can directly update/delete notes. Source metadata is rendered separately from the untrusted body. Natural language, HTML-like content and quoted instructions stay project data; they do not change permissions, approve contracts, set task state or inject a prompt into another Pi process.

Notes are retrieved by `get_context`, with the task prompt asking Pi to read before editing and at safe boundaries. This is pull-based coordination; it does not guarantee when a model will read/respond and does not interrupt a running tool. Browser views use existing project events plus visible-page and reconnect polling. They retain lost-response requests, show human/AI attribution, support named task targets and keep up to 500 loaded notes in the page. The authorized API pages the full durable history. Dedicated read receipts, notification delivery and automatic event-to-agent safe-point injection remain future work.

## Storage and upgrade

Migration 013 adds append-only task notes, executor-private idempotency records and agent provenance columns to existing scope/proposal tables. It does not edit migrations 001–012. The security-definer dispatcher takes the organization lock before the run/workspace lease locks. Temporary actor identity is derived from the run and restored within the same transaction before returning. SQL helpers without independent authority checks are not callable by either app or executor roles.

Apply 013 before restarting the supervisor and web code. Old workers can continue their existing runs without collaboration tools; their behavior does not create forged notes or confirmations. In-flight source work remains isolated and pinned. Notes, request records and provenance must be included in backups; no automatic retention/garbage collection is introduced here.

## Acceptance

`tests/collab/coordination.test.ts` exercises real PostgreSQL authority, immutable grants, concurrency/replay, human/agent edit races, exact revision references, unrelated/cross-project denial, revoked/expired/stopped runs, pagination and quotas, HTTP transport guards and failure with missing extension registration. A local Responses protocol fixture drives two real Pi processes through all four tools concurrently. It checks independent code changes, disabled untrusted project extensions, absence of capability/database variables in normal shell tools, persistent source attribution and lack of human approvals. This is real Pi/tool execution with fixture model responses, not external inference.

The isolated browser suite exercises two members exchanging notes, an explicitly marked agent-note protocol fixture, exact contract references, lost-response retry, scope/Origin rejection, literal rendering of script-like text, reload recovery and desktop/390px layouts. Screenshot evidence is limited to `coordination-notes*.png`; identity-server logs remain private.

Next: managed resource allocation/fencing and immutable integration candidates. Result publication, resource acquisition, control transfer, protected Git delivery and automatic conflict resolution are not added to this tool surface.

Follow-up: [ADR-018](0018-managed-postgres-resources.md) adds four fenced PostgreSQL resource tools through the same run-scoped coordinator. The historical four-tool boundary above describes migration 013.
