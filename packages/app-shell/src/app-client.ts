import {
  API_V1_PREFIX,
  type Command,
  type EditResult,
  type ErrorEnvelope,
  EVENTS_PATH,
  errorEnvelopeSchema,
  type InspectionRequest,
  type InspectionResult,
  MUTATION_HEADER_NAME,
  MUTATION_HEADER_VALUE,
  PROTOCOL_VERSION,
  type ProjectKey,
  type ProjectSummary,
  type ResponseEnvelope,
  responseEnvelopeSchema,
  type SessionRef,
  type SessionSnapshot,
  sseEventEnvelopeSchema,
  type WritePlan,
} from '@wojciechpiskorz/astroix-protocol';
import {
  createSessionClient,
  type SessionClient,
  type SseCloseReason,
  type SseHandlers,
  type SseOptions,
  type SseSubscription,
} from './session-client.ts';

export type {
  SessionClient,
  SseCloseReason,
  SseHandlers,
  SseOptions,
  SseSubscription,
} from './session-client.ts';

/**
 * The one AppClient (#240, G1; ADR-0006 §9; ADR-0002 amendment 4): the
 * single browser-side owner of protocol-v1 request/response fetch, the
 * lifecycle calls, the SSE event stream, session clients, cancellation,
 * pagination, and sanitized errors — consumed by EVERY renderer host
 * (the web host today, the Electron renderer later). No host may grow a
 * second transport: competing session and error semantics are the
 * problem this module exists to make impossible.
 *
 * What it owns, exactly:
 *
 * - **Request envelopes**: every call is one POST to `/__astroix/api/v1/`
 *   carrying `protocolVersion: 1`, a caller-opaque correlation id, the
 *   command, and — for session-scoped traffic — the exact `SessionRef`
 *   (ADR-0006 §3). Mutations carry `X-Astroix-Request: 1`; reads rely on
 *   the browser's same-origin Fetch Metadata. The host capability rides
 *   the `HttpOnly` cookie the browser attaches; the per-document client
 *   capability rides the `x-astroix-client` header this client injects —
 *   never a URL, never a body field.
 * - **Sanitized errors**: a response that is not a protocol success
 *   becomes one {@link AppClientError} carrying the parsed error
 *   envelope — or the closed catch-all shape when the body is not a
 *   protocol envelope at all. Raw response text, statuses as exceptions,
 *   and implementation details never reach host code.
 * - **Cancellation**: every request takes an `AbortSignal`; the SSE
 *   subscriptions take one too and settle `aborted` under it. `close()`
 *   aborts every live stream the client opened.
 * - **Session currency**: `activate`/`deactivate` results move the
 *   client's current-session notion; a session-scoped stream may
 *   reconnect only while its pair is still that current session — the
 *   client-side half of "#240's SSE law", the server's `stale-session`
 *   refusal being the other half.
 * - **Pagination**: {@link collectPages} is the bounded walker over F3's
 *   page shape (`{ items, continuation }`) — the shape every paginated
 *   wire surface answers with; payload interiors that carry a
 *   continuation (the contract-owned cursor seam) walk through it.
 *
 * Deliberately NOT owned here: TanStack Query caches (the host owns the
 * QueryClient; `SessionClient.queryKey` mints the generation-scoped
 * keys), edit admission/debounce/fencing (the shared edit seam,
 * ADR-0002 amendment 5), and any domain knowledge whatsoever — this is
 * foundation-level transport infrastructure under the import-flow law,
 * importing only the protocol package.
 */

/** The closed transport error vocabulary — sanitized, never a status code. */
export type AppClientErrorKind = 'protocol' | 'transport';

/**
 * The one error shape host code ever sees from this client: either a
 * parsed protocol error envelope (kind `protocol`, with its public
 * code/message/retryable/details), or the transport catch-all (kind
 * `transport` — the network or an unparseable body; no detail escapes).
 */
export class AppClientError extends Error {
  readonly kind: AppClientErrorKind;
  /** The sanitized protocol error, when the server answered one. */
  readonly envelope?: ErrorEnvelope;

  private constructor(kind: AppClientErrorKind, message: string, envelope?: ErrorEnvelope) {
    super(message);
    this.name = 'AppClientError';
    this.kind = kind;
    this.envelope = envelope;
  }

  /** One parsed protocol error — the envelope's own sanitized message is the whole text. */
  static fromEnvelope(envelope: ErrorEnvelope): AppClientError {
    return new AppClientError('protocol', envelope.error.message, envelope);
  }

  /** The transport catch-all — constant text, no body bytes, no status. */
  static transport(): AppClientError {
    return new AppClientError('transport', 'the request could not be completed');
  }
}

/** What a successful `activate` settles with — the lifecycle result's own shape (ADR-0006 §7). */
export interface ActivationOutcome {
  readonly target: { readonly session: SessionRef; readonly projectKey: ProjectKey };
  readonly snapshot: SessionSnapshot;
}

/** What a successful `deactivate` settles with. */
export interface DeactivationOutcome {
  readonly target: { readonly session: SessionRef; readonly projectKey: ProjectKey };
  readonly snapshot: SessionSnapshot;
}

/** Construction options; tests inject the origin and clock-ish knobs, production reads the page's own. */
export interface AppClientOptions {
  /** The per-document client capability — the header this client injects on every exchange. */
  readonly clientCapability: string;
  /** The origin all URLs resolve against; defaults to the document's own (`location.origin`). */
  readonly origin?: string;
  /** The SSE reconnect backoff; the production default is a short fixed wait. */
  readonly reconnectDelayMs?: number;
}

/** The one AppClient surface (ADR-0006 §9 — the browser-side shape of that seam). */
export interface AppClient {
  /** The idle registry read (launcher scope): the visible project summaries, one page. */
  projects(signal?: AbortSignal): Promise<readonly ProjectSummary[]>;
  /**
   * Begins the settled activation transition and settles with the
   * lifecycle result — the target pair and the snapshot after the
   * transition (a failed activation settles here too, with the snapshot
   * carrying `lastFailure`; concurrent activation rejects with the
   * protocol's 409 code).
   */
  activate(projectKey: ProjectKey, signal?: AbortSignal): Promise<ActivationOutcome>;
  /** Completes the settled deactivation transition for the current session this client carries. */
  deactivate(signal?: AbortSignal): Promise<DeactivationOutcome>;
  /**
   * The launcher-scoped events stream (idle scope, no session pair on
   * the URL): `session-state` lifecycle progress and `registry-changed`.
   */
  events(handlers: SseHandlers, options?: SseOptions): SseSubscription;
  /** The session-scoped client for one exact pair — requests carry it; the stream is gated on its currency. */
  forSession(ref: SessionRef): SessionClient;
  /**
   * Declares the current session a host document was served under — the
   * project-app bootstrap (the document arrives already bound to its
   * pair; `activate` is the only other mover of the same notion).
   */
  adoptSession(ref: SessionRef): void;
  /** The pair this client currently considers current — moved by `activate`/`deactivate`/`adoptSession`, nothing else. */
  readonly currentSession: SessionRef | null;
  /** Closes every live events subscription this client opened; requests already in flight keep their own signals. */
  close(): void;
}

/** F3's page shape — every paginated surface answers with items plus the offset continuation (#235). */
export interface PageShape<T> {
  readonly items: readonly T[];
  /** The offset cursor the next page starts at — `null` when the page completed the collection. */
  readonly continuation: number | null;
}

/** The bounded page-walk options: cancellation plus the page bound. */
export interface CollectPagesOptions {
  readonly signal?: AbortSignal;
  /** The hard page-count bound; the default (64) is far past any honest collection. */
  readonly maxPages?: number;
}

/**
 * Walks F3's page shape to completion: one page at a time, following the
 * offset continuation, bounded by `maxPages` (a lying page source that
 * never completes fails loudly instead of looping forever) and abortable
 * through `signal`. This is the AppClient's pagination contract — the
 * one walker every host uses, so a paginated interior can never grow a
 * per-host loop.
 */
export async function collectPages<T>(
  fetchPage: (offset: number) => Promise<PageShape<T>>,
  options: CollectPagesOptions = {},
): Promise<readonly T[]> {
  const maxPages = options.maxPages ?? 64;
  const collected: T[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const result = await fetchPage(offset);
    collected.push(...result.items);
    if (result.continuation === null) return collected;
    offset = result.continuation;
  }
  throw new Error('the paginated collection did not complete within its page bound');
}

/** Builds the one AppClient. */
export function createAppClient(options: AppClientOptions): AppClient {
  const origin = options.origin ?? globalThis.location?.origin;
  if (origin === undefined) throw new Error('createAppClient needs an origin outside a document');
  const endpoint = `${origin}${API_V1_PREFIX}`;
  const eventsUrl = `${origin}${EVENTS_PATH}`;
  const reconnectDelayMs = options.reconnectDelayMs ?? 500;
  const live = new Set<{ close(): void }>();
  let currentSession: SessionRef | null = null;
  let nextRequestId = 1;

  /** One command over the wire: envelope out, sanitized result or error in. */
  async function request(command: Command, session?: SessionRef, signal?: AbortSignal) {
    const requestId = `req-${nextRequestId}`;
    nextRequestId += 1;
    // The mutation-marker set mirrors the server's COMMAND_ROUTES truth
    // (`activate`, `deactivate`, `apply-edit` — F2 #234): an unmarked
    // mutation envelope is refused at admission, so this fork must never
    // drift behind it. The single home is a protocol-side table and is
    // fenced to #334 — this set matches the server until that lands.
    const mutation =
      command.kind === 'activate' || command.kind === 'deactivate' || command.kind === 'apply-edit';
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-astroix-client': options.clientCapability,
          ...(mutation ? { [MUTATION_HEADER_NAME]: MUTATION_HEADER_VALUE } : {}),
        },
        cache: 'no-store',
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          ...(session !== undefined ? { session } : {}),
          command,
        }),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw AppClientError.transport();
    }
    // A signal that aborted while the exchange was already settling still
    // aborts: the result of a cancelled exchange is never delivered.
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return parseEnvelope(requestId, response);
  }

  /** Parses one exchange's body: a success envelope's result, or the sanitized error. */
  async function parseEnvelope(requestId: string, response: Response): Promise<ResponseEnvelope> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw AppClientError.transport();
    }
    const parsed = responseEnvelopeSchema.safeParse(body);
    if (parsed.success && parsed.data.requestId === requestId) return parsed.data;
    // Not a success envelope for this exchange: it must be a protocol
    // error envelope — anything else is the transport catch-all.
    const failure = errorEnvelopeSchema.safeParse(body);
    if (failure.success) throw AppClientError.fromEnvelope(failure.data);
    throw AppClientError.transport();
  }

  /** The session-scoped inspect dispatch behind `SessionClient.inspect`. */
  async function inspect(
    ref: SessionRef,
    inspection: InspectionRequest,
    signal?: AbortSignal,
  ): Promise<InspectionResult> {
    const envelope = await request({ kind: 'inspect', request: inspection }, ref, signal);
    if (envelope.result.kind !== 'inspection') throw AppClientError.transport();
    return envelope.result.result;
  }

  /**
   * The session-scoped `apply-edit` dispatch behind
   * `SessionClient.applyEdit` (J3, #253): the wire plan — grant echo,
   * operation, payload — travels verbatim under the mutation marker the
   * request path already sets for this kind. The grant is opaque here by
   * construction: this client never reads it, only carries it.
   */
  async function applyEdit(
    ref: SessionRef,
    plan: WritePlan,
    signal?: AbortSignal,
  ): Promise<EditResult> {
    const envelope = await request({ kind: 'apply-edit', plan }, ref, signal);
    if (envelope.result.kind !== 'edit') throw AppClientError.transport();
    return envelope.result.result;
  }

  /** Opens one events stream — the shared SSE engine for both scopes. */
  function openStream(
    url: string,
    handlers: SseHandlers,
    streamOptions: SseOptions | undefined,
    reconnectWhileCurrent: () => boolean,
  ): SseSubscription {
    const delayMs = streamOptions?.reconnectDelayMs ?? reconnectDelayMs;
    const controller = new AbortController();
    const externalSignal = streamOptions?.signal;
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    let settleClosed: ((reason: SseCloseReason) => void) | null = null;
    const closed = new Promise<SseCloseReason>((resolve) => {
      settleClosed = resolve;
    });
    const record = {
      close: () => {
        controller.abort();
      },
    };
    live.add(record);
    const settle = (reason: SseCloseReason): void => {
      live.delete(record);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      settleClosed?.(reason);
    };

    void runStreamLoop(url, handlers, controller, delayMs, reconnectWhileCurrent, settle).catch(
      () => settle('failed'),
    );

    return { closed, close: record.close };
  }

  /** The stream loop: connect, deliver frames, and reconnect only while the gate allows. */
  async function runStreamLoop(
    url: string,
    handlers: SseHandlers,
    controller: AbortController,
    delayMs: number,
    reconnectWhileCurrent: () => boolean,
    settle: (reason: SseCloseReason) => void,
  ): Promise<void> {
    for (;;) {
      if (controller.signal.aborted) return settle('aborted');
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'x-astroix-client': options.clientCapability },
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbort(error)) return settle('aborted');
        handlers.onTransportError?.();
        return settle('failed');
      }
      if (!response.ok || response.body === null) {
        // A refused stream: a protocol error envelope names stale
        // sessions honestly; every other refusal is terminal without detail.
        const failure = await parseErrorBody(response);
        if (failure !== null && failure.error.code === 'stale-session') {
          handlers.onStale?.();
          return settle('stale');
        }
        handlers.onTransportError?.();
        return settle('failed');
      }
      // The transport-open signal (#342): an admitted stream is live the
      // moment it is established — a quiet session that delivers no frame
      // must not read as eternally connecting. Fires on every
      // (re)connection, before any frame is delivered.
      handlers.onOpen?.();
      const ended = await deliverFrames(response, handlers, controller);
      if (ended === 'aborted') return settle('aborted');
      // The server ended the stream (a revocation ends it server-side):
      // reconnect only while this stream's scope is still current.
      if (!reconnectWhileCurrent()) {
        handlers.onStale?.();
        return settle('stale');
      }
      await delay(delayMs, controller);
    }
  }

  /** Reads one admitted stream to its end — `true` when it ended on its own, `false` never (aborted throws out). */
  async function deliverFrames(
    response: Response,
    handlers: SseHandlers,
    controller: AbortController,
  ): Promise<'ended' | 'aborted'> {
    const reader = response.body?.getReader();
    if (reader === undefined) return 'ended';
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return 'ended';
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        deliverFrame(frame, handlers);
        boundary = buffer.indexOf('\n\n');
      }
      if (controller.signal.aborted) {
        await reader.cancel().catch(() => {});
        return 'aborted';
      }
    }
  }

  /** Delivers one `data:`-only frame (F3's wire shape) as a parsed event envelope. */
  function deliverFrame(frame: string, handlers: SseHandlers): void {
    if (!frame.startsWith('data: ')) return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(frame.slice('data: '.length));
    } catch {
      return; // a malformed frame is dropped, never fatal: the stream itself is the truth
    }
    const parsed = sseEventEnvelopeSchema.safeParse(envelope);
    if (parsed.success) handlers.onEvent(parsed.data);
  }

  /** Best-effort error-envelope parse off a refused stream — null when the body is not one. */
  async function parseErrorBody(response: Response): Promise<ErrorEnvelope | null> {
    try {
      const parsed = errorEnvelopeSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  return {
    get currentSession(): SessionRef | null {
      return currentSession;
    },
    projects: async (signal) => {
      const envelope = await request({ kind: 'list-projects' }, undefined, signal);
      if (envelope.result.kind !== 'project-list') throw AppClientError.transport();
      return envelope.result.projects;
    },
    activate: async (projectKey, signal) => {
      const envelope = await request(
        { kind: 'activate', projectKey },
        currentSession ?? undefined,
        signal,
      );
      if (envelope.result.kind !== 'activation') throw AppClientError.transport();
      // Currency follows COMMITTED sessions only (ADR-0006 §4): a failed
      // attempt's target pair is dead by the time the response arrives —
      // adopting it would make the retry carry a stale ref.
      if (envelope.result.snapshot.active !== undefined) {
        currentSession = envelope.result.target.session;
      }
      return envelope.result;
    },
    deactivate: async (signal) => {
      const ref = currentSession;
      if (ref === null) throw AppClientError.transport();
      const envelope = await request({ kind: 'deactivate' }, ref, signal);
      if (envelope.result.kind !== 'deactivation') throw AppClientError.transport();
      currentSession = null;
      return envelope.result;
    },
    events: (handlers, streamOptions) => openStream(eventsUrl, handlers, streamOptions, () => true),
    forSession: (ref) =>
      createSessionClient(ref, {
        inspect,
        applyEdit,
        openSessionEvents: (sessionRef, handlers, streamOptions) => {
          const url = `${eventsUrl}?runtimeEpoch=${encodeURIComponent(sessionRef.runtimeEpoch)}&generation=${sessionRef.generation}`;
          return openStream(
            url,
            handlers,
            streamOptions,
            () => currentSession !== null && sameSession(currentSession, sessionRef),
          );
        },
      }),
    adoptSession: (ref) => {
      currentSession = ref;
    },
    close: () => {
      for (const record of [...live]) record.close();
    },
  };
}

/** True for the two abort shapes a fetch rejection carries. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Field-wise pair equality — the client's own currency check (never identity). */
function sameSession(a: SessionRef, b: SessionRef): boolean {
  return a.runtimeEpoch === b.runtimeEpoch && a.generation === b.generation;
}

/** One bounded, abortable wait — the reconnect backoff. */
function delay(ms: number, controller: AbortController): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    controller.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
