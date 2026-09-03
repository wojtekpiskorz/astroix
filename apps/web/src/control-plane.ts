import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { SessionRef, SessionSnapshot } from '@wojciechpiskorz/astroix-protocol';
import {
  type ClientBindings,
  createClientBindings,
  createHostCapabilityGrants,
  createReservedApiSurface,
  type HostCapabilityGrants,
} from '@wojciechpiskorz/astroix-runtime/api/http';
import type { GrantTable } from '@wojciechpiskorz/astroix-runtime/edit-authority/grants';
import { createOriginListener, type OriginListener } from '@wojciechpiskorz/astroix-runtime/origin';
import { managedDevServerPlan } from '@wojciechpiskorz/astroix-runtime/project-plane/managed-astro';
import {
  createProjectPlaneSupervisor,
  DEFAULT_STARTUP_TIMEOUT_MS,
  workerSpawnPlan,
} from '@wojciechpiskorz/astroix-runtime/project-plane/supervision';
import {
  createProjectRuntime,
  type ProjectRun,
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
  createSessionSupervisor,
  type SessionSupervisor,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/staging';
import {
  createEventsApiSurface,
  createSseHub,
  type SseHub,
  ssePublication,
} from '@wojciechpiskorz/astroix-runtime/sse';
import { bindLauncherDocument, createDocumentSurface } from './documents.ts';
import { createExecutor, type SeatStore, type SessionSeat } from './executor.ts';
import { rememberCandidate } from './run-ports.ts';

/** The raw-Node register this dev-checkout control plane and its worker child load. */
const RAW_NODE_REGISTER = fileURLToPath(new URL('../raw-node-register.mjs', import.meta.url));

/**
 * The web host's control plane (#240, G1; ADR-0004 "web mode starts the
 * same control-plane implementation as its test and diagnostic host"):
 * the PRODUCTION surfaces — the real origin listener with its virtual
 * hosts (F1), the real reserved HTTP API admission (F2), the real
 * events surface and SSE hub (F3), the real staged-activation
 * supervisor over the real project runtime (F4/E8), the real switch
 * coordinator (F6) — composed over ONE explicitly injected seam: the
 * registry directory. That injection is the whole isolation story
 * (ADR-0006 §2: "tests use an explicitly injected isolated registry"):
 * this host never acquires the kernel-backed registry-writer lease
 * (that authority belongs to the Electron main's privately-booted
 * control-plane child), never touches a production registry under
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
 * handshakes are the Electron host's, never the wire's.
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

/** The booted control plane. */
export interface WebControlPlane {
  readonly port: number;
  readonly launcherOrigin: string;
  /** The isolated registry — test assertions and teardown only. */
  readonly registry: ProjectRegistry;
  readonly supervisor: SessionSupervisor;
  /** Terminates the composition: stop the active run, close the listener, fence the registry. */
  close(): Promise<void>;
}

/** Boots the web host's control plane. */
export async function createWebControlPlane(
  options: WebControlPlaneOptions,
): Promise<WebControlPlane> {
  const registry = await createProjectRegistry(options.registryDirectory);
  const grants: HostCapabilityGrants = createHostCapabilityGrants();
  const httpBindings: ClientBindings = createClientBindings();
  const sessionClients: SessionClients = createSessionClients();
  const hub: SseHub = createSseHub();
  const runtime: ProjectRuntime = createProjectRuntime({
    launchPlane: (input) =>
      launchWebPlane({ ...input, workerExecArgv: ['--import', RAW_NODE_REGISTER] }),
  });
  const seats = new Map<string, SessionSeat>();
  const grantTables = new Map<string, GrantTable>();
  /** The dev-server port each activation picked before `begin` — consumed by its `startCandidate`. */
  const pendingDevPorts: number[] = [];
  const launcherCapability = grants.mint({ host: 'launcher' });
  const launcherClient = bindLauncherDocument(httpBindings);

  const supervisor: SessionSupervisor = createSessionSupervisor({
    hostCapabilities: grants,
    clients: sessionClients,
    startCandidate: (request) => {
      const port = pendingDevPorts.shift();
      const record = registry
        .snapshot()
        .records.find((entry) => entry.projectKey === request.projectKey);
      if (port === undefined || record === undefined) return neverSpawnedRun();
      const run = runtime.start({ projectRoot: record.canonicalRoot, devServerPort: port });
      rememberCandidate(run, port, request.sessionRef);
      return run;
    },
  });
  const coordinator: SwitchCoordinator = createSwitchCoordinator({
    clients: sessionClients,
    hostCapabilities: grants,
    streams: hub,
    grants: {
      revokeSession: (session: SessionRef): number => {
        const evicted = grantTables.get(pairKey(session))?.revokeSession(session) ?? 0;
        grantTables.delete(pairKey(session));
        return evicted;
      },
    },
    httpBindings,
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

  apiSurface.setAuthority({
    expectedPort: listener.port,
    sessionState,
    verifyHostCapability: grants.verify,
    resolveClientBinding: httpBindings.resolve,
    executeCommand: (envelope) =>
      createExecutor({
        registry,
        supervisor,
        coordinator,
        seatStore,
        listener,
        sessionClients,
        httpBindings,
        grantTables,
        pendingDevPorts,
        freePort,
        hub,
      }).execute(envelope),
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
    close: async () => {
      const seat = seatStore.active();
      if (seat !== null) await seat.run.stop().catch(() => {});
      await listener.close();
      await registry.close();
    },
  };
}

/** The plane's startup budget: the ADR-0006 30 s production default, overridable for slow host environments (CI cold boots). */
function planeStartupBudgetMs(): number {
  const raw = process.env.ASTROIX_WEB_PLANE_STARTUP_MS;
  if (raw === undefined) return DEFAULT_STARTUP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

/**
 * The web host's plane launch: the production launch composition with
 * ONE dev-checkout delta — the worker child receives the raw-Node
 * register through its execArgv (plane-launch's documented seam: a
 * dev-checkout control plane running raw Node supplies its
 * bundler-resolution `--import` register here; the packaged runtime's
 * rebased entry needs none).
 */
async function launchWebPlane(input: {
  readonly projectRoot: string;
  readonly devServerPort: number;
  readonly workerExecArgv: readonly string[];
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
    // The production default (30 s, ADR-0006) stands unless the host's
    // environment budgets wider — the test host's CI cold boots do.
    startupTimeoutMs: planeStartupBudgetMs(),
  });
}

/** A run that was never spawned — the E8 never-spawned law, for the vanished-record path. */
function neverSpawnedRun(): ProjectRun {
  const failure = new Error('the candidate could not be launched');
  const ready = Promise.reject(failure);
  ready.catch(() => {}); // anchored: the attempt surfaces it, the composition never hangs
  const closed = Promise.resolve({
    reason: 'cancelled',
    outcome: 'complete',
    failures: [],
    accounting: {
      workerReportReceived: false,
      workerCleanupComplete: true,
      workerReaped: false,
      managedAstroReaped: false,
      probesSettled: true,
      killEscalations: [],
    },
  } as const);
  return {
    ready,
    inspect: () => Promise.reject(failure),
    subscribe: () => () => {},
    stop: () => closed,
    closed,
  };
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

function pairKey(ref: SessionRef): string {
  return `${ref.runtimeEpoch}#${ref.generation}`;
}
