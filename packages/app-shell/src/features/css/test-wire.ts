import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';

/**
 * Test-only scripted wire for the CSS feature's tests (#249, I1; the
 * Content vertical's `test-wire.ts` discipline, J1 #251): the REAL
 * AppClient over stubbed `fetch`, answered with REAL protocol envelope
 * bodies, so the feature is pinned against the wire truth — above all
 * the SETTLED REQUEST SHAPE: a styles inspection the feature issues
 * carries `{kind: 'styles', route}` (#370's ruled envelope), and the
 * wire records it per exchange for the assertions. The events stream
 * hangs open (its frames are not this feature's surface).
 */

/** One captured request exchange. */
export interface CapturedRequest {
  readonly url: string;
  readonly body: string;
}

/** One captured styles inspection's selection, parsed off the wire body. */
export interface CapturedStylesSelection {
  readonly kind: 'styles';
  readonly route: string;
}

interface OpenInspect {
  readonly requestId: string;
  readonly session?: SessionRef;
  readonly selection: CapturedStylesSelection | null;
  settle(response: Response): void;
}

/** The scripted wire — install with `globalThis.fetch = wire.fetch`, restore in afterEach. */
export interface CssWire {
  readonly captured: readonly CapturedRequest[];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** The styles selections issued so far, in order (route-carrying or not). */
  stylesSelections(): readonly (CapturedStylesSelection | null)[];
  /** Resolves the OLDEST open styles exchange with a success inspection envelope. */
  resolveStyles(payload: unknown, revision?: number): void;
  /** Resolves the oldest open styles exchange with a protocol error envelope. */
  failStyles(code: string): void;
  /** The open styles exchange count. */
  openCount(): number;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Installs the scripted wire. */
export function scriptCssWire(): CssWire {
  const captured: CapturedRequest[] = [];
  const open: OpenInspect[] = [];
  const selections: (CapturedStylesSelection | null)[] = [];

  const settleInspect = (build: (entry: OpenInspect) => Response): void => {
    if (open.length === 0) throw new Error('scriptCssWire: no open styles exchange');
    const [entry] = open.splice(0, 1) as [OpenInspect];
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
          new ReadableStream<Uint8Array>({ start: () => {} }), // hangs open
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const parsed = JSON.parse(body) as {
        requestId: string;
        session?: SessionRef;
        command: { kind?: string; request?: { kind?: string; route?: string } };
      };
      if (parsed.command.kind !== 'inspect') {
        throw new Error(`scriptCssWire: unexpected command ${String(parsed.command.kind)}`);
      }
      if (parsed.command.request?.kind !== 'styles') {
        throw new Error(
          `scriptCssWire: unexpected inspection family ${String(parsed.command.request?.kind)}`,
        );
      }
      const route = parsed.command.request.route;
      const selection: CapturedStylesSelection | null =
        typeof route === 'string' ? { kind: 'styles', route } : null;
      selections.push(selection);
      let settle!: (response: Response) => void;
      const held = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      open.push({ requestId: parsed.requestId, session: parsed.session, selection, settle });
      return held;
    }) as typeof fetch,
    stylesSelections: () => [...selections],
    resolveStyles: (payload, revision = 1) =>
      settleInspect((entry) =>
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            ...(entry.session === undefined ? {} : { session: entry.session }),
            result: { kind: 'inspection', result: { kind: 'styles', revision, payload } },
          }),
        ),
      ),
    failStyles: (code) =>
      settleInspect((entry) =>
        jsonResponse(
          JSON.stringify({
            protocolVersion: 1,
            requestId: entry.requestId,
            error: { code, message: 'sanitized message', retryable: false },
          }),
        ),
      ),
    openCount: () => open.length,
  };
}

/**
 * One converged styles payload shaped as the runtime's converged
 * inspector serves it — the fields the feature binds (revision,
 * invalidationRevision, records).
 */
export function stylesPayload(input: {
  readonly revision?: number;
  readonly invalidationRevision?: number;
  readonly records: readonly {
    readonly selector: string;
    readonly file: string;
    readonly range?: { readonly start: number; readonly end: number };
    readonly media?: string | null;
    readonly scoped?: boolean;
    readonly styleBlockIndex?: number | null;
    readonly line?: number;
    readonly effectiveSelector?: string | null;
  }[];
}): unknown {
  return {
    revision: input.revision ?? 1,
    invalidationRevision: input.invalidationRevision ?? 0,
    records: input.records.map((record, index) => ({
      selector: record.selector,
      file: record.file,
      range: record.range ?? { start: index * 100, end: index * 100 + 40 },
      media: record.media ?? null,
      scoped: record.scoped ?? false,
      styleBlockIndex: record.styleBlockIndex ?? null,
      line: record.line ?? index + 1,
      effectiveSelector: record.effectiveSelector ?? null,
    })),
  };
}
