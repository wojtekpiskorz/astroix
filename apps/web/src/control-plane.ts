import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectKey, SessionRef, SessionSnapshot } from '@wojciechpiskorz/astroix-protocol';
import {
  type ClientBindings,
  createClientBindings,
  createHostCapabilityGrants,
  createReservedApiSurface,
  type HostCapabilityGrants,
} from '@wojciechpiskorz/astroix-runtime/api/http';
import {
  createDocumentAuthority,
  type DocumentAuthority,
} from '@wojciechpiskorz/astroix-runtime/client-authority';
import type { WriteExecutorHandle } from '@wojciechpiskorz/astroix-runtime/edit-authority/executor';
import type { GrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import {
  createOriginListener,
  type OriginLease,
  type OriginListener,
} from '@wojciechpiskorz/astroix-runtime/origin';
import { managedDevServerPlan } from '@wojciechpiskorz/astroix-runtime/project-plane/managed-astro';
import {
  createProjectPlaneSupervisor,
  workerSpawnPlan,
} from '@wojciechpiskorz/astroix-runtime/project-plane/supervision';
import {
  createProjectRuntime,
  type ProjectRuntime,
} from '@wojciechpiskorz/astroix-runtime/project-runtime';
import {
  createProjectRegistry,
  type ProjectRegistry,
} from '@wojciechpiskorz/astroix-runtime/registry';
import {
  createSessionClients,
  type SessionClients,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import {
  createSwitchCoordinator,
  type SwitchCoordinator,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/commit';
import {
  createSessionCompletion,
  type SessionCompletion,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/completion';
import {
  createSessionSupervisor,
  type SessionSupervisor,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import {
  createEventsApiSurface,
  createSseHub,
  type SseHub,
  ssePublication,
} from '@wojciechpiskorz/astroix-runtime/sse';
import { createCandidateStore, pairKey } from './candidates.ts';
import { bindLauncherDocument, createDocumentSurface } from './documents.ts';
import {
  adoptSession,
  type CommandExecutor,
  createExecutor,
  type ExecutorInputs,
  type HostAdoptionSeam,
  type SeatStore,
  type SessionSeat,
} from './executor.ts';
import { neverSpawnedRun } from './never-spawned.ts';

/**
 * The raw-Node register this dev-checkout control plane and its worker
 * child load — resolved LAZILY, inside the web wrapper alone: the
 * packaged desktop bundle inlines this module without the checkout
 * layout, and a top-level `fileURLToPath` would evaluate there (the
 * bundle keeps no file URL for a register that never existed); the
 * desktop child never calls the wrapper, so the resolution never runs.
 */
function rawNodeRegister(): string {
  return fileURLToPath(new URL('../raw-node-register.mjs', import.meta.url));
}

/**
 * The shared control-plane composition (#240 G1; #362 H7 — ONE seam, two
 * hosts): the PRODUCTION surfaces — the real origin listener with its
 * virtual hosts (F1), the real reserved HTTP API admission (F2), the
 * real events surface and SSE hub (F3), the real staged-activation
 * supervisor over the real project runtime (F4/E8), the real switch
 * coordinator (F6), the real session completion (F7), the real document
 * authority (#246 H4 — the both-truths bind discipline the adoption
 * mints through) — composed over ONE explicitly injected seam: the
 * registry directory. That injection is the web host's whole isolation
 * story (ADR-0006 §2: "tests use an explicitly injected isolated
 * registry"): the web host never acquires the kernel-backed
 * registry-writer lease (that authority belongs to the Electron main's
 * privately-booted control-plane child — the DESKTOP host boots this
 * same composition inside that child over its kernel-leased production
 * registry, #362), never touches a production registry under
 * `userData`, and exposes no registration entry point to the browser —
 * the closed browser command set carries no register command by
 * construction (#220), and the boot-time `registerRoots` are the native
 * directory grant's stand-in, supplied by test-owned setup, never by a
 * browser-supplied path (#240's migration policy).
 *
 * The lifecycle the executor drives is the settled transition protocol
 * (ADR-0006 §4): `activate` reserves the generation, stages the
 * candidate privately, drains the old session's fence, mints the
 * one-use receipt through the switch coordinator, and consumes it at
 * the commit linearization point — then grants the new origin lease
 * strictly AFTER the coordinator revoked the old one (the
 * commit-before-grant order F1's single-lease law enforces).
 * `deactivate` runs the same preparation against a deactivation target
 * and stops the outgoing run. The forced write-executor path is the
 * edit verticals' composition (no accepted edits exist here, so every
 * drain is empty and terminal); the completion lane's host-observed
 * handshakes are the Electron host's, never the wire's — the web host's
 * stand-in adoption IS its activation observation, and the desktop's
 * {@link HostMainFrameHandshake} carries the real window handshake
 * (F7's §4 step 6: the host has reset the client and replaced the top
 * level before the observation settles); the completion's FAILURE half
 * is composed (#333): a failed adoption after a committed transition
 * converges through F7's aftermath, which revokes exactly what the
 * failed adoption granted through F6's ordered pass and reaps the
 * granted run, never a stranded session.
 */

/**
 * The Electron host's main-frame handshake — the private channel's
 * implementation of F7's §4 step 6 activation observation (#362, H7).
 * The phases keep H4's and H5's laws exact: the bind names a document
 * the host OBSERVED (never a predicted navigation), and the top level
 * is replaced only through the bypass-guarded target.
 */
export interface HostMainFrameHandshake {
  /**
   * Phase 1 — the authoritative target's CURRENT document identity:
   * the host has prepared the target (the fresh editing partition, the
   * CDP bypass active BEFORE any project request, H5's ordering law)
   * and answers the document it stands on now. The adoption binds here
   * first so the project document can serve (the capability the surface
   * injects exists) — a bind the phase-2 navigation then invalidates.
   */
  currentDocument(): Promise<HostDocumentIdentity | null>;
  /**
   * Phase 2 — replace the top level with the granted origin's app
   * document and observe the NEW document (ADR-0006 §4 step 6: "the
   * host has reset the client and replaced the top level; the
   * observation is the exact frame's"). `null` reports a load that
   * could not be observed — the adoption fails, the aftermath converges.
   */
  replaceTopLevel(input: {
    readonly sessionRef: SessionRef;
    readonly projectKey: ProjectKey;
    readonly origin: string;
  }): Promise<HostDocumentIdentity | null>;
}

/** One observed document identity — the host's opaque `webContents` and its observed navigation. */
export interface HostDocumentIdentity {
  readonly webContentsId: number;
  readonly navigationId: number;
}

/** Construction options — the registry injection plus the host's own wiring. */
export interface ControlPlaneCompositionOptions {
  /** The explicitly injected registry directory (the web host's isolation; the desktop child's kernel-leased production root). */
  readonly registryDirectory: string;
  /** The loopback port to bind; 0 (the default) asks the OS for one. */
  readonly port?: number;
  /** The built client assets directory (vite output). */
  readonly clientDist: string;
  /**
   * Control-plane-side registration (the native directory grant's
   * stand-in for web mode): roots registered at boot, never from the
   * browser — test-owned setup.
   */
  readonly registerRoots?: readonly string[];
  /**
   * The dev-checkout worker register (plane-launch's documented seam): a
   * control plane running raw Node supplies its bundler-resolution
   * `--import` register here; the packaged runtime's rebased entry
   * needs none.
   */
  readonly workerExecArgv?: readonly string[];
  /**
   * Supervisor bounds passthrough (the structural subset of the plane
   * launch's bounds a host may tune): the desktop's ordered-exit window
   * is narrower than the web host's, so its child tightens the stop
   * bounds to converge inside main's graceful disconnect bound.
   */
  readonly planeBounds?: {
    readonly stopTimeoutMs?: number;
    readonly termGraceMs?: number;
    readonly killReapMs?: number;
  };
  /**
   * The Electron host's main-frame handshake (#362, H7): when present,
   * the transition's activation observation is the HOST's — the real
   * authoritative window, the real top-level replacement; absent, the
   * web host's stand-in adoption holds.
   */
  readonly hostHandshake?: HostMainFrameHandshake;
  /**
   * The write executor's private state directory (#253, J3): the
   * kernel edit-writer lease files' home. The desktop child passes its
   * own kernel-leased private directory; the web host defaults to a
   * sibling of the injected registry directory (isolated with it).
   */
  readonly privateStateDirectory?: string;
}

/** The booted control-plane composition. */
export interface ControlPlaneComposition {
  readonly port: number;
  readonly launcherOrigin: string;
  /** The composed registry — the desktop child registers roots and reads persisted project summaries through it (#362, #367). */
  readonly registry: ProjectRegistry;
  readonly supervisor: SessionSupervisor;
  /** The command executor — the closed browser command set's driver (the desktop child drives it with synthesized envelopes). */
  readonly executor: CommandExecutor;
  /** The document authority (#246, H4) — the both-truths bind discipline the adoption mints through. */
  readonly authority: DocumentAuthority;
  /**
   * The live editor document binding — the authoritative document's
   * `webContents` and its live HTTP capability, or null while no session
   * is adopted. The Electron host's injection feed (#362, H7); the web
   * host never reads it.
   */
  readonly editorDocument: () => {
    readonly webContentsId: number;
    readonly capability: string;
  } | null;
  /** Terminates the composition: stop the active run, close the listener, fence the registry. */
  close(): Promise<void>;
}

/** Boots the shared control-plane composition. */
export async function createControlPlaneComposition(
  options: ControlPlaneCompositionOptions,
): Promise<ControlPlaneComposition> {
  const registry = await createProjectRegistry(options.registryDirectory);
  const grants: HostCapabilityGrants = createHostCapabilityGrants();
  const httpBindings: ClientBindings = createClientBindings();
  const sessionClients: SessionClients = createSessionClients();
  const hub: SseHub = createSseHub();
  const runtime: ProjectRuntime = createProjectRuntime({
    launchPlane: (input) =>
      launchCompositionPlane({
        ...input,
        workerExecArgv: options.workerExecArgv,
        bounds: options.planeBounds,
      }),
  });
  const seats = new Map<string, SessionSeat>();
  const grantTables = new Map<string, GrantTable>();
  /** The sessions' forked write executors (#253, J3) — lazy at the first accepted edit, stopped at teardown. */
  const writeExecutors = new Map<string, WriteExecutorHandle>();
  /** The edit results' monotonic per-session revision counters (#253, J3). */
  const editRevisions = new Map<string, number>();
  const candidates = createCandidateStore();
  /** The dev-server port each activation picked before `begin` — consumed by its `startCandidate`. */
  const pendingDevPorts: number[] = [];
  const launcherCapability = grants.mint({ host: 'launcher' });
  const launcherClient = bindLauncherDocument(httpBindings);

  // The document authority (#246, H4): the server-side both-truths bind
  // discipline. The web host declares its one stand-in document
  // (webContents 1); the Electron host's handshake declares the real
  // authoritative target with its observed identity.
  const authority: DocumentAuthority = createDocumentAuthority({
    httpBindings,
    clients: sessionClients,
  });
  if (options.hostHandshake === undefined) {
    authority.declareAuthoritativeTarget(1);
  }

  const supervisor: SessionSupervisor = createSessionSupervisor({
    hostCapabilities: grants,
    clients: sessionClients,
    startCandidate: (request) => {
      const port = pendingDevPorts.shift();
      const record = registry
        .snapshot()
        .records.find((entry) => entry.projectKey === request.projectKey);
      if (port === undefined || record === undefined) {
        return neverSpawnedRun('the candidate could not be launched');
      }
      const run = runtime.start({ projectRoot: record.canonicalRoot, devServerPort: port });
      candidates.remember(run, port, request.sessionRef);
      return run;
    },
  });
  /** The composition's grant-table eviction — the one closure both F6's coordinator and F7's completion revoke through. */
  const grantEviction = (session: SessionRef): number => {
    const evicted = grantTables.get(pairKey(session))?.revokeSession(session) ?? 0;
    grantTables.delete(pairKey(session));
    // The session's write executor (#253, J3): the transition drained
    // its fence before revocation, so its accepted work is terminal —
    // the graceful stop releases the app-global edit-writer lease the
    // successor's executor will need. Fire-and-forget with the exit
    // observed by the handle's own `exited` bookkeeping; the next boot
    // of an executor over the same private directory fails closed on
    // lease contention, never writes around a live predecessor.
    const handle = writeExecutors.get(pairKey(session));
    if (handle !== undefined) {
      writeExecutors.delete(pairKey(session));
      editRevisions.delete(pairKey(session));
      void handle.stop().catch(() => {});
    }
    return evicted;
  };
  // The revocation pass drives the RAW tables (F6's settled contract);
  // these views keep the document authority's live grants in lockstep —
  // a table death the authority never learns would leave a dead grant
  // "injectable". Both underlying calls are idempotent, so the
  // authority's own sweeps re-reaching them are no-ops.
  const revocationClients: SessionClients = {
    ...sessionClients,
    revokeSession: (sessionRef) => {
      sessionClients.revokeSession(sessionRef);
      authority.sessionReplaced(sessionRef);
    },
  };
  const revocationHttpBindings: ClientBindings = {
    ...httpBindings,
    unbind: (capability) => {
      httpBindings.unbind(capability);
      authority.revoke(capability);
    },
  };
  const revocationSurfaces = {
    clients: revocationClients,
    hostCapabilities: grants,
    streams: hub,
    grants: { revokeSession: grantEviction },
    httpBindings: revocationHttpBindings,
  };
  const coordinator: SwitchCoordinator = createSwitchCoordinator(revocationSurfaces);
  const completion: SessionCompletion = createSessionCompletion({
    ...revocationSurfaces,
    reportFailedNoActive: () => {
      // The supervisor's crash law is the failure-report surface this
      // composition has (#333): the aftermath's reap settles the granted
      // run's `closed`, and the observer the supervisor registered at the
      // commit runs before the aftermath's own reactions (promise
      // reaction order), so the snapshot already reports the failed
      // no-active state here. The hook holds the slot for the
      // supervisor's own report seam — F7's declared integration-lane
      // surface — when that lands with the Electron host (#246).
    },
    tombstones: {
      // Unreachable in this composition: the incomplete-reap tail belongs
      // to the forced write-executor path (F6's `prepareForced`), and no
      // edit vertical is composed here — every drain is empty and
      // terminal. The real boot-scoped store (its private directory and
      // D3 lease proof) lands with the Electron host's composition.
      recordIncompleteReap: async () => {},
    },
  });

  const seatStore: SeatStore = {
    active(): SessionSeat | null {
      const active = supervisor.snapshot().active;
      return active === undefined ? null : (seats.get(pairKey(active.ref)) ?? null);
    },
    adopt(seat: SessionSeat): void {
      seats.set(pairKey(seat.ref), seat);
    },
    drop(ref: SessionRef): void {
      seats.delete(pairKey(ref));
    },
  };

  const sessionState = () => {
    const active = supervisor.snapshot().active;
    return {
      sessionRef: active?.ref ?? null,
      projectKey: active?.projectKey ?? null,
    };
  };

  const apiSurface = createReservedApiSurface();
  const eventsSurface = createEventsApiSurface({ fallback: apiSurface.handler, hub });
  const documents = createDocumentSurface({
    clientDist: options.clientDist,
    launcherClient,
    launcherCapability,
    grants,
    sessions: {
      current: () => {
        const active = supervisor.snapshot().active;
        return active === undefined
          ? null
          : { sessionRef: active.ref, projectKey: active.projectKey };
      },
      editorCapability: () => seatStore.active()?.editorCapability ?? null,
    },
  });
  const listener: OriginListener = await createOriginListener({
    port: options.port ?? 0,
    handleReserved: (request, response, track) => {
      if (documents.handle(request, response)) return;
      eventsSurface.handler(request, response, track);
    },
  });

  // One executor for the composition's lifetime — its inputs are the
  // composition-owned stores, rebuilt never: a per-envelope rebuild was
  // three ownership stories for one state (injected inputs, module
  // globals, and a fresh closure); this is the one.
  const baseInputs: ExecutorInputs = {
    registry,
    supervisor,
    coordinator,
    completion,
    authority,
    seatStore,
    listener,
    sessionClients,
    httpBindings,
    grantTables,
    writeExecutors,
    privateStateDirectory: await resolvePrivateStateDirectory(options),
    editRevisions,
    pendingDevPorts,
    freePort,
    hub,
    candidates,
  };
  const executor = createExecutor(
    options.hostHandshake === undefined
      ? baseInputs
      : { ...baseInputs, host: electronHostAdoption(options.hostHandshake, baseInputs, seatStore) },
  );
  apiSurface.setAuthority({
    expectedPort: listener.port,
    sessionState,
    verifyHostCapability: grants.verify,
    resolveClientBinding: httpBindings.resolve,
    executeCommand: executor.execute,
  });
  eventsSurface.setAuthority({
    expectedPort: listener.port,
    sessionState,
    verifyHostCapability: grants.verify,
    resolveClientBinding: httpBindings.resolve,
  });

  let lastPair: SessionRef | null = null;
  supervisor.subscribe((snapshot: SessionSnapshot) => {
    const pair = snapshot.active?.ref ?? snapshot.attempt?.ref ?? lastPair;
    if (pair === null) return;
    lastPair = pair;
    const publication = ssePublication({
      session: pair,
      event: { type: 'session-state', snapshot },
    });
    if (publication !== null) hub.publish(publication);
  });

  for (const root of options.registerRoots ?? []) {
    const result = await registry.execute({ kind: 'register', root });
    if (!result.ok) throw new Error(`a configured root was refused registration (${result.code})`);
  }

  return {
    port: listener.port,
    launcherOrigin: listener.launcherOrigin,
    registry,
    supervisor,
    executor,
    authority,
    editorDocument: () => {
      const seat = seatStore.active();
      return seat === null
        ? null
        : { webContentsId: seat.document.webContentsId, capability: seat.editorCapability };
    },
    close: async () => {
      const seat = seatStore.active();
      if (seat !== null) await seat.run.stop().catch(() => {});
      // Every forked write executor (#253, J3) stops with the plane —
      // the edit-writer lease releases only through the exit, and an
      // orphaned holder would block the next boot's executor.
      await Promise.all(
        [...writeExecutors.values()].map((handle) => handle.stop().catch(() => {})),
      );
      writeExecutors.clear();
      await listener.close();
      await registry.close();
    },
  };
}

/**
 * The write executor's private state directory (#253, J3): an explicit
 * option when the host owns one (the desktop child's kernel-leased
 * private directory), else a sibling of the injected registry directory
 * — the web host's isolation story (never a production `userData`
 * root), created here so the first lazy fork finds it ready.
 */
async function resolvePrivateStateDirectory(
  options: ControlPlaneCompositionOptions,
): Promise<string> {
  if (options.privateStateDirectory !== undefined) return options.privateStateDirectory;
  const directory = join(dirname(options.registryDirectory), 'private-state');
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * The Electron host's adoption seam (#362, H7): the two-phase handshake
 * that keeps H4's and H5's laws exact while the origin serves before
 * the top level is replaced —
 *
 * - the origin lease is granted FIRST (the origin must serve before the
 *   host can load anything from it) and recorded onto the trail at
 *   grant time, so a throw anywhere in the handshake leaves the F7
 *   aftermath the exact inventory to retire;
 * - the adoption binds at the target's CURRENT observed document (the
 *   document surface can serve the project app — the capability
 *   exists), which the phase-2 replacement then invalidates by H4's
 *   own navigation law;
 * - the REBIND at the observed post-replacement document is the live
 *   grant — the one the Electron host's injection carries and the one
 *   the page's every exchange rides.
 *
 * Exported for the executor's focused stranded-adoption legs: they wire
 * this REAL production seam over their manual-run fixtures — never a
 * re-derivation, because the grant-before-trail-record ordering is
 * exactly the class of wiring defect a copy would faithfully reproduce.
 */
export function electronHostAdoption(
  handshake: HostMainFrameHandshake,
  inputs: ExecutorInputs,
  seatStore: SeatStore,
): HostAdoptionSeam {
  const unobserved = (): Promise<void> =>
    Promise.reject(
      new Error('the Electron host observes this seam only through the main-frame handshake'),
    );
  return {
    mainFrameReady: async (candidate, trail) => {
      const active = inputs.supervisor.snapshot().active;
      if (
        active === undefined ||
        active.ref.runtimeEpoch !== candidate.ref.runtimeEpoch ||
        active.ref.generation !== candidate.ref.generation
      ) {
        throw new Error('the committed candidate is not the active session');
      }
      const devServerPort = inputs.candidates.portOf(candidate.ref);
      // The lease precedes the load: the origin must serve before the
      // host replaces the top level (the coordinator already revoked the
      // old one — F6's commit-before-grant order).
      const lease: OriginLease = inputs.listener.grantProjectLease({
        projectKey: active.projectKey,
        upstream: { host: '127.0.0.1', port: devServerPort },
      });
      // The trail records the lease AT GRANT TIME: `adoptSession`
      // re-records it (idempotently) once its own grants land, but a
      // throw between here and there — a host that cannot report the
      // current document, a refused bind — must still leave the
      // aftermath the exact inventory to retire. An unrecorded live
      // lease escapes the ordered pass, and the router's one-active-
      // lease law then refuses every later grant (`lease-occupied`)
      // until app quit.
      trail.lease = lease;
      const current = await handshake.currentDocument();
      if (current === null) throw new Error('the host could not report the authoritative document');
      inputs.authority.declareAuthoritativeTarget(current.webContentsId);
      inputs.authority.documentNavigated(current.webContentsId, current.navigationId);
      await adoptSession(candidate, trail, inputs, current, lease);
      const replaced = await handshake.replaceTopLevel({
        sessionRef: candidate.ref,
        projectKey: active.projectKey,
        origin: lease.origin,
      });
      if (replaced === null) {
        throw new Error('the host could not observe the replaced top level');
      }
      // The replacement invalidated the phase-1 grant (H4's navigation
      // law) — the rebind at the observed document is the live grant,
      // and the seat's currency follows it (the fence, run, and lease
      // ride the spread; only the document and the two capabilities
      // change).
      inputs.authority.documentNavigated(replaced.webContentsId, replaced.navigationId);
      const rebound = inputs.authority.bindEditor({
        document: replaced,
        sessionRef: candidate.ref,
        projectKey: active.projectKey,
      });
      if (rebound.kind === 'refused') {
        throw new Error(`the session editor rebinding could not be installed (${rebound.reason})`);
      }
      const seat = seatStore.active();
      if (seat !== null) {
        seatStore.adopt({
          ...seat,
          document: replaced,
          editorCapability: rebound.grant.capability,
          clientCapability: rebound.grant.clientCapability,
        });
      }
    },
    launcherReady: unobserved,
    targetClosed: unobserved,
  };
}

/**
 * The web host's control plane (#240, G1; ADR-0004 "web mode starts the
 * same control-plane implementation as its test and diagnostic host"):
 * the shared composition over the explicitly injected isolated test
 * registry, with the dev-checkout worker register the raw-Node control
 * plane supplies. The booted surface is the composition's, unchanged.
 */

/** Construction options — the registry injection plus the host's own wiring. */
export interface WebControlPlaneOptions {
  /** The explicitly injected isolated registry directory (ADR-0006 §2). */
  readonly registryDirectory: string;
  /** The loopback port to bind; 0 (the default) asks the OS for one. */
  readonly port?: number;
  /** The built client assets directory (vite output). */
  readonly clientDist: string;
  /**
   * Control-plane-side registration (the native directory grant's
   * stand-in for web mode): roots registered at boot, never from the
   * browser — test-owned setup.
   */
  readonly registerRoots?: readonly string[];
}

/** The booted control plane — the composition's surface (the web host's historical name). */
export type WebControlPlane = ControlPlaneComposition;

/** Boots the web host's control plane — the shared composition with the web host's dev-checkout wiring. */
export async function createWebControlPlane(
  options: WebControlPlaneOptions,
): Promise<WebControlPlane> {
  return await createControlPlaneComposition({
    ...options,
    workerExecArgv: ['--import', rawNodeRegister()],
  });
}

/**
 * The composition's plane launch: the production launch composition
 * with ONE dev-checkout delta — the worker child receives the
 * raw-Node register through its execArgv (plane-launch's documented
 * seam: a dev-checkout control plane running raw Node supplies its
 * bundler-resolution `--import` register here; the packaged runtime's
 * rebased entry needs none).
 */
async function launchCompositionPlane(input: {
  readonly projectRoot: string;
  readonly devServerPort: number;
  readonly workerExecArgv?: readonly string[];
  readonly bounds?: ControlPlaneCompositionOptions['planeBounds'];
}): Promise<ReturnType<typeof createProjectPlaneSupervisor>> {
  const [worker, managedAstro] = await Promise.all([
    workerSpawnPlan({
      projectRoot: input.projectRoot,
      execArgv: input.workerExecArgv,
    }),
    managedDevServerPlan({ projectRoot: input.projectRoot, port: input.devServerPort }),
  ]);
  return createProjectPlaneSupervisor({
    worker,
    managedAstro,
    devServerPort: input.devServerPort,
    ...input.bounds,
  });
}

/** One free loopback port — the dev-server port discipline (the managed-astro lane's idiom). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
