# ADR-009: Project model capabilities and a native Responses gateway

Date: 2026-09-23. Status: implemented protocol foundation; real-provider acceptance and Docker networking remain pending.

## Decision

The native profile has a separate loopback model gateway. Web, executor and gateway use three restricted PostgreSQL roles. The gateway cannot read account tables or mutate run ownership. The executor can issue a capability for its own live run/epoch but cannot read provider credentials. Pi receives a fresh managed `models.json` containing only a random run capability; its model selection is explicit and project-local Pi settings/resources are disabled.

A project model profile fixes a model ID, API adapter, context/output bounds, per-run request/token limits and a shared project daily token budget. A run binds its model selection in the same transaction as command acceptance. Changing the model under an existing idempotency key is rejected. Models in another project cannot be selected by guessing their IDs.

Only `openai-responses`, text inputs and local function tools are supported in this adapter. Images, external file references, stored response IDs, provider-hosted tools, arbitrary headers, redirects, premium service tiers and unrecognized request options are rejected. Provider credentials do not become generic HTTP proxy credentials. Other API styles remain unavailable until tested.

## Credentials

An explicitly invoked local administrator command can import one selected literal key/model from personal Pi configuration. It does not run credential shell commands, import historical sessions or copy the entire personal profile. Registration requires an active project maintainer; privileged organization members also require MFA. The audit identifies the local administrator CLI rather than pretending a browser session performed the import.

Provider endpoint and key are sealed with AES-256-GCM. AAD binds the record to its model profile and project. The 32-byte master key is stored outside the database, in a private local file for development; production must provide a separate key-file path. A running gateway never creates a missing key. Registration cannot replace a missing key when encrypted credentials already exist. Restores must include the original key; rotation/backup tooling remains outstanding.

Native processes share the operator's OS identity. File permissions and a separate HOME prevent accidental inheritance; they do not prevent hostile code with that same identity from reading host files. This gateway improves credential handling and central admission in trusted native mode. Strong secret/network containment requires the separately verified isolation profile.

## Admission, quotas and cancellation

The capability is random, stored only as a SHA-256 digest in PostgreSQL, expires after 30 minutes and is bound to run/executor/epoch. Each call rechecks the current run state, workspace lease, organization authorization version, project/task control and enabled model profile. Gateway reads never extend a runner lease. An active upstream stream is rechecked every second; database checks have a three-second deadline. Revocation cannot retract a provider request already accepted, but subsequent requests are denied and an in-flight stream is aborted after detection.

Admission serializes at the project budget row. It reserves the complete configured context window plus the bounded output allowance, limits each run to one in-flight request and counts every request against its per-run cap. The project budget uses UTC admission dates; a call spanning midnight remains charged to its admission date. Adding another profile does not silently raise an existing project budget.

A valid terminal usage event followed by complete stream termination settles observed input/output tokens. Unknown, malformed, interrupted and failed requests retain their full reservation. A crashed gateway's outstanding reservation is not refunded or replayed automatically. Cache tokens are included in the provider's reported input count. These are token/request controls, not verified currency accounting; model-specific pricing, gateway crash reconciliation and budget-management UI remain outstanding.

The proxy itself makes no retries. Managed Pi profiles also disable automatic retries and compaction for this first adapter. Limits apply to upstream calls even if a runner manually repeats a request. Tool execution continues to be owned by the independent executor and its lease protocol.

## UI and evidence

The task page provides model/repository selection, prompt submission, run history, live visible output, replay on refresh, and stop requests. A lost HTTP admission response reuses the same command key and payload. Completion is labeled as an ended model run, never as successful CI or an approved merge. Quarantined workspaces remain visibly blocked; there is no UI bypass around pending reconciliation.

Validation includes real PostgreSQL privilege/RLS checks, two concurrent real Pi processes receiving Responses function calls through a deterministic protocol service, credential separation, mismatched scopes, budget races, unknown outcomes, stream revocation, stale epochs and ignored project-local model/package settings. Browser tests independently exercise lost-response retries, output replay, observer permissions and stopping, with desktop/mobile screenshots. These fixtures do not establish provider intelligence or billable-model acceptance.

The adapter was checked against the pinned Pi 0.87.0 Responses implementation. Attempts to fetch current official OpenAI streaming documentation returned HTTP errors in this environment; third-party provider compatibility and exact current protocol coverage must be established by real-provider acceptance rather than inferred from an official API name.

Docker remains optional and never starts during native tests. Its current network-disabled adapter explicitly rejects configured model runs until gateway networking and container lifecycle parity are verified.
