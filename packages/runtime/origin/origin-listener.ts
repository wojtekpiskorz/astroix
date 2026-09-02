/**
 * The origin listener (#233, F1; ADR-0005 "Origin and proxy contract",
 * ADR-0007 "Listener and routing"): the control plane's ONE loopback
 * listener and its virtual hosts. The socket is acquired on loopback
 * BEFORE any origin exists — the factory resolves only after the server
 * answers `listening`, so a published origin is always a bound socket,
 * never an intention. Routing is the strict ADR-0007 set: the neutral
 * launcher host, or the ONE exact active project-key hostname — every
 * other name (unknown, malformed, duplicate, trailing-dot, port-
 * mismatched, or a foreign domain rebound to loopback) is refused
 * before any upstream byte moves, and a retired lease's host answers
 * 421 for the rest of the listener's lifetime.
 *
 * The reserved `/__astroix/` namespace is routed, never proxied: with
 * no reserved handler installed (F1 ships none — HTTP/SSE API routes
 * belong to F2/F3) every reserved path answers 404, and a managed
 * project's claim on the namespace is a compatibility failure
 * (`docs/spec.md` implementation decisions 2) that never reaches
 * routing. Non-reserved requests on the active project host stream to
 * the lease's loopback upstream — the natural URL verbatim, Host
 * preserved; admitted upgrades tunnel raw.
 *
 * Lease revocation is the ticket's pre-reap step: revoke() flips the
 * route to retired FIRST, then destroys every tracked HTTP and upgrade
 * socket of the lease and resolves only once their closes settled —
 * the run composer awaits it before terminating the plane's children
 * (ADR-0005 normal stop order; the plane's own stop is E7's and stays
 * untouched).
 *
 * This module is real socket IO — watchlist tier like the plane's other
 * IO glue; its truth is the real-socket focused lane (`test/proxy/**`).
 * The pure decision logic it composes — {@link ./virtual-hosts.ts} and
 * {@link ./host-router.ts} (covered tier) and
 * {@link ../proxy/upgrade-request.ts} (covered tier) — carries the
 * admission rules.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ProjectKey } from '@wojciechpiskorz/astroix-protocol';
import { proxyHttpStream, sendGeneratedResponse } from '../proxy/http-stream.ts';
import { reconstructUpgradeHandshake, validateUpgradeRequest } from '../proxy/upgrade-request.ts';
import { respondRawAndClose, tunnelRawUpgrade } from '../proxy/upgrade-tunnel.ts';
import { createHostRouter, type HostEvidence } from './host-router.ts';
import {
  classifyRequestTarget,
  LISTENER_REJECTION_STATUS,
  launcherOrigin as launcherOriginOf,
  projectOrigin as projectOriginOf,
} from './virtual-hosts.ts';

export type { StreamProxyUpstream } from '../proxy/http-stream.ts';
// The composition entry's own contract (the #305 re-export idiom): a
// consumer of `origin` must be able to name the whole public vocabulary
// — the lease and revocation shapes, the routing decisions, the Host
// evidence and vocabulary constants — without reaching around the
// exports map.
export {
  createHostRouter,
  type HostEvidence,
  type HostGrantRefusalReason,
  type HostGrantResult,
  type HostRouteDecision,
  type HostRouter,
} from './host-router.ts';
export {
  ASTROIX_GENERATED_HEADER,
  type HostParse,
  type HostRejectionReason,
  isReservedPath,
  LAUNCHER_HOSTNAME,
  type ListenerGeneratedStatus,
  launcherOrigin,
  projectHostname,
  projectOrigin,
  RESERVED_NAMESPACE,
  type RequestTargetClassification,
  type TargetRejectionReason,
} from './virtual-hosts.ts';

/** Loopback only — the listener never binds a non-loopback address (ADR-0007's first mandatory control). */
const LOOPBACK_BIND_HOST = '127.0.0.1';

/** Bound on observing every destroyed socket's close during revocation (ADR-0006 §8's forced-reap bound, mirrored). */
export const REVOCATION_CLOSE_BOUND_MS = 2000;

/** The lease a grant refused — one active lease per listener (ADR-0006 §4's commit-before-grant, enforced). */
export class OriginLeaseOccupiedError extends Error {
  constructor() {
    super('an origin lease is already active for this listener');
    this.name = 'OriginLeaseOccupiedError';
  }
}

/** A malformed project key can never become a virtual host — the registry vocabulary, enforced at the seam. */
export class InvalidProjectKeyError extends Error {
  constructor() {
    super('the given project key is not a valid routing key');
    this.name = 'InvalidProjectKeyError';
  }
}

/**
 * A non-loopback upstream was offered at the lease seam. The lane's
 * DNS-rebinding posture (ADR-0007) rests on the managed dev server — and
 * nothing else — being the only upstream, reachable only at a literal
 * loopback address; anything else fails closed at grant time, before any
 * routing state exists.
 */
export class NonLoopbackUpstreamError extends Error {
  constructor() {
    super('an origin lease upstream must be a literal loopback address');
    this.name = 'NonLoopbackUpstreamError';
  }
}

/** The loopback literals a lease upstream may carry — hostnames (even `localhost`) resolve and therefore never qualify. */
const LOOPBACK_UPSTREAM_HOSTS = new Set(['127.0.0.1', '::1']);

/** One revocation's honest accounting — counts and outcome only, never an address (output hygiene). */
export interface LeaseRevocation {
  readonly projectKey: ProjectKey;
  readonly destroyedSockets: number;
  readonly outcome: 'complete' | 'incomplete';
}

/** The control plane's grant of the active project hostname to one session (CONTEXT.md "origin lease"). */
export interface OriginLease {
  readonly projectKey: ProjectKey;
  readonly hostname: string;
  /** The published project origin — `http://<key>.localhost:<port>` — exists because the socket does. */
  readonly origin: string;
  readonly revoked: boolean;
  /**
   * Retires the route, destroys the lease's tracked HTTP and raw-upgrade
   * sockets, and settles once their closes are observed (or honestly
   * reports `incomplete` past the bound). Idempotent — the same report
   * every call. The composer awaits this BEFORE terminating the plane's
   * children.
   */
  revoke(): Promise<LeaseRevocation>;
}

export interface OriginListenerOptions {
  /**
   * The port to bind; 0 (the default) asks the OS for an ephemeral one.
   * The test doctrine prefers OS-assigned sockets.
   */
  readonly port?: number;
  /**
   * The reserved-namespace handler (F2/F3's API/SSE surface hooks here);
   * absent, every reserved path answers 404 — reserved means NEVER
   * proxied, with or without a handler. The third argument is the
   * launcher-scoped socket tracker: connections the handler registers
   * survive project-lease revocations and are destroyed at listener
   * close.
   */
  readonly handleReserved?: (
    request: IncomingMessage,
    response: ServerResponse,
    track: (socket: Duplex) => void,
  ) => void;
}

export interface OriginListener {
  /** The bound port — exists only because the socket was acquired first. */
  readonly port: number;
  /** The published launcher origin (ADR-0005): the neutral trusted page's host. */
  readonly launcherOrigin: string;
  readonly activeLease: OriginLease | null;
  /**
   * Grants the active project virtual host. Throws
   * {@link OriginLeaseOccupiedError} while a lease is active (revoke
   * first — the switch protocol's order), {@link InvalidProjectKeyError}
   * for a malformed key, and {@link NonLoopbackUpstreamError} for any
   * non-loopback upstream (the lane's rebinding posture, enforced at the
   * seam).
   */
  grantProjectLease(input: {
    readonly projectKey: ProjectKey;
    readonly upstream: { readonly host: string; readonly port: number };
  }): OriginLease;
  /** Closes the listener: revokes the active lease, destroys tracked sockets, stops listening. Idempotent. */
  close(): Promise<void>;
}

/** Binds the one loopback listener — the factory resolves only after the socket answers `listening`. */
export async function createOriginListener(
  options: OriginListenerOptions = {},
): Promise<OriginListener> {
  type LeaseHandle = OriginLease & {
    readonly upstream: { readonly host: string; readonly port: number };
  };
  // Ownership-tagged tracking (#314 review round): every tracked socket
  // belongs to exactly one owner — the lease whose exchange it serves,
  // or null for the launcher's reserved-surface connections — so a
  // lease revocation destroys only ITS sockets and never the launcher's.
  const tracked = new Map<Duplex, LeaseHandle | null>();
  let active: LeaseHandle | null = null;
  let closeCall: Promise<void> | null = null;

  const server = createServer((request, response) => {
    handleRequest(request, response);
  });
  // The upgrade path is raw from here on: node:http hands us the socket
  // before any response exists, and nothing on it is ever answered by
  // this side with a handshake — the tunnel relays the upstream's own
  // bytes, or one of the refusal responses below, never a 101.
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head);
  });
  // CONNECT never reaches the request handler on this Node line — the
  // method has its own event, and the tunnel-shaped refusal is the same.
  server.on('connect', (_request, socket) => {
    respondRawAndClose(socket, 405);
  });
  const port = await listenOnLoopback(server, options.port ?? 0);
  const router = createHostRouter({ expectedPort: port });

  /** One owner's tracking view: sockets registered here are destroyed by that owner's revocation alone. */
  function trackFor(owner: LeaseHandle | null): (socket: Duplex) => void {
    return (socket) => {
      tracked.set(socket, owner);
      socket.once('close', () => {
        tracked.delete(socket);
      });
    };
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === 'CONNECT') {
      // Defense in depth only, deliberately unreachable on this Node
      // line: CONNECT arrives on the server's 'connect' event (answered
      // above), never as a request — this branch holds the refusal if
      // that parser routing ever changes.
      sendGeneratedResponse(response, 405);
      return;
    }
    const decision = router.resolve(hostEvidenceOf(request));
    if (
      decision.kind === 'rejected' ||
      decision.kind === 'unknown-host' ||
      decision.kind === 'retired-host'
    ) {
      sendGeneratedResponse(
        response,
        LISTENER_REJECTION_STATUS[decision.kind === 'rejected' ? decision.reason : decision.kind],
      );
      return;
    }
    const target = classifyRequestTarget(request.url);
    if (target.kind === 'rejected') {
      sendGeneratedResponse(response, LISTENER_REJECTION_STATUS[target.reason]);
      return;
    }
    if (target.kind === 'reserved') {
      serveReserved(request, response);
      return;
    }
    // The launcher serves only the reserved namespace — a natural target
    // there has no route and no upstream; only the ACTIVE project host
    // has one, and it is never request-selected.
    if (decision.kind !== 'project' || active === null) {
      sendGeneratedResponse(response, LISTENER_REJECTION_STATUS['unknown-host']);
      return;
    }
    proxyHttpStream({ request, response, upstream: active.upstream, track: trackFor(active) });
  }

  function serveReserved(request: IncomingMessage, response: ServerResponse): void {
    if (options.handleReserved === undefined) {
      sendGeneratedResponse(response, 404);
      return;
    }
    // The launcher-scoped tracker: connections the reserved surface
    // registers here are launcher-owned — a project-lease revocation
    // never destroys them; listener close does.
    options.handleReserved(request, response, trackFor(null));
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const decision = router.resolve(hostEvidenceOf(request));
    if (decision.kind === 'rejected') {
      respondRawAndClose(socket, LISTENER_REJECTION_STATUS[decision.reason]);
      return;
    }
    // The launcher hosts no upgrades and a retired lease hosts none
    // anymore — the only tunneled upgrades belong to the ACTIVE project
    // host's natural routes (the Vite HMR upgrade rides a natural path,
    // never the reserved namespace).
    if (decision.kind !== 'project' || active === null) {
      respondRawAndClose(
        socket,
        decision.kind === 'retired-host'
          ? LISTENER_REJECTION_STATUS['retired-host']
          : LISTENER_REJECTION_STATUS['unknown-host'],
      );
      return;
    }
    const target = classifyRequestTarget(request.url);
    if (target.kind !== 'natural') {
      respondRawAndClose(
        socket,
        target.kind === 'rejected' ? LISTENER_REJECTION_STATUS[target.reason] : 404,
      );
      return;
    }
    const admission = validateUpgradeRequest({
      method: request.method ?? '',
      headers: request.headers,
      expectedOrigin: active.origin,
    });
    if (admission.kind !== 'admitted') {
      respondRawAndClose(socket, 400);
      return;
    }
    tunnelRawUpgrade({
      handshake: reconstructUpgradeHandshake({
        method: request.method ?? '',
        url: request.url ?? '/',
        httpVersion: request.httpVersion,
        rawHeaders: request.rawHeaders,
      }),
      head,
      clientSocket: socket,
      upstream: active.upstream,
      track: trackFor(active),
    });
  }

  return {
    get port(): number {
      return port;
    },
    get launcherOrigin(): string {
      return launcherOriginOf(port);
    },
    get activeLease(): OriginLease | null {
      return active;
    },
    grantProjectLease: (input) => {
      if (!LOOPBACK_UPSTREAM_HOSTS.has(input.upstream.host)) throw new NonLoopbackUpstreamError();
      const granted = router.grant(input.projectKey);
      if (granted.kind === 'refused') {
        if (granted.reason === 'lease-occupied') throw new OriginLeaseOccupiedError();
        throw new InvalidProjectKeyError();
      }
      let revocation: Promise<LeaseRevocation> | null = null;
      let revoked = false;
      const lease: LeaseHandle = {
        projectKey: input.projectKey,
        hostname: granted.hostname,
        origin: projectOriginOf(input.projectKey, port),
        upstream: input.upstream,
        get revoked(): boolean {
          return revoked;
        },
        revoke: () => {
          // The route flips to retired synchronously — from this instant
          // the host answers 421, before any socket work begins, so no
          // new exchange can join the tracked set mid-revocation.
          router.revoke(input.projectKey);
          if (active === lease) active = null;
          revoked = true;
          revocation ??= destroyTrackedSockets(lease);
          return revocation;
        },
      };
      active = lease;
      return lease;
    },
    close: () => {
      closeCall ??= (async () => {
        await active?.revoke();
        // Terminal for the WHOLE listener: every tracked socket, both
        // lease-owned and launcher-owned, dies with the listener.
        const sockets = [...tracked.keys()];
        tracked.clear();
        for (const socket of sockets) socket.destroy();
        server.close();
        server.closeAllConnections();
        await onceClosed(server);
      })();
      return closeCall;
    },
  };

  /** Destroys the revoking lease's tracked sockets and settles when their closes are observed inside the bound. */
  async function destroyTrackedSockets(lease: LeaseHandle): Promise<LeaseRevocation> {
    const owned: Duplex[] = [];
    for (const [socket, owner] of tracked) {
      if (owner === lease) {
        owned.push(socket);
        tracked.delete(socket);
      }
    }
    // The close observers attach BEFORE destroying: `destroyed` flips
    // synchronously, so observing after the call would shortcut and
    // report completion without ever seeing a close event — the honest
    // accounting waits for the events, bounded. Launcher-owned sockets
    // are untouched: they outlive the lease and die with the listener.
    const closes = owned.map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once('close', resolve);
          if (socket.destroyed) resolve();
        }),
    );
    for (const socket of owned) socket.destroy();
    const settled = await raceBound(Promise.all(closes));
    return {
      projectKey: lease.projectKey,
      destroyedSockets: owned.length,
      outcome: settled ? 'complete' : 'incomplete',
    };
  }
}

/** Binds on loopback; resolves with the acquired port, rejects on the bind failure — the origin exists only after this. */
function listenOnLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, LOOPBACK_BIND_HOST, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the loopback listener did not acquire a bound socket'));
        return;
      }
      resolve(address.port);
    });
  });
}

function onceClosed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once('close', resolve);
    if (server.listening === false) resolve();
  });
}

/** The Host evidence exactly as the raw header pairs carry it — a duplicate can never hide behind a comma-join. */
function hostEvidenceOf(request: IncomingMessage): HostEvidence {
  let count = 0;
  let value: string | undefined;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i] ?? '';
    if (name.toLowerCase() !== 'host') continue;
    count += 1;
    value = request.rawHeaders[i + 1] ?? '';
  }
  return { hostValue: count === 1 ? value : undefined, hostHeaderCount: count };
}

/** True when `work` settles before the revocation bound — the timer dies with the race either way. */
function raceBound(work: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), REVOCATION_CLOSE_BOUND_MS);
    const settled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(settled, settled);
  });
}
