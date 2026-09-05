import type {
  ProjectSummary,
  SessionRef,
  SseEventEnvelope,
  WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppClientError, collectPages, createAppClient } from './app-client.ts';

/**
 * The AppClient focused lane (#240): protocol-envelope construction,
 * session currency, cancellation, sanitized errors, pagination, and the
 * SSE engine — unit-tier over stubbed `fetch` exchanges (the REAL wire
 * is the Playwright web-host lane, `e2e/web/**`). The stubs answer with
 * REAL protocol envelopes (built as the runtime's own surfaces write
 * them), so the client is pinned against the wire truth, not against a
 * re-implementation of it.
 */

const ORIGIN = 'http://launcher.localhost:4426';
const CAPABILITY = 'client-capability-fixture';
const KEY: ProjectSummary['projectKey'] = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };
const NEXT: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 2 };

/** The real fetch under test — restored after each leg. */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** One captured request exchange. */
interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: string;
}

/** Stubs fetch with a handler over captured requests. */
function stubFetch(handler: (request: CapturedRequest) => Promise<Response>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    captured.push({ url: String(input), init: init ?? {}, body });
    return handler(captured[captured.length - 1] as CapturedRequest);
  }) as typeof fetch;
  return captured;
}

/** One success response envelope body, as the runtime's own successResponse writes it. */
function successBody(result: unknown, requestId = 'req-1', session?: SessionRef): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId,
    ...(session !== undefined ? { session } : {}),
    result,
  });
}

/** One error envelope body, as the runtime's own errorResponse writes it. */
function errorBody(code: string, message = 'sanitized message', retryable = false): string {
  return JSON.stringify({
    protocolVersion: 1,
    requestId: 'req-1',
    error: { code, message, retryable },
  });
}

/** Captures a rejection's value as the error it is — the legs' assertion seam. */
async function capture<T>(promise: Promise<T>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

/** One JSON response. */
function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** One SSE stream response over frames the caller controls. */
function streamResponse(
  frames: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  status = 200,
): Response {
  const stream = new ReadableStream<Uint8Array>({ start: frames });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** Encodes one SSE frame (`data:`-only, F3's wire shape). */
function frame(envelope: SseEventEnvelope | object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`);
}

describe('protocol request construction', () => {
  it('projects() posts one list-projects envelope to the v1 endpoint with the client capability and no mutation marker', async () => {
    const captured = stubFetch(async () =>
      jsonResponse(successBody({ kind: 'project-list', projects: [] })),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    await client.projects();
    expect(captured).toHaveLength(1);
    const request = captured[0] as CapturedRequest;
    expect(request.url).toBe(`${ORIGIN}/__astroix/api/v1`);
    expect(request.init.method).toBe('POST');
    expect(request.init.cache).toBe('no-store');
    const headers = request.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-astroix-client']).toBe(CAPABILITY);
    expect(headers['x-astroix-request']).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      protocolVersion: 1,
      requestId: 'req-1',
      command: { kind: 'list-projects' },
    });
  });

  it('settles the project summaries from the response envelope', async () => {
    const projects: ProjectSummary[] = [
      { projectKey: KEY, displayName: 'Fixture', availability: 'available' },
    ];
    stubFetch(async () => jsonResponse(successBody({ kind: 'project-list', projects })));
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    await expect(client.projects()).resolves.toEqual(projects);
  });

  it('activates with the mutation marker and moves the current session to the target pair', async () => {
    const captured = stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'activation',
            target: { session: NEXT, projectKey: KEY },
            snapshot: { active: { ref: NEXT, projectKey: KEY, state: 'ready' } },
          },
          'req-1',
          NEXT,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const outcome = await client.activate(KEY);
    const headers = (captured[0] as CapturedRequest).init.headers as Record<string, string>;
    expect(headers['X-Astroix-Request']).toBe('1');
    expect(JSON.parse((captured[0] as CapturedRequest).body).command).toEqual({
      kind: 'activate',
      projectKey: KEY,
    });
    expect(outcome.snapshot.active?.ref).toEqual(NEXT);
    expect(client.currentSession).toEqual(NEXT);
  });

  it('a failed activation settles its result but does not move the session currency', async () => {
    stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'activation',
            target: { session: NEXT, projectKey: KEY },
            snapshot: {
              lastFailure: {
                category: 'startup',
                message: 'the candidate project session failed to start',
              },
            },
          },
          'req-1',
          NEXT,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const outcome = await client.activate(KEY);
    expect(outcome.snapshot.lastFailure?.category).toBe('startup');
    expect(client.currentSession).toBeNull();
  });

  it('a response envelope whose requestId is not the request’s own is refused as a transport failure', async () => {
    stubFetch(async () =>
      jsonResponse(successBody({ kind: 'project-list', projects: [] }, 'req-other')),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    await expect(client.projects()).rejects.toMatchObject({ kind: 'transport' });
  });
});

describe('session-scoped pairing verifies the envelope’s session pair (#436)', () => {
  /**
   * The stale-request-delivery defense (#436, found by the K3 proof lane
   * #256): request ids are minted from a PER-DOCUMENT counter (every
   * served document starts at `req-1`), so across an A-B-A switch the
   * dying generation's write envelope and the live one's can carry the
   * SAME id. A hostile Service Worker captures generation A1's apply-edit
   * success envelope and answers A2's live request with those bytes: the
   * id pairs, and — without this defense — the live write loop resolves
   * committed on a write that never reached the server. The session-scoped
   * exchange path therefore pairs on the requesting PAIR as well as the
   * id; the fixtures model A1 as SESSION and the returning A2 as NEXT.
   */
  const WRITE_PLAN: WritePlan = {
    operation: 'replace-contents',
    grant: {
      token: 'b'.repeat(48),
      kind: 'content',
      operations: ['replace-contents'],
      displayPath: 'src/content/blog/hello-builder.md',
      baseline: { type: 'sha256', sha256: 'f'.repeat(64) },
    },
    contents: '---\ntitle: Written\n---\n\nbody\n',
  };

  /** A1's captured apply-edit success envelope interior — the replayed bytes. */
  const A1_EDIT_SUCCESS = {
    kind: 'edit',
    result: {
      revision: 1,
      nextGrant: {
        token: 'c'.repeat(48),
        kind: 'content',
        operations: ['replace-contents'],
        displayPath: 'src/content/blog/hello-builder.md',
        baseline: { type: 'sha256', sha256: 'e'.repeat(64) },
      },
    },
  };

  it('a colliding requestId with a dead generation’s session pair never resolves the live exchange — the forged commit is refused', async () => {
    // THE leg (#436): the stub is the hostile worker — it answers A2's
    // live apply-edit with A1's captured success bytes, echoing the live
    // request's OWN id (the per-document counters collide by
    // construction) while the envelope carries A1's dead pair. Pre-fix,
    // this leg is red by construction: the id alone pairs, and
    // `applyEdit` resolves the A1 edit result — the forged commit.
    stubFetch(async (request) => {
      const { requestId } = JSON.parse(request.body) as { requestId: string };
      return jsonResponse(successBody(A1_EDIT_SUCCESS, requestId, SESSION));
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(NEXT);
    const error = (await capture(client.forSession(NEXT).applyEdit(WRITE_PLAN))) as AppClientError;
    // The stale success lands on the existing unmatched-envelope path:
    // the transport catch-all, never a resolved commit and never a
    // laundered protocol error.
    expect(error).toBeInstanceOf(AppClientError);
    expect(error.kind).toBe('transport');
    expect(error.envelope).toBeUndefined();
  });

  it('an envelope carrying the requesting pair alongside the matching id resolves normally — no false rejection', async () => {
    // The fix's other edge: a genuine A2 answer (the envelope's session
    // IS the requesting pair) must still pair on the id. Green pre-fix
    // and post-fix — this leg guards against over-rejection.
    stubFetch(async (request) => {
      const { requestId } = JSON.parse(request.body) as { requestId: string };
      return jsonResponse(successBody(A1_EDIT_SUCCESS, requestId, NEXT));
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(NEXT);
    const result = await client.forSession(NEXT).applyEdit(WRITE_PLAN);
    expect(result.revision).toBe(1);
    expect(result.nextGrant?.token).toBe('c'.repeat(48));
  });

  it('a launcher-scoped exchange pairs on the id alone, exactly as before — no session to verify', async () => {
    // Launcher scope (`list-projects`; session forbidden by the
    // protocol's presence tables): unchanged behavior. Green pre-fix and
    // post-fix.
    stubFetch(async () => jsonResponse(successBody({ kind: 'project-list', projects: [] })));
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    await expect(client.projects()).resolves.toEqual([]);
  });

  it('an activate answered by the NEW target pair still resolves — the activation response never echoes the requester', async () => {
    // The check's scope is the presence table's `required` commands
    // (`deactivate`, `inspect`, `apply-edit`) — the exchanges whose
    // success envelopes echo the requesting pair. `activate` is
    // `optional` and its response is scoped to the NEW target pair
    // (ADR-0006 §7), so a session-carrying activate request must keep
    // pairing on the id alone. Green pre-fix and post-fix; red the day
    // someone widens the check to "the request carried a session".
    stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'activation',
            target: { session: NEXT, projectKey: KEY },
            snapshot: { active: { ref: NEXT, projectKey: KEY, state: 'ready' } },
          },
          'req-1',
          NEXT,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(SESSION);
    const outcome = await client.activate(KEY);
    expect(outcome.target.session).toEqual(NEXT);
    expect(client.currentSession).toEqual(NEXT);
  });

  it('a session-scoped success without its session does not parse — the protocol refuses it before any pairing (#436’s protocol read)', async () => {
    // The protocol decision, as executable evidence:
    // `RESULT_SESSION_PRESENCE` is `required` for `edit`, and the
    // response envelope's superRefine rejects a session-scoped success
    // without its SessionRef — so this shape is IMPOSSIBLE by protocol,
    // not a runtime fail-closed branch. The schema is the wall; this leg
    // is green pre-fix and post-fix.
    stubFetch(async (request) => {
      const { requestId } = JSON.parse(request.body) as { requestId: string };
      return jsonResponse(successBody(A1_EDIT_SUCCESS, requestId));
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(NEXT);
    const error = (await capture(client.forSession(NEXT).applyEdit(WRITE_PLAN))) as AppClientError;
    expect(error).toBeInstanceOf(AppClientError);
    expect(error.kind).toBe('transport');
  });

  it('a schema-valid session-less success answering a session-scoped exchange cannot pair — the belt behind the schema', async () => {
    // The belt: `project-list` is the one success shape the schema lets
    // travel session-less. Answering a session-scoped apply-edit with it
    // is refused by the pairing's session half (an envelope that cannot
    // carry the requesting pair cannot pair). The terminal outcome is
    // transport on both trees — pre-fix via the applyEdit kind check,
    // post-fix one layer earlier at the pairing; the leg pins that no
    // session-less shape ever resolves a session-scoped exchange.
    stubFetch(async (request) => {
      const { requestId } = JSON.parse(request.body) as { requestId: string };
      return jsonResponse(successBody({ kind: 'project-list', projects: [] }, requestId));
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(NEXT);
    const error = (await capture(client.forSession(NEXT).applyEdit(WRITE_PLAN))) as AppClientError;
    expect(error).toBeInstanceOf(AppClientError);
    expect(error.kind).toBe('transport');
  });
});

describe('session currency and SessionRef carriage', () => {
  it('forSession(ref).inspect carries the exact pair on the envelope and settles the typed result', async () => {
    const captured = stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'inspection',
            result: { kind: 'project', revision: 7, payload: { base: '/' } },
          },
          'req-1',
          SESSION,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const result = await client.forSession(SESSION).inspect({ kind: 'project' });
    expect(JSON.parse((captured[0] as CapturedRequest).body).session).toEqual(SESSION);
    expect(result).toEqual({ kind: 'project', revision: 7, payload: { base: '/' } });
  });

  it('deactivate carries the adopted pair and clears the currency', async () => {
    const captured = stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'deactivation',
            target: { session: SESSION, projectKey: KEY },
            snapshot: {},
          },
          'req-1',
          SESSION,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(SESSION);
    await client.deactivate();
    const envelope = JSON.parse((captured[0] as CapturedRequest).body);
    expect(envelope.command).toEqual({ kind: 'deactivate' });
    expect(envelope.session).toEqual(SESSION);
    expect(client.currentSession).toBeNull();
  });

  it('marks exactly the protocol table’s mutations — deactivate carries the wire marker, inspect does not (#334)', async () => {
    const captured = stubFetch(async (request) => {
      const { command, requestId } = JSON.parse(request.body) as {
        command: { kind: string };
        requestId: string;
      };
      if (command.kind === 'deactivate') {
        return jsonResponse(
          successBody(
            { kind: 'deactivation', target: { session: SESSION, projectKey: KEY }, snapshot: {} },
            requestId,
            SESSION,
          ),
        );
      }
      return jsonResponse(
        successBody(
          { kind: 'inspection', result: { kind: 'project', revision: 1, payload: { base: '/' } } },
          requestId,
          SESSION,
        ),
      );
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(SESSION);
    await client.deactivate();
    await client.forSession(SESSION).inspect({ kind: 'project' });
    // The wire marker rides exactly the protocol's COMMAND_MUTATION
    // table — the same truth the server's route matrix derives from.
    const deactivateHeaders = (captured[0] as CapturedRequest).init.headers as Record<
      string,
      string
    >;
    const inspectHeaders = (captured[1] as CapturedRequest).init.headers as Record<string, string>;
    expect(deactivateHeaders['X-Astroix-Request']).toBe('1');
    expect(inspectHeaders['X-Astroix-Request']).toBeUndefined();
  });

  it('the session client’s query keys are generation-scoped by construction', () => {
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const key = client.forSession(NEXT).queryKey('styles', 'index');
    expect(key).toEqual(['astroix', NEXT.runtimeEpoch, NEXT.generation, 'styles', 'index']);
  });

  it('forSession(ref).applyEdit carries the exact pair, the mutation marker, and the echoed plan verbatim (J3)', async () => {
    const captured = stubFetch(async () =>
      jsonResponse(
        successBody(
          {
            kind: 'edit',
            result: {
              revision: 1,
              nextGrant: {
                token: 'c'.repeat(48),
                kind: 'content',
                operations: ['replace-contents'],
                displayPath: 'src/content/blog/hello-builder.md',
                baseline: { type: 'sha256', sha256: 'e'.repeat(64) },
              },
            },
          },
          'req-1',
          SESSION,
        ),
      ),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const plan: WritePlan = {
      operation: 'replace-contents',
      grant: {
        token: 'b'.repeat(48),
        kind: 'content',
        operations: ['replace-contents'],
        displayPath: 'src/content/blog/hello-builder.md',
        baseline: { type: 'sha256', sha256: 'f'.repeat(64) },
      },
      contents: '---\ntitle: Written\n---\n\nbody\n',
    };
    const result = await client.forSession(SESSION).applyEdit(plan);
    const request = captured[0] as CapturedRequest;
    const envelope = JSON.parse(request.body);
    // the write law: the plan rides the apply-edit command VERBATIM (the
    // grant echo is untouched), under the mutation marker F2 demands
    expect(envelope.command).toEqual({ kind: 'apply-edit', plan });
    expect(envelope.session).toEqual(SESSION);
    expect((request.init.headers as Record<string, string>)['X-Astroix-Request']).toBe('1');
    expect(result.revision).toBe(1);
    expect(result.nextGrant?.token).toBe('c'.repeat(48));
  });
});

describe('sanitized errors', () => {
  it('a protocol error envelope settles as AppClientError carrying the envelope', async () => {
    stubFetch(async () => jsonResponse(errorBody('concurrent-activation'), 409));
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const error = (await capture(client.activate(KEY))) as AppClientError;
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe('protocol');
    expect(error.envelope?.error.code).toBe('concurrent-activation');
    expect(error.message).toBe('sanitized message');
  });

  it('a body that is not a protocol envelope becomes the transport catch-all with no body text', async () => {
    stubFetch(async () => jsonResponse('<html>proxy noise</html>', 502));
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const error = (await capture(client.projects())) as AppClientError;
    expect(error.kind).toBe('transport');
    expect(error.message).not.toContain('proxy');
    expect(error.envelope).toBeUndefined();
  });

  it('a network failure becomes the transport catch-all', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed somewhere untrusted');
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const error = (await capture(client.projects())) as AppClientError;
    expect(error.kind).toBe('transport');
    expect(error.message).not.toContain('untrusted');
  });
});

describe('cancellation', () => {
  it('an aborted signal rejects with the DOM AbortError, not a sanitized transport error', async () => {
    const controller = new AbortController();
    stubFetch(async () => {
      controller.abort();
      return jsonResponse(successBody({ kind: 'project-list', projects: [] }));
    });
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    await expect(client.projects(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('collectPages aborts between pages through the signal', async () => {
    const controller = new AbortController();
    const pages = vi.fn(async () => {
      controller.abort();
      return { items: [1], continuation: 1 };
    });
    await expect(collectPages(pages, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('pagination (F3’s page shape)', () => {
  it('walks continuation offsets to completion and concatenates the items', async () => {
    const offsets: number[] = [];
    const items = await collectPages(async (offset) => {
      offsets.push(offset);
      return offset === 0
        ? { items: ['a', 'b'], continuation: 2 }
        : { items: ['c'], continuation: null };
    });
    expect(items).toEqual(['a', 'b', 'c']);
    expect(offsets).toEqual([0, 2]);
  });

  it('a page source that never completes fails loudly at the page bound instead of looping', async () => {
    await expect(
      collectPages(async (offset) => ({ items: [offset], continuation: offset + 1 }), {
        maxPages: 3,
      }),
    ).rejects.toThrow('page bound');
  });
});

describe('the SSE engine', () => {
  it('delivers parsed event envelopes off data-only frames on the launcher stream', async () => {
    stubFetch(async () =>
      streamResponse((controller) => {
        controller.enqueue(
          frame({
            protocolVersion: 1,
            event: { type: 'registry-changed' },
          }),
        );
        // happy-dom buffers a Response body to completion, so the chunk
        // is observable once the stream closes; incremental delivery is
        // the real browser's, pinned by the Playwright lane.
        controller.close();
      }),
    );
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    const events: unknown[] = [];
    const subscription = client.events({ onEvent: (event) => events.push(event) });
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    subscription.close();
    await expect(subscription.closed).resolves.toBe('aborted');
    expect(events[0]).toEqual({ protocolVersion: 1, event: { type: 'registry-changed' } });
  });

  it('the session stream carries the pair on the query string (the EventSource law: no body, no headers beyond the capability)', async () => {
    const captured = stubFetch(async () =>
      streamResponse((controller) => {
        controller.close();
      }),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    client.adoptSession(SESSION);
    const subscription = client.forSession(SESSION).events({ onEvent: () => {} });
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
    expect((captured[0] as CapturedRequest).url).toBe(
      `${ORIGIN}/__astroix/events?runtimeEpoch=epoch-fixture&generation=1`,
    );
    subscription.close();
    await expect(subscription.closed).resolves.toBe('aborted');
  });

  it('a stream the server ends reconnects while its pair is still the current session', async () => {
    let opens = 0;
    stubFetch(async () => {
      opens += 1;
      return streamResponse((controller) => {
        controller.close();
      });
    });
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    client.adoptSession(SESSION);
    const subscription = client.forSession(SESSION).events({ onEvent: () => {} });
    await vi.waitFor(() => expect(opens).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    subscription.close();
    await expect(subscription.closed).resolves.toBe('aborted');
  });

  it('a stream whose session is no longer current settles stale and never reconnects', async () => {
    let opens = 0;
    stubFetch(async () => {
      opens += 1;
      return streamResponse((controller) => {
        controller.close();
      });
    });
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    client.adoptSession(SESSION);
    const subscription = client.forSession(SESSION).events({ onEvent: () => {} });
    // One open happens; the server ends it; the currency has already moved on.
    await vi.waitFor(() => expect(opens).toBe(1), { timeout: 3000 });
    client.adoptSession(NEXT);
    await expect(subscription.closed).resolves.toBe('stale');
    expect(opens).toBe(1);
  });

  it('a stale-session refusal on the wire settles stale without a reconnect', async () => {
    let opens = 0;
    stubFetch(async () => {
      opens += 1;
      return jsonResponse(errorBody('stale-session'), 409);
    });
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    client.adoptSession(SESSION);
    let stale = false;
    const subscription = client.forSession(SESSION).events({
      onEvent: () => {},
      onStale: () => {
        stale = true;
      },
    });
    await expect(subscription.closed).resolves.toBe('stale');
    expect(stale).toBe(true);
    expect(opens).toBe(1);
  });

  it('close() aborts the live launcher stream', async () => {
    stubFetch(
      (request) =>
        new Promise<Response>((_, reject) => {
          // A never-settling fetch that still honors its signal — the
          // close path must drive the abort through to the exchange.
          request.init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const client = createAppClient({ clientCapability: CAPABILITY, origin: ORIGIN });
    const subscription = client.events({ onEvent: () => {} });
    client.close();
    await expect(subscription.closed).resolves.toBe('aborted');
  });

  it('onOpen fires when the transport establishes an admitted stream — no frame needed', async () => {
    let opens = 0;
    let events = 0;
    let endStream: (() => void) | undefined;
    stubFetch(async () =>
      streamResponse((controller) => {
        // Held open with ZERO frames enqueued: the transport-open signal
        // alone is the point (#342 — a quiet session is live, not
        // eternally connecting).
        endStream = () => controller.close();
      }),
    );
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    client.adoptSession(SESSION);
    const subscription = client.forSession(SESSION).events({
      onEvent: () => {
        events += 1;
      },
      onOpen: () => {
        opens += 1;
      },
    });
    await vi.waitFor(() => expect(opens).toBe(1));
    // The currency moves while the quiet stream is still open, THEN the
    // server ends it: the ended stream finds a moved-past gate and
    // settles stale — exactly one connection ever happened.
    client.adoptSession(NEXT);
    endStream?.();
    await expect(subscription.closed).resolves.toBe('stale');
    expect(opens).toBe(1);
    expect(events).toBe(0);
  });

  it('onOpen fires again on each reconnect of a still-current stream', async () => {
    let opens = 0;
    stubFetch(async () =>
      streamResponse((controller) => {
        controller.close();
      }),
    );
    const client = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    client.adoptSession(SESSION);
    const subscription = client.forSession(SESSION).events({
      onEvent: () => {},
      onOpen: () => {
        opens += 1;
      },
    });
    // Every stream the server ends reconnects while the pair is current —
    // each successful (re)connection is another open signal.
    await vi.waitFor(() => expect(opens).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    client.adoptSession(NEXT);
    await expect(subscription.closed).resolves.toBe('stale');
  });

  it('onOpen never fires on a refusal — stale or otherwise', async () => {
    let opens = 0;
    stubFetch(async () => jsonResponse(errorBody('stale-session'), 409));
    const staleClient = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    staleClient.adoptSession(SESSION);
    const stale = staleClient.forSession(SESSION).events({
      onEvent: () => {},
      onOpen: () => {
        opens += 1;
      },
    });
    await expect(stale.closed).resolves.toBe('stale');
    expect(opens).toBe(0);

    stubFetch(async () => jsonResponse(errorBody('unauthorized'), 403));
    const refusedClient = createAppClient({
      clientCapability: CAPABILITY,
      origin: ORIGIN,
      reconnectDelayMs: 0,
    });
    refusedClient.adoptSession(SESSION);
    const refused = refusedClient.forSession(SESSION).events({
      onEvent: () => {},
      onOpen: () => {
        opens += 1;
      },
    });
    await expect(refused.closed).resolves.toBe('failed');
    expect(opens).toBe(0);
  });
});
