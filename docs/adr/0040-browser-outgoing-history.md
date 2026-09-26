# ADR-040: Fixed outgoing-history browser review

Status: implemented for native preview generation and read-only review. Durable push confirmation and dispatch remain outstanding.

## Review the entire export

The task view exposes migration 027's preview request, list, detail and cancellation procedures. Requests include only the source revision, HEAD, run revision and idempotency key. The browser stores the exact pending request in session storage before sending; lost responses and page reloads retry the same request. New requests require a deliberate action. The existing native Git broker processes them through its shared lanes; the Web process has no provider credential or receive-pack capability.

A ready preview opens a reader using the **database's manifest hash**. The query hash is a version assertion, never authority. Every request reopens and verifies the original manifest, baseline pack and Git objects, then limits reads to the recorded outgoing commit set and changed paths. There is no path, repository URL or arbitrary object-browser API. Later task edits and removal of the original checkout do not change the export or reconstruct missing artifacts.

All recorded commits are listed, including intermediate versions, merge-side commits and commits whose final tree has no changes. Their full parents, tree, exact commit-object hash and metadata are available. Each commit's file changes are compared with the fixed authenticated remote default baseline. This is deliberately labeled in the UI: it is not a first-parent diff, and an already-existing task branch can still have commits in this default-baseline comparison. New commits which disappear from the final tree remain reviewable through their own recorded version.

Raw tree traversal and UTF-16 secret detection use the same server-only primitives as export. The reader independently verifies the complete changed-path count against the manifest, including explicit deletions of inherited excluded files. Unchanged known remote files are not exposed as arbitrary file reads. Known remote commit metadata is not exposed as an outgoing commit; only the fixed baseline's tree is used for comparison.

## Bounded text and exact bytes

Commit pages contain up to 50 records and file pages up to 100 changes; total and next offset are explicit. New history remains bounded by export's 1,000 commits and object/tree limits. Text is displayed only within 256 KiB and 8,000 lines. Control and bidirectional characters are made visible without changing the original object. HTML and other untrusted metadata are React text, never executable markup.

File previews distinguish missing sides, mode changes, binary or unsupported encoding, long text, byte hashes and raw newline counts. A file object within 2 MiB can be downloaded as exact bytes even when it cannot be rendered as text. Commit objects within the existing 1 MiB export limit also have exact-byte downloads. Oversized inherited baseline files remain explicitly unavailable; there is no claim that every possible old blob was displayed. Downloads use bounded no-store JSON transport; the browser verifies SHA-256 and byte length, then creates an `application/octet-stream` attachment with an object-ID-derived filename.

Excluded content and sensitive UTF-8/UTF-16 historical bytes remain redacted, including through raw downloads. A sensitive historical path prevents the read rather than leaking it through a path list or error. A newly added secret is already rejected by export; the reader additionally prevents old baseline secrets from escaping when a safe new commit deletes or replaces them. Pattern checks are not a guarantee against arbitrary obfuscation.

## Current access and request lifecycle

All routes require a logged-in identity; successful responses are no-store. POST requests require the configured same origin. SQL retains current project scope, task-owner/Maintainer control and organizational MFA requirements for preparation and cancellation. Reviewers can inspect ready history but cannot request a new preview or cancel a producer's operation.

The history reader checks project access before and after filesystem work in a READ COMMITTED transaction. Revocation during actual metadata or raw-byte reads suppresses the already-read result. It permits two simultaneous readers per Web process and enforces a 20-second request deadline. These are bounded local controls, not a distributed deployment or load-test claim. A failed refresh clears selected history; failed authority/version reads clear local review state. There is no public content cache. The browser cancels retired reads and retries only side-effect-free GET responses with status 429, at most five times with bounded backoff. This handles shared reader capacity and development Strict Mode without raising the server limit; mutation retries always keep their explicit original request ID.

Browser file marks are explicitly **local review notes**, keyed by the exact commit and file review hash and cleared on preview switch/reload. They grant no push authority, and the product does not offer a push button. The next durable confirmation must bind the member, complete export, destination and explicit disclosure acknowledgement before entering the one-owner dispatch protocol. It must not treat these browser marks or a ready row as a substitute for current authority or protected-ref checks.

## Integration and evidence boundaries

This change uses migration 027 without editing applied migrations or adding one. It requires current Web code and the existing four-handler native Git service; Docker is not required. Generated browser fixtures use their own App identity and private temporary credentials so they cannot collide with the existing import/sync fixtures. They exercise real Pi tools, PostgreSQL procedures, REST/upload-pack and immutable exports; they never receive-pack or invoke an external model/account.

Meaningful verification includes the history reader suite (intermediate/merged history, pagination, exact binary/UTF-16 bytes, metadata limits, inherited secret redaction, invalid scope/hash/path/object, cancellation and corrupt artifacts), the durable broker suite's scoped reads and mid-read revocation tests, and the isolated two-browser workflow. Full collaboration, types, lint and existing browser flows remain regression gates. Durable confirmation, destination occupancy, production remote dispatch, unknown-result handling, PR/CI and optional Docker parity remain open work.

## Verified results

The final native collaboration suite passed **398/398**, including eight new history-reader tests and two new scoped-reader tests. The targeted preview-broker/read-write client suite passed **39/39**. TypeScript and full lint passed.

The complete isolated browser suite passed with the new history workflow alongside existing identity/MFA, project membership, task, resource, contract, result, integration/review/repair/promotion and GitHub import/sync flows. The GitHub regression now selects its exact installation ID, checks private material is absent from every installation and verifies disabling its own installation leaves the other App unchanged. The separate four-user smoke on the main native service passed. Final desktop and 390px history screenshots were inspected for readability and horizontal overflow.

These results use generated credentials, loopback protocol services and actual native Pi diagnostic tools. They do not establish external account/model acceptance, remote production push or optional Docker parity. No migration was added or changed, and no duplicate main Web or Git service was started.
