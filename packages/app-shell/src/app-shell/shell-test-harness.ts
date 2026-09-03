import type { SessionRef, SseEvent } from '@wojciechpiskorz/astroix-protocol';

/**
 * Test-only fetch harness for the mounted shell tests (#241): stubs the
 * ONE AppClient's wire with REAL protocol envelope bodies (the
 * app-client lane's discipline — pinned against the wire truth, not a
 * re-implementation): inspect exchanges as caller-resolved deferreds
 * carrying their own correlation facts (delayed delivery is the point),
 * deactivation answered with the settled transition's result, and the
 * events stream as caller-held controllers whose frames the tests
 * enqueue by hand.
 */

export const ORIGIN = 'http://project.localhost:4426';
export const CAPABILITY = 'client-capability-fixture';
/** A well-formed 26-char lowercase-base32 project key. */
export const PROJECT_KEY = 'a'.repeat(26);

/** One captured request exchange. */
export interface CapturedRequest {
  readonly url: string;
  readonly body: string;
}

/** A caller-resolved promise. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One success response envelope body, as the runtime's own surfaces write it. */
export function successBody(result: unknown, requestId: string, session?: SessionRef): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId,
    ...(session === undefined ? {} : { session }),
    result,
  });
}

/** One error envelope body. */
export function errorBody(code: string, requestId: string): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId,
    error: { code, message: 'sanitized message', retryable: false },
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** One inspect exchange awaiting its scripted answer. */
interface OpenInspect {
  readonly deferred: Deferred<Response>;
  readonly requestId: string;
  readonly session?: SessionRef;
}

/** The scripted wire — install with `globalThis.fetch = script.fetch`, restore in afterEach. */
export interface FetchScript {
  readonly captured: readonly CapturedRequest[];
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Resolves the oldest unanswered inspect exchange with a success envelope carrying `revision`. */
  resolveInspect(revision: number): void;
  /** Rejects the oldest unanswered inspect exchange with a protocol error envelope. */
  failInspect(code: string): void;
  /** The number of inspect exchanges opened so far. */
  readonly inspectCount: number;
  /** Enqueues one SSE frame on the newest open stream. */
  deliverFrame(session: SessionRef | undefined, event: SseEvent): void;
}

/** Installs the scripted wire. */
export function scriptFetch(): FetchScript {
  const captured: CapturedRequest[] = [];
  const openInspects: OpenInspect[] = [];
  let inspectCount = 0;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const encoder = new TextEncoder();

  return {
    captured,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      captured.push({ url, body });
      if (url.includes('/__astroix/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              streams.push(controller);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const parsed = JSON.parse(body) as {
        requestId: string;
        session?: SessionRef;
        command: { kind: string };
      };
      if (parsed.command.kind === 'inspect') {
        inspectCount += 1;
        const deferred = createDeferred<Response>();
        openInspects.push({ deferred, requestId: parsed.requestId, session: parsed.session });
        return deferred.promise;
      }
      if (parsed.command.kind === 'deactivate') {
        return jsonResponse(
          successBody(
            {
              kind: 'deactivation',
              target: { session: parsed.session, projectKey: PROJECT_KEY },
              snapshot: {},
            },
            parsed.requestId,
            parsed.session,
          ),
        );
      }
      return jsonResponse(successBody({ kind: 'project-list', projects: [] }, parsed.requestId));
    }) as typeof fetch,
    get inspectCount(): number {
      return inspectCount;
    },
    resolveInspect: (revision: number) => {
      const entry = openInspects.shift();
      if (entry === undefined) throw new Error('resolveInspect: no open inspect exchange');
      entry.deferred.resolve(
        jsonResponse(
          successBody(
            { kind: 'inspection', result: { kind: 'project', revision, payload: null } },
            entry.requestId,
            entry.session,
          ),
        ),
      );
    },
    failInspect: (code: string) => {
      const entry = openInspects.shift();
      if (entry === undefined) throw new Error('failInspect: no open inspect exchange');
      entry.deferred.resolve(jsonResponse(errorBody(code, entry.requestId)));
    },
    deliverFrame: (session, event) => {
      const controller = streams[streams.length - 1];
      if (controller === undefined) throw new Error('deliverFrame: no open stream');
      const envelope = {
        protocolVersion: 1,
        ...(session === undefined ? {} : { session }),
        event,
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
    },
  };
}
