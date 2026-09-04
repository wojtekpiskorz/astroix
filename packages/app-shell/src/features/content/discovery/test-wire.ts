import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * Test-only scripted wire for the Content feature's tests (#251): the
 * app-client lane's discipline — the REAL AppClient over stubbed
 * `fetch`, answered with REAL protocol envelope bodies, so the feature
 * is pinned against the wire truth. Inspect exchanges answer per
 * family (`content`/`routes`) with caller-held payloads; the events
 * stream hangs open (its frames are not this feature's surface).
 */

/** One captured request exchange. */
export interface CapturedRequest {
  readonly url: string;
  readonly body: string;
}

/** The wire's inspection family vocabulary as the command body carries it. */
export type InspectionFamily = 'content' | 'routes' | 'project';

interface OpenInspect {
  readonly family: InspectionFamily;
  readonly requestId: string;
  readonly session?: SessionRef;
  settle(response: Response): void;
}

/** The scripted wire — install with `globalThis.fetch = wire.fetch`, restore in afterEach. */
export interface DiscoveryWire {
  readonly captured: readonly CapturedRequest[];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Resolves the OLDEST open exchange of `family` with a success inspection envelope. */
  resolveInspect(family: InspectionFamily, payload: unknown, revision?: number): void;
  /** Resolves the oldest open exchange of `family` with a protocol error envelope. */
  failInspect(family: InspectionFamily, code: string): void;
  /** The open exchange count of `family`. */
  openCount(family: InspectionFamily): number;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Installs the scripted wire. */
export function scriptDiscoveryWire(): DiscoveryWire {
  const captured: CapturedRequest[] = [];
  const open: OpenInspect[] = [];

  const settleInspect = (
    family: InspectionFamily,
    build: (entry: OpenInspect) => Response,
  ): void => {
    const index = open.findIndex((entry) => entry.family === family);
    if (index === -1) throw new Error(`scriptDiscoveryWire: no open ${family} inspect exchange`);
    const [entry] = open.splice(index, 1) as [OpenInspect];
    entry.settle(build(entry));
  };

  return {
    captured,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      captured.push({ url, body });
      if (url.includes('/__astroix/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: () => {}, // hangs open — no frame is this feature's surface
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const parsed = JSON.parse(body) as {
        requestId: string;
        session?: SessionRef;
        command: { kind: string; request?: { kind: InspectionFamily } };
      };
      if (parsed.command.kind !== 'inspect') {
        throw new Error(`scriptDiscoveryWire: unexpected command ${parsed.command.kind}`);
      }
      const family = parsed.command.request?.kind;
      if (family !== 'content' && family !== 'routes' && family !== 'project') {
        throw new Error(`scriptDiscoveryWire: unexpected inspection family ${String(family)}`);
      }
      let settle!: (response: Response) => void;
      const held = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      open.push({ family, requestId: parsed.requestId, session: parsed.session, settle });
      return held;
    }) as typeof fetch,
    resolveInspect: (family, payload, revision = 1) =>
      settleInspect(family, (entry) =>
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            ...(entry.session === undefined ? {} : { session: entry.session }),
            result: { kind: 'inspection', result: { kind: family, revision, payload } },
          }),
        ),
      ),
    failInspect: (family, code) =>
      settleInspect(family, (entry) =>
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            error: { code, message: 'sanitized message', retryable: false },
          }),
        ),
      ),
    openCount: (family) => open.filter((entry) => entry.family === family).length,
  };
}

/**
 * One content-family payload shaped as the runtime's
 * `ContentInspectionResult` serves it — the fields the feature binds,
 * plus the interior fields (filePath, data, body, revision, issues) the
 * projection deliberately drops.
 */
export function contentPayload(input: {
  readonly collections?: readonly {
    readonly name: string;
    readonly entries: readonly {
      readonly id: string;
      readonly filePath?: string | null;
    }[];
  }[];
  readonly diagnostics?: readonly {
    readonly code: string;
    readonly collection: string;
    readonly expected: string;
    readonly observed: string;
  }[];
}): unknown {
  return {
    collections: (input.collections ?? []).map((collection) => ({
      name: collection.name,
      entries: collection.entries.map((entry) => ({
        id: entry.id,
        filePath: entry.filePath ?? `src/content/${collection.name}/${entry.id}.md`,
        data: { title: entry.id },
        body: 'fixture body',
        revision: 'a'.repeat(64),
        issues: null,
      })),
      schema: { declared: true, fields: [] },
      revision: 'b'.repeat(64),
    })),
    diagnostics: input.diagnostics ?? [],
    revision: 'c'.repeat(64),
  };
}

/** One routes-family payload shaped as the runtime's `RoutesInspectionResult` serves it. */
export function routesPayload(
  routes: readonly {
    readonly pattern: string;
    readonly segments: readonly {
      readonly content: string;
      readonly dynamic: boolean;
      readonly spread: boolean;
    }[][];
    readonly params: readonly string[];
    readonly rendering: 'prerendered' | 'on-demand';
    readonly renders?: readonly string[];
  }[],
): unknown {
  return { revision: 1, routes };
}
