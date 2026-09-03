# Registry, project session, and edit authority

Status: accepted (2026-09-01, [Grilling: ratify the registry, project-session, and edit-authority contract](https://github.com/wojtekpiskorz/astroix/issues/204); lifetime-held lease proof [#209](https://github.com/wojtekpiskorz/astroix/issues/209); recorded by lane A1, [#210](https://github.com/wojtekpiskorz/astroix/issues/210))

## Context

The boundary (ADR-0004), runtime (ADR-0005), threat model (ADR-0007), and packaged-host proof ([#201](https://github.com/wojtekpiskorz/astroix/issues/201)) left one contract unsettled: exactly what state the app exposes and who may act on it — project identity, registry persistence, the single active session's lifecycle, request authority, resource handles, and the wire protocol. The existing integration remained a migration oracle, not a compatibility contract: client-supplied paths, lexical-only containment, optional write baselines, generation-free query keys, and browser-visible implementation details do not carry into the rewrite.

## Decision

### 1. Registered-project identity and routing

- A registered project's identity is its **canonical filesystem root**: `fs.realpath` plus the filesystem's own case and identity semantics. A root symlink or case alias resolves to the existing record; arbitrary paths are not lowercased.
- **`ProjectKey` is not derived from the root**: it is a random 128-bit lowercase-Base32, DNS-safe routing key allocated when the registry record is created, stable only for that record's lifetime. Remove + re-register the same root creates a new key and therefore a fresh browser origin.
- The **display name** is separate from identity and routing (defaults to the canonical root's basename; editable from the native launcher). An alias registration neither duplicates nor silently renames.
- A stale or temporarily unavailable root stays visible until explicit removal; **removing a registry record never removes project files**. Browser-visible summaries contain only project key, display name, and sanitized availability — absolute roots and process details stay in the control plane.
- Registration accepts a **native directory grant, never a browser-supplied path**. Version 1 has no in-place root rebinding: an unavailable record is removed and the root registered as a new record (key and origin rotate); remove/re-register is rejected while the record is active; a display-only rename may occur while active.

### 2. Registry ownership and persistence

- Electron main owns the app single-instance lease and gives one exact control-plane child a **one-use boot capability over private IPC**. That child must also acquire and **lifetime-hold a kernel-backed exclusive registry-writer lease** before opening listeners or mutating state. Web entry points cannot acquire registry write authority; tests use an explicitly injected isolated registry.
- Closing the private main-to-child IPC channel is terminal for registry authority: the child immediately fences writes, releases listeners and the writer lease, and exits. A replacement main fails closed until the old child has actually released the lease. The boot capability alone is never a durable lock.
- Persistence: a strictly versioned JSON document below Electron `userData`; registry directory mode `0700`, files `0600`; writes use a same-directory temporary file, file `fsync`, atomic rename, directory `fsync`; a last-known-good snapshot is maintained separately.
- Only explicitly recognized schema migrations run. A corrupt document or unsupported future schema is **quarantined**; startup then shows the neutral launcher with explicit restore/recovery choices — never silent restore, guessing, or auto-activation.
- The lease mechanics are the dependency-free `node:sqlite` adapter proved by [#209](https://github.com/wojtekpiskorz/astroix/issues/209): stock Node `DatabaseSync` (`allowExtension: false`, `defensive: true`, `timeout: 0`, rollback journal `delete`, `BEGIN IMMEDIATE`) on fixed private files (`registry-writer.sqlite`, `edit-writer.sqlite`), connection and transaction retained until process exit; only `ERR_SQLITE_ERROR`/`database is locked` on the exact qualified pin maps to contention; any busy-shape drift or pin change fails as unqualified. A persisted PID or ownership record is diagnostic data at most — never live ownership, never a kill target. Successful exclusive lease acquisition is the only same-boot proof no live writer remains; ambiguous owners fail closed.

### 3. Public session identity and secret request authority

```ts
type SessionRef = { runtimeEpoch: string; generation: number };
```

- `runtimeEpoch` is a fresh random public value per control-plane lifetime; `generation` increases for every activation attempt (including failed or cancelled ones) and is not persisted across epochs. The pair prevents stale reuse after both switches and app restarts. `SessionRef` is correlation and freshness data, **not authentication**; every session-scoped command, response, error, query key, and event carries the exact pair.
- Request authority is a separate random **256-bit capability**. The launcher and every project activation receive different capabilities. A project capability is a host-only, `HttpOnly` cookie with `Path=/` (required because Vite HMR upgrades outside `/__astroix/`); it never appears in a URL, JSON body, event, log, or JavaScript value. Astroix validates it on HTTP and WebSocket entry and **strips it before forwarding** either request to the managed Astro/Vite server.
- The origin-wide cookie is necessary but not sufficient for edit authority: Electron also binds a random **per-document client capability** to the exact authoritative `webContents`, top-level navigation, and `SessionRef`, injected after JavaScript request construction. Astroix overwrites any same-named renderer header, validates the injected value, and strips it before upstream proxying. Revoked on navigation, renderer loss, debugger detach, or session replacement.
- Diagnostic targets use separate read-only client capabilities and never receive an editor lease or editable grants; reusing a hostname or receiving a rotated host cookie cannot upgrade an old tab. The **one editor and up to three diagnostics are server-enforced roles**, not UI conventions. Project keys, ports, hostnames, and `SessionRef` values are routing or freshness information — none is an authority token.

### 4. Session state and activation transaction

```ts
type SessionSnapshot = {
  active?: ActiveSessionSnapshot;      // ready or stopping
  attempt?: ActivationAttemptSnapshot; // starting or committing
  lastFailure?: SessionFailure;
};
```

- The source of truth is the snapshot, not a flat enum; the launcher may derive the familiar `idle`/`starting`/`ready`/`stopping`/`failed` labels. `failed` means no active authority remains and the latest attempt failed; a staged-candidate failure while an old project is ready is a notification, not the global state.
- Activation, deactivation, and quit share **one serialized transition protocol**:
  1. Reserve a new generation; start one candidate privately; a concurrent activation fails `409`. The existing ready project stays authoritative while the candidate starts and passes readiness; candidate failure rolls back without disturbing the old session.
  2. Freeze new editor input; submit pending debounces to the existing session's serialized server queue; fence server admission; wait up to **5 seconds** for every accepted operation to reach a terminal result. One drain — not a client drain followed by a server drain.
  3. A conflict or write failure aborts the transition: every accepted operation is terminal and old authority unrevoked, so roll back the candidate and resume the old editor. A drain timeout also aborts, but the old editor stays fenced until all accepted work is terminal; the UI may keep waiting or offer explicit force.
  4. The force path revokes old admission and terminates the exact disposable session write executor, observing its exit before granting new authority; affected write outcomes are reported unknown. If forced reap is incomplete after its **2-second** deadline: atomically persist a boot-scoped incomplete-cleanup tombstone, issue no commit receipt, grant no new session authority, roll back any candidate, enter a blocked no-active state. No timed-out fence resumes merely because the transition was cancelled.
  5. A **one-use switch-preparation receipt** binds the exact old `SessionRef`, candidate `SessionRef` or deactivation target, authoritative client, fence, and preparation outcome. A normal receipt requires a terminal drain report; a forced receipt requires proof the exact old write executor exited. Consuming either receipt is the **commit linearization point**; commit revokes the old host and client capabilities, session authority, routes, streams, and sockets before granting candidate authority.
  6. After commit: activation resets the client, performs top-level `location.replace()` to the project app, and awaits the exact main-frame ready handshake with the Service Worker bypass still attached; deactivation replaces the top level with the launcher and awaits launcher readiness; quit closes the target without navigating. The native host observes and reports each asynchronous outcome.
  7. Failure before the linearization point rolls back the candidate and may resume the drained old session. Failure after revocation is **irreversible**: revoke and reap the candidate if granted, show the launcher when a target remains, report `failed` with no active session. The old session is never resumed after revocation.
- There is **one authoritative editing client**; additional diagnostic tabs are read-only with separately bound authority. Failed activation may be explicitly retried; there is no automatic project restart.

### 5. Browser and client reset semantics

- Browser-callable global control operations are exactly `listProjects()`, `activate(projectKey)`, `deactivate()` — launcher and authoritative project target only. Project inspection and editing exist only on the active project host with its current `SessionRef` and capability.
- TanStack Query keys start with `['astroix', runtimeEpoch, generation, ...]`. At commit the client aborts old fetches, closes old SSE, removes old-generation queries, and clears live DOM selection, canvas state, active entry, edit grants, undo state, scheduled debounces, and pending mutations before navigating.
- A retired project host returns `421 Misdirected Request`. An old tab stays invalid after an A-to-B-to-A cycle (new generation, host capability, client binding). Menu actions capture the `SessionRef` visible at creation and reject if stale at execution. App shell, API, and event responses use `Cache-Control: no-store`.

### 6. Edit authority

- Each project session owns an exact, disposable, serialized **write executor**. `EditAuthority` dispatches accepted filesystem work to it; the long-lived control plane coordinates the gate and grants but retains no in-process write that could outlive forced teardown. A candidate's executor stays fenced until commit.
- The active write executor **lifetime-holds a kernel-backed, app-global edit-writer lease** until all accepted work is terminal and it exits; a candidate cannot acquire it or receive edit authority before the old executor releases it. Exclusive acquisition is the only same-boot proof no orphaned executor retains write authority.
- The server issues **opaque, random, per-activation resource grants** from its own Content and style discovery/planning results — the browser never asks the server to bless an arbitrary path. The grant table binds each grant to the canonical project identity, `SessionRef`, resource kind, allowed operations, canonical existing target or canonical creation parent, and revision contract; a project-relative display path may be returned for UI only and is never accepted back as authority.
- An existing text resource requires its **exact SHA-256 baseline**; creation requires an explicit expected-absent baseline and a contained canonical parent, then exclusive creation. At execution, repeat `realpath`/`lstat`, containment, session, grant, operation, and revision checks **immediately before commit**; existing-file replacement uses a same-directory temporary file plus atomic replacement after the final check. An internal symlink is editable only when its resolved target stays inside the canonical root; an external symlink receives no grant; version 1 rejects targets with `nlink > 1`.
- A stale, revoked, mismatched, cross-session, or changed-at-final-validation grant fails **without writing**. Successful writes return the resulting revision and, where another edit is allowed, a grant bound to that new revision.
- SHA-256 is **optimistic concurrency, not a cross-process compare-and-swap**: a non-cooperating IDE or agent can still change the destination in the interval between final validation and atomic replacement, and that edit may be overwritten. Version 1 discloses this residual race and never claims lossless coordination with external writers. Expected-absent creation remains race-safe through exclusive creation.
- Content serialization and CSS splice planning stay domain-specific; admission, debounce scheduling, ordering, fencing, draining, conflict reporting, and revocation are shared app-client/edit-authority mechanics (the shared seam ADR-0002 amendment 5).

### 7. Protocol version 1

- Control traffic lives below `/__astroix/api/v1/`; every envelope carries `protocolVersion: 1`. Session-scoped responses and SSE events carry `SessionRef`; lifecycle results carry the target reference and current snapshot; a global registry read does not invent a session reference while idle.
- **Events are SSE** at `/__astroix/events` — the only transparent WebSocket is Vite HMR.
- Mutations require exact `Host` and `Origin`, the correct host capability, the correct launcher/editor client role where applicable, JSON content, and `X-Astroix-Request: 1`. Reads require exact `Host`, the capability, same-origin Fetch Metadata, and a client role permitted for that resource. No CORS grant. SSE requires exact `Host`, `Origin`, host capability, client binding, and `SessionRef`. The Vite HMR upgrade validates exact `Host`/`Origin`, the active route, the activation capability, and Vite's token/subprotocol contract before proxying.
- Reject unknown JSON fields, duplicate security-relevant headers, absolute-form request targets, ambiguous encodings, and unsupported protocol versions.
- Initial hard limits: **64 KiB** registry/lifecycle JSON; **8 MiB** per edit request and per editable text resource; **32 MiB** per inspection response; **256 KiB** per SSE event; **16 KiB** public error details; **one** authoritative SSE client; **three** read-only diagnostics clients. Per-resource, per-response, per-event limits — list and inspection APIs paginate before their cap. Binary assets need a later, separately bounded streaming contract.
- Errors use a stable envelope (`protocolVersion`, `requestId`, optional `session`, `error.code/message/retryable/details?`); `PublicErrorDetails` is a closed, code-specific union of sanitized fields, omitted for codes without an approved schema; public errors never disclose roots, ports, PIDs, environment values, capabilities, or stacks.

### 8. Lifecycle limits and close reports

- Candidate startup deadline: **30 s**. Graceful project stop after authority revocation: **5 s**; forced termination reap: **2 s**.
- A close report is explicitly complete or incomplete, lists sanitized cleanup-failure categories, and never exposes PIDs. Only exact live child handles and the transient process group created by this supervisor are cleanup authority; persisted PIDs and unknown detached or reparented descendants are not — the app reports the honest orphan-recovery limit.
- An incomplete forced reap may still let quit finish with an incomplete report, but cannot authorize another session merely by restarting the app: the boot-scoped tombstone survives relaunch; on the same machine boot, activation stays blocked until exclusive edit-writer-lease acquisition proves no old executor remains; on a later boot the tombstone is stale by construction and may be cleared.

### 9. Boundary interfaces

Normative at the seam (`packages/runtime`); closed command/result unions and snapshot types carry the variants:

```ts
interface ProjectRegistry {
  snapshot(): RegistrySnapshot;
  execute(command: RegistryCommand): Promise<RegistryResult>;
  close(): Promise<void>;
}

interface SessionSupervisor {
  snapshot(): SessionSnapshot;
  begin(project: ProjectKey): BeginActivationResult;
  revoke(reason: RevokeReason): Promise<RevokeResult>;
  subscribe(listener: SessionListener): Unsubscribe;
}

interface ActivationAttempt {
  readonly ref: SessionRef;
  readonly ready: Promise<StagedCandidate>;
  cancel(reason: CancelReason): Promise<CloseReport>;
  readonly closed: Promise<ActivationOutcome>;
}

interface StagedCandidate {
  commit(): Promise<CommitResult>;
  rollback(reason: RollbackReason): Promise<CloseReport>;
}

interface AppClient {
  readonly events: ReadableStream<AppEvent>;
  projects(): Promise<readonly ProjectSummary[]>;
  forSession(ref: SessionRef): SessionClient;
  prepareReplacement(target: SessionTarget): Promise<PreparedReplacement>;
  completeReplacement(commit: CommittedTransition): Promise<CompletionResult>;
  cancelReplacement(preparation: PreparedReplacement): void;
  close(): void;
}

interface SessionClient {
  inspect<R extends InspectionRequest>(
    request: R,
    signal?: AbortSignal,
  ): Promise<InspectionResult<R>>;
  scheduleEdit(input: { key: string; debounceMs: number; build: () => EditCommand }): ScheduledEdit;
}

interface EditAuthority {
  issue(resource: DiscoveredResource): ResourceGrant;
  execute(grant: ResourceGrant, operation: EditOperation): Promise<EditResult>;
  fence(reason: FenceReason): EditFence;
}

interface EditFence {
  readonly outcome: Promise<DrainReport>;
  resume(): void;
  revoke(): Promise<EditorCloseReport>;
}
```

`StagedCandidate.commit()` is deliberately paramless — staging cannot validate a proof it never minted: the one-use receipt is minted and consumed by the switch coordinator's receipt-consuming composition (`session-supervisor/commit/`, #238), whose consumption linearizes the commit and then drives the candidate's state-side commit (the two-seam settlement of #238). `RegistryCommand` is a closed union (register, rename, remove, explicit last-known-good restore) with no root-rebind command. `DiscoveredResource` is control-plane-only; the wire representation of `ResourceGrant` is opaque. `PreparedReplacement` contains the one-use opaque receipt issued only after a terminal bounded drain or a forced preparation proving the exact write executor exited — it cannot be manufactured from request fields. A native switch coordinator calls `prepareReplacement()`, consumes the receipt through candidate commit or deactivation, then `completeReplacement()` (asynchronous, host-observed; failures feed the supervisor's irreversible post-revocation path, never a renderer-side rejected promise with stale authority behind it). `cancelReplacement()` is legal only before old-authority revocation and resumes the fence only after a terminal drain. `EditFence.outcome` settles within the 5-second drain deadline with a drained/failed/timed-out report; `resume()` rejects unless every accepted operation is terminal and revocation has not begun; `revoke()` is idempotent and closes admission synchronously before awaiting cleanup. `AppClient` is the authoritative-target interface; a separate diagnostic adapter exposes `events`, `projects()`, and read-only `inspect()` only.

## Consequences

- The rewrite of `CONTEXT.md` uses these meanings (Registered Project, Project Key, Project Run, Project Session, Activation Attempt, Authoritative Editing Client, Edit Authority, Resource Grant, App Shell, Canvas).
- The Service Worker bypass and its DevTools trade-off get their own ADR (0009), backed by [#208](https://github.com/wojtekpiskorz/astroix/issues/208).
- Required implementation evidence for the charter (deterministic proof, allocated across lanes): alias dedup, key rotation, active-record removal rejection, registry crash atomicity and recovery; writer exclusion, abrupt-main death, private-IPC disconnect, replacement-main fail-closed; concurrent activation rejection, candidate rollback, drain conflicts, bounded force termination, post-incomplete-reap denial, lease transfer, completion failures, close reports, ambiguous-owner fail-closed; the two-target A-to-B-to-A cycle (stale command, cookie, binding, grant, SSE, menu action, query cache, selection, canvas, undo, pending mutation — all rejected — while a diagnostic stays read-only); exact Host/Origin/Fetch Metadata/capability checks, cookie stripping before proxying, malformed/oversized rejection, stable sanitized errors, pagination below caps; expected-hash and expected-absent conflicts, the documented non-cooperating-writer race, containment recheck races, symlink and hard-link rules, cross-session grant replay, one-writer enforcement; and the root-scope hostile Service Worker plus debugger-detach fail-closed behavior.
