import { LIMITS, type SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { sameSession } from '../api/http/api-dispatch.ts';
import type { ClientRole } from '../api/http/command-routes.ts';
import type { CapabilityHost } from '../api/http/host-capability.ts';
import { type SsePublication, sseFrame } from './sse-frames.ts';

/**
 * The SSE stream registry and event fan-out (#235, F3; ADR-0006 §7 "one
 * authoritative SSE client … three read-only diagnostics clients";
 * ADR-0006 §4 step 5 "commit revokes the old … streams"; ADR-0005
 * `subscribe()` emits revisioned invalidations and structured
 * diagnostics). One hub holds every live admitted stream, enforces the
 * server-side client caps, routes each publication by its scope, and
 * ends streams on revocation — route (host retired or its capability
 * revoked), client binding (navigation, renderer loss, debugger
 * detach), or session (generation switched).
 *
 * The zero-old-generation invariant is structural, in three layers:
 * (1) a session-bound stream receives a session-scoped event only at the
 * EXACT pair it was admitted under — a post-switch stream can never see
 * a pre-switch event, and an old stream can never see a new-generation
 * one; (2) the epoch/generation watermark refuses any publication minted
 * under a generation the hub has already moved past — after a switch a
 * stale event is refused outright, never queued, never partial; (3)
 * `endForSession` ends the old generation's streams at the switch — the
 * hub's half of commit's "revokes the old … streams before granting
 * candidate authority". Events carry the generation they were minted
 * under; a stream after a switch never delivers a stale one.
 *
 * Deterministic and IO-free: streams enter as sink/close callbacks the
 * composition owns (a `ServerResponse` in production, a recorder in the
 * focused lane), so this module's tier is covered, its truth pinned by
 * unit tests over fake sinks plus the real-socket lane through the
 * actual origin listener (`test/sse/**`).
 */

/** One live admitted stream, as the composition registers it. */
export interface SseStreamRecord {
  readonly role: ClientRole;
  /** The host whose capability admitted the stream — the route/capability revocation scope. */
  readonly host: CapabilityHost;
  /** The exact pair the stream is bound at — `null` only for the session-spanning launcher role. */
  readonly session: SessionRef | null;
  /** The client capability the stream was admitted under — the binding-revocation key. */
  readonly clientCapability: string;
  /** Writes one already-serialized frame onto the stream's connection. */
  readonly sink: (text: string) => void;
  /** Ends the stream's connection — idempotent per record by the composition's own contract. */
  readonly close: () => void;
}

/** What `admit` refused — the ADR's two server-enforced stream caps, and nothing else. */
export type SseAdmitRefusalReason = 'authoritative-cap' | 'diagnostic-cap';

/** What `publish` answered: delivered (to how many streams), or the honest refusal. */
export type SsePublishOutcome =
  | { readonly kind: 'delivered'; readonly streams: number }
  | {
      readonly kind: 'refused';
      readonly reason: 'stale-publication' | 'oversized-event';
      readonly bytes: number;
    };

/**
 * The delivery matrix — which role class receives which event type
 * (data, like `COMMAND_ROUTES`): session-bound streams (the editor and
 * the diagnostics of the exact pair) receive every session-scoped
 * frame — `session-state` lifecycle progress, revisioned invalidations,
 * structured diagnostics (ADR-0005 `subscribe()`); the launcher stream
 * receives `session-state` (lifecycle progress is the launcher's whole
 * display, ADR-0006 §4) and the idle `registry-changed` nudge (§7's
 * idle-registry rule) — never a session-scoped invalidation or
 * diagnostic it holds no session for.
 */
export const SESSION_STREAM_EVENTS: Readonly<Record<SsePublication['event']['type'], boolean>> = {
  'session-state': true,
  invalidation: true,
  diagnostic: true,
  'registry-changed': false,
};

export const LAUNCHER_STREAM_EVENTS: Readonly<Record<SsePublication['event']['type'], boolean>> = {
  'session-state': true,
  invalidation: false,
  diagnostic: false,
  'registry-changed': true,
};

/** True when `host` names the same host class (and, for a project host, the same key). */
function sameHost(a: CapabilityHost, b: CapabilityHost): boolean {
  if (a.host === 'launcher') return b.host === 'launcher';
  return b.host === 'project' && a.projectKey === b.projectKey;
}

/** True when `publication` addresses `record` — the delivery matrix plus the exact-pair law. */
function addressesRecord(record: SseStreamRecord, publication: SsePublication): boolean {
  if (record.role === 'launcher') {
    return LAUNCHER_STREAM_EVENTS[publication.event.type];
  }
  return (
    publication.scope === 'session' &&
    SESSION_STREAM_EVENTS[publication.event.type] &&
    record.session !== null &&
    sameSession(record.session, publication.session)
  );
}

/** The hub's public surface. */
export interface SseHub {
  /**
   * Installs one admitted stream. Enforces the role caps — at most
   * {@link LIMITS.authoritativeSseClients} authoritative and
   * {@link LIMITS.diagnosticSseClients} diagnostic streams live — and
   * supersedes any stream the SAME client capability still holds (the
   * `EventSource` reconnect case: the fresh connection replaces the
   * dead one instead of being refused against its own slot).
   */
  admit(
    record: SseStreamRecord,
  ):
    | { readonly kind: 'admitted'; readonly id: number }
    | { readonly kind: 'refused'; readonly reason: SseAdmitRefusalReason };
  /** Unregisters a stream that ended on its own — idempotent; never calls `close`. */
  drop(id: number): void;
  /**
   * Ends every stream admitted under `host` — route retirement or
   * host-capability revocation. Returns how many ended.
   */
  endForHost(host: CapabilityHost): number;
  /**
   * Ends every stream bound at the exact `session` — the switch/stop's
   * old-generation revocation. Returns how many ended.
   */
  endForSession(session: SessionRef): number;
  /**
   * Ends the stream(s) admitted under one client capability — binding
   * revocation. Returns how many ended.
   */
  endForBinding(clientCapability: string): number;
  /**
   * Publishes one event to every stream its scope addresses. A
   * stale-generation or over-cap publication is refused whole — no
   * stream ever sees a partial or stale delivery.
   */
  publish(publication: SsePublication): SsePublishOutcome;
  /** The live stream count per role — composition and tests only. */
  counts(): {
    readonly authoritative: number;
    readonly diagnostic: number;
    readonly launcher: number;
  };
}

/**
 * Builds one hub. The composition owns its lifetime alongside the
 * surfaces that feed it. One hub lives at most ONE runtime epoch: the
 * stale-publication watermark pins the epoch at the first session-scoped
 * publication and refuses every other epoch afterwards — a live control
 * plane's epoch is fixed at boot, so a foreign epoch is stale by
 * construction, and a hub that somehow outlived an epoch rotation would
 * fail closed into a permanently refusing (never leaking) channel. A
 * composition that rotates epochs recreates the hub with them.
 */
export function createSseHub(): SseHub {
  interface Live {
    readonly id: number;
    readonly record: SseStreamRecord;
  }
  const live = new Map<number, Live>();
  let nextId = 1;
  /** The newest generation ever published, per the live epoch — the stale-publication watermark. */
  let watermark: SessionRef | null = null;
  /**
   * The pairs a session revocation declared dead: a publication minted
   * under a revoked pair is stale even when no newer-generation event
   * has been published yet (the switch's revocation precedes the first
   * candidate event). Bounded by the epoch's activation count.
   */
  const revokedPairs = new Set<string>();
  const pairKey = (ref: SessionRef): string => `${ref.runtimeEpoch}#${ref.generation}`;

  const countByRole = (): { authoritative: number; diagnostic: number; launcher: number } => {
    let authoritative = 0;
    let diagnostic = 0;
    let launcher = 0;
    for (const { record } of live.values()) {
      if (record.role === 'editor') authoritative += 1;
      else if (record.role === 'diagnostic') diagnostic += 1;
      else launcher += 1;
    }
    return { authoritative, diagnostic, launcher };
  };

  /** Ends and unregisters one stream — the single exit path for every revocation. */
  function endOne(entry: Live): void {
    live.delete(entry.id);
    entry.record.close();
  }

  return {
    admit: (record) => {
      for (const entry of live.values()) {
        if (entry.record.clientCapability === record.clientCapability) endOne(entry);
      }
      const counts = countByRole();
      if (record.role === 'editor' && counts.authoritative >= LIMITS.authoritativeSseClients) {
        return { kind: 'refused', reason: 'authoritative-cap' };
      }
      if (record.role === 'diagnostic' && counts.diagnostic >= LIMITS.diagnosticSseClients) {
        return { kind: 'refused', reason: 'diagnostic-cap' };
      }
      const id = nextId;
      nextId += 1;
      live.set(id, { id, record });
      return { kind: 'admitted', id };
    },
    drop: (id) => {
      live.delete(id);
    },
    endForHost: (host) => {
      let ended = 0;
      for (const entry of live.values()) {
        if (sameHost(entry.record.host, host)) {
          endOne(entry);
          ended += 1;
        }
      }
      return ended;
    },
    endForSession: (session) => {
      // The pair dies with its streams: any later publication minted
      // under it is stale by construction (the switch/stop that ended
      // the session minted nothing more under it).
      revokedPairs.add(pairKey(session));
      let ended = 0;
      for (const entry of live.values()) {
        if (entry.record.session !== null && sameSession(entry.record.session, session)) {
          endOne(entry);
          ended += 1;
        }
      }
      return ended;
    },
    endForBinding: (clientCapability) => {
      let ended = 0;
      for (const entry of live.values()) {
        if (entry.record.clientCapability === clientCapability) {
          endOne(entry);
          ended += 1;
        }
      }
      return ended;
    },
    publish: (publication) => {
      const frame = sseFrame(publication);
      if (frame.kind === 'oversized') {
        return { kind: 'refused', reason: 'oversized-event', bytes: frame.bytes };
      }
      if (publication.scope === 'session') {
        const minted = publication.session;
        if (
          revokedPairs.has(pairKey(minted)) ||
          (watermark !== null &&
            (minted.runtimeEpoch !== watermark.runtimeEpoch ||
              minted.generation < watermark.generation))
        ) {
          // A publication under a generation the hub has moved past, a
          // pair a revocation declared dead, or a foreign epoch after
          // the live one was established — stale, refused whole (events
          // carry the generation they were minted under; none is ever
          // delivered late).
          return { kind: 'refused', reason: 'stale-publication', bytes: frame.bytes };
        }
        watermark = { runtimeEpoch: minted.runtimeEpoch, generation: minted.generation };
      }
      let delivered = 0;
      for (const entry of [...live.values()]) {
        if (!addressesRecord(entry.record, publication)) continue;
        try {
          entry.record.sink(frame.text);
        } catch {
          // A sink that throws is a dead connection: contain the
          // failure to that stream, never the fan-out.
          endOne(entry);
          continue;
        }
        delivered += 1;
      }
      return { kind: 'delivered', streams: delivered };
    },
    counts: () => countByRole(),
  };
}
