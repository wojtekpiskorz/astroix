import {
  EVENTS_PATH,
  errorEnvelopeSchema,
  type SseEventEnvelope,
  sseEventEnvelopeSchema,
} from '@wojciechpiskorz/astroix-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReservedApiSurface } from '../../api/http/reserved-handler.ts';
import { createOriginListener, type OriginListener } from '../../origin/origin-listener.ts';
import { ssePublication } from '../../sse/sse-frames.ts';
import { createSseHub, type SseHub } from '../../sse/sse-hub.ts';
import { createEventsApiSurface } from '../../sse/sse-surface.ts';
import { rawExchange, type StandInUpstream, startStandInUpstream } from '../proxy/stand-ins.ts';
import {
  createSseAuthorityFixture,
  eventsQuery,
  KEY_A,
  launcherStreamHeaders,
  NEXT_SESSION,
  openSse,
  projectStreamHeaders,
  rawSseGet,
  SESSION,
  type SseAuthorityFixture,
  type SseConnection,
  waitFor,
  withoutHeader,
} from './fixtures.ts';

/**
 * The F3 real-socket focused legs (#235): the events surface composed
 * behind F1's REAL origin listener on OS-assigned loopback ports, with
 * the F2 API surface mounted as the fallback — the exact composition
 * every future host mounts (reserved traffic splits at the events
 * route; everything else is the command endpoint). The stand-in
 * upstream proves the reserved namespace never proxies. Open streams
 * are driven over raw sockets: head, frames, and the observed close —
 * the wire truth of admission, delivery, revocation, and the
 * zero-old-generation law.
 */

interface SocketFixture {
  readonly listener: OriginListener;
  readonly fixture: SseAuthorityFixture;
  readonly hub: SseHub;
  readonly upstream: StandInUpstream;
}

let socket: SocketFixture | null = null;

beforeEach(async () => {
  const upstream = await startStandInUpstream();
  const hub = createSseHub();
  const api = createReservedApiSurface();
  const events = createEventsApiSurface({ fallback: api.handler, hub });
  const listener = await createOriginListener({ handleReserved: events.handler });
  const fixture = createSseAuthorityFixture({ expectedPort: listener.port });
  api.setAuthority({
    ...fixture.authority,
    executeCommand: async (envelope) => ({
      protocolVersion: 1,
      requestId: envelope.requestId,
      result: { kind: 'project-list', projects: [] },
    }),
  });
  events.setAuthority(fixture.authority);
  listener.grantProjectLease({
    projectKey: KEY_A,
    upstream: { host: '127.0.0.1', port: upstream.port },
  });
  socket = { listener, fixture, hub, upstream };
});

afterEach(async () => {
  const current = socket;
  socket = null;
  await current?.listener.close();
  await current?.upstream.close();
});

/** Parses every complete frame collected on a stream connection into protocol envelopes. */
function envelopesOf(connection: { readonly frames: readonly string[] }): SseEventEnvelope[] {
  return connection.frames
    .join('')
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => sseEventEnvelopeSchema.parse(JSON.parse(frame.replace(/^data: /, ''))));
}

/** The fixture's diagnostic mint — one small session-scoped publication. */
function diagnosticPublication(session = SESSION) {
  const publication = ssePublication({
    session,
    event: { type: 'diagnostic', level: 'info', message: 'socket leg event' },
  });
  if (publication === null) throw new Error('fixture publication failed to construct');
  return publication;
}

async function openEditorStream(
  port: number,
  fixture: SseAuthorityFixture,
): Promise<SseConnection> {
  return openSse(
    port,
    rawSseGet(`${EVENTS_PATH}${eventsQuery(SESSION)}`, projectStreamHeaders(fixture, 'editor')),
  );
}

async function openDiagnosticStream(
  port: number,
  fixture: SseAuthorityFixture,
  capability = 'client-diagnostic-0',
): Promise<SseConnection> {
  const headers = projectStreamHeaders(fixture, 'diagnostic', {
    'X-Astroix-Client': capability,
  });
  return openSse(port, rawSseGet(`${EVENTS_PATH}${eventsQuery(SESSION)}`, headers));
}

async function openLauncherStream(
  port: number,
  fixture: SseAuthorityFixture,
): Promise<SseConnection> {
  return openSse(port, rawSseGet(EVENTS_PATH, launcherStreamHeaders(fixture)));
}

describe('an admitted stream at the wire', () => {
  it('answers 200 with the event-stream head — no-store, generated marker, zero CORS — and never proxies', async () => {
    const { listener, fixture, upstream } = socket as SocketFixture;
    const connection = await openEditorStream(listener.port, fixture);
    try {
      expect(connection.status).toBe(200);
      const headers = connection.headers.toLowerCase();
      expect(headers).toContain('content-type: text/event-stream');
      expect(headers).toContain('cache-control: no-store');
      expect(headers).toContain('x-astroix-generated: 1');
      expect(headers).not.toContain('access-control');
      expect(headers).not.toContain('content-length');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      connection.end();
    }
  });

  it('delivers a published event as one well-formed frame carrying the exact pair', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const connection = await openEditorStream(listener.port, fixture);
    try {
      const outcome = hub.publish(diagnosticPublication());
      expect(outcome).toMatchObject({ kind: 'delivered', streams: 1 });
      await waitFor(() => connection.frames.join('').includes('\n\n'));
      const envelopes = envelopesOf(connection);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.session).toEqual(SESSION);
      expect(envelopes[0]?.event.type).toBe('diagnostic');
    } finally {
      connection.end();
    }
  });

  it('delivers the same event to the open editor and diagnostic streams of the pair', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const editor = await openEditorStream(listener.port, fixture);
    const diagnostic = await openDiagnosticStream(listener.port, fixture);
    try {
      expect(hub.publish(diagnosticPublication())).toMatchObject({ kind: 'delivered', streams: 2 });
      await waitFor(() => diagnostic.frames.join('').includes('\n\n'));
      expect(envelopesOf(editor)).toHaveLength(1);
      expect(envelopesOf(diagnostic)).toHaveLength(1);
    } finally {
      editor.end();
      diagnostic.end();
    }
  });

  it('delivers lifecycle progress and the registry nudge to the launcher stream, session events never', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const launcher = await openLauncherStream(listener.port, fixture);
    try {
      const state = ssePublication({
        session: SESSION,
        event: {
          type: 'session-state',
          snapshot: { active: { ref: SESSION, projectKey: KEY_A, state: 'ready' } },
        },
      });
      expect(state).not.toBeNull();
      expect(hub.publish(state ?? diagnosticPublication())).toMatchObject({
        kind: 'delivered',
        streams: 1,
      });
      const nudge = ssePublication({ event: { type: 'registry-changed' } });
      expect(nudge).not.toBeNull();
      expect(hub.publish(nudge ?? diagnosticPublication())).toMatchObject({
        kind: 'delivered',
        streams: 1,
      });
      expect(hub.publish(diagnosticPublication())).toMatchObject({ kind: 'delivered', streams: 0 });
      await waitFor(() => launcher.frames.join('').split('\n\n').filter(Boolean).length >= 2);
      const envelopes = envelopesOf(launcher);
      expect(envelopes.map((envelope) => envelope.event.type)).toEqual([
        'session-state',
        'registry-changed',
      ]);
    } finally {
      launcher.end();
    }
  });
});

describe('coexistence with the F2 command endpoint', () => {
  it('serves the command endpoint through the mounted composition unchanged', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const body = JSON.stringify({
      protocolVersion: 1,
      requestId: 'req-1',
      command: { kind: 'list-projects' },
    });
    const exchange = await rawExchange(
      listener.port,
      [
        'POST /__astroix/api/v1/ HTTP/1.1',
        `Host: launcher.localhost:${listener.port}`,
        `Cookie: __astroix_host=${fixture.launcherCapability}`,
        `X-Astroix-Client: ${fixture.launcherClient}`,
        'Sec-Fetch-Site: same-origin',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    expect(exchange.status).toBe(200);
    expect(JSON.parse(exchange.body).result.kind).toBe('project-list');
  });

  it('answers a non-GET on the events path as an unknown route, through the pure core', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const postEvents = await rawExchange(
      listener.port,
      rawSseGet(EVENTS_PATH, launcherStreamHeaders(fixture)).replace('GET', 'POST'),
    );
    expect(postEvents.status).toBe(404);
    expect(
      (errorEnvelopeSchema.parse(JSON.parse(postEvents.body)) as { error: { code: string } }).error
        .code,
    ).toBe('resource-not-found');
  });

  it('fails closed before the authority is bound — the deferred-binding window answers the catch-all', async () => {
    const upstream = await startStandInUpstream();
    const events = createEventsApiSurface({
      fallback: createReservedApiSurface().handler,
      hub: createSseHub(),
    });
    const listener = await createOriginListener({ handleReserved: events.handler });
    try {
      const exchange = await rawExchange(
        listener.port,
        rawSseGet(EVENTS_PATH, ['Host', `launcher.localhost:${listener.port}`]),
      );
      expect(exchange.status).toBe(500);
      expect(
        (errorEnvelopeSchema.parse(JSON.parse(exchange.body)) as { error: { code: string } }).error
          .code,
      ).toBe('internal-error');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await listener.close();
      await upstream.close();
    }
  });
});

describe('admission at the wire (spot legs; the full matrix is the pure lane)', () => {
  it('admits a same-origin stream WITHOUT Origin — the real-browser shape (#330)', async () => {
    // `Origin` is a forbidden header on a same-origin GET in real
    // browsers: Chromium's own `EventSource` presents exactly this
    // header set, and the reads law admits it (same-origin Fetch
    // Metadata present, `Origin` absent).
    const { listener, fixture } = socket as SocketFixture;
    const connection = await openSse(
      listener.port,
      rawSseGet(
        `${EVENTS_PATH}${eventsQuery(SESSION)}`,
        withoutHeader(projectStreamHeaders(fixture, 'editor'), 'Origin'),
      ),
    );
    try {
      expect(connection.status).toBe(200);
      expect(connection.headers.toLowerCase()).toContain('content-type: text/event-stream');
    } finally {
      connection.end();
    }
  });

  it('refuses an empty Origin, a wrong capability, and a stale pair with the closed codes', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const legs: Array<[string, string, string[]]> = [
      ['empty origin', EVENTS_PATH, launcherStreamHeaders(fixture, { Origin: true })],
      [
        'wrong capability',
        EVENTS_PATH,
        launcherStreamHeaders(fixture, { Cookie: '__astroix_host=deadbeef' }),
      ],
      [
        'stale pair',
        `${EVENTS_PATH}${eventsQuery(NEXT_SESSION)}`,
        projectStreamHeaders(fixture, 'editor'),
      ],
    ];
    for (const [name, target, headers] of legs) {
      const exchange = await rawExchange(listener.port, rawSseGet(target, headers));
      expect(exchange.status, name).toBeGreaterThanOrEqual(400);
      expect(
        (errorEnvelopeSchema.parse(JSON.parse(exchange.body)) as { error: { code: string } }).error
          .code,
        name,
      ).toBe(name === 'stale pair' ? 'stale-session' : 'unauthorized');
      // the cookie law: no capability byte ever answers
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.launcherCapability);
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.projectCapability);
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.editorClient);
    }
  });

  it('maps the hub stream-cap refusal to 403 at the wire — the cap is enforced on live connections', async () => {
    // A deliberately looser authority than the real binding table: it
    // admits any capability as a diagnostic of the current pair, so the
    // HUB's own cap is the only line of defense — the layer the wire
    // leg exists to prove.
    const upstream = await startStandInUpstream();
    const hub = createSseHub();
    const events = createEventsApiSurface({
      fallback: createReservedApiSurface().handler,
      hub,
    });
    const listener = await createOriginListener({ handleReserved: events.handler });
    const fixture = createSseAuthorityFixture({ expectedPort: listener.port });
    listener.grantProjectLease({
      projectKey: KEY_A,
      upstream: { host: '127.0.0.1', port: upstream.port },
    });
    events.setAuthority({
      ...fixture.authority,
      resolveClientBinding: (presented) =>
        presented === undefined
          ? null
          : { role: 'diagnostic', host: 'project', sessionRef: SESSION },
    });
    const open: SseConnection[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        open.push(await openDiagnosticStream(listener.port, fixture, `client-extra-${index}`));
      }
      const fourth = await rawExchange(
        listener.port,
        rawSseGet(
          `${EVENTS_PATH}${eventsQuery(SESSION)}`,
          projectStreamHeaders(fixture, 'diagnostic', { 'X-Astroix-Client': 'client-extra-3' }),
        ),
      );
      expect(fourth.status).toBe(403);
      expect(
        (errorEnvelopeSchema.parse(JSON.parse(fourth.body)) as { error: { code: string } }).error
          .code,
      ).toBe('unauthorized');
    } finally {
      for (const connection of open) connection.end();
      await listener.close();
      await upstream.close();
    }
  });
});

describe('revocation and the open-stream switch law at the wire', () => {
  it('ends the stream when the session is revoked — the socket close is observed', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const connection = await openEditorStream(listener.port, fixture);
    hub.publish(diagnosticPublication());
    await waitFor(() => connection.frames.join('').includes('\n\n'));
    expect(hub.endForSession(SESSION)).toBe(1);
    await connection.closed;
    // and nothing minted under the revoked pair is ever delivered again
    expect(hub.publish(diagnosticPublication())).toMatchObject({
      kind: 'refused',
      reason: 'stale-publication',
    });
  });

  it('delivers zero old-generation events after a switch — the stale mint is refused, the stream is ended', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const connection = await openEditorStream(listener.port, fixture);
    hub.publish(diagnosticPublication(SESSION));
    await waitFor(() => connection.frames.join('').includes('\n\n'));
    // the switch: the session state moves, the old generation's streams end
    fixture.setState({ sessionRef: NEXT_SESSION, projectKey: KEY_A });
    hub.endForSession(SESSION);
    await connection.closed;
    // a late publication minted under the OLD pair is refused whole
    const stale = hub.publish(diagnosticPublication(SESSION));
    expect(stale).toMatchObject({ kind: 'refused', reason: 'stale-publication' });
    // the wire carries exactly the one pre-switch event — nothing minted after the switch
    const envelopes = envelopesOf(connection);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.session).toEqual(SESSION);
  });

  it('ends the stream when its client binding is revoked', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const connection = await openEditorStream(listener.port, fixture);
    expect(hub.endForBinding('client-editor')).toBe(1);
    await connection.closed;
  });

  it('ends the project streams when the host is revoked — and leaves the launcher stream alone', async () => {
    const { listener, fixture, hub } = socket as SocketFixture;
    const editor = await openEditorStream(listener.port, fixture);
    const launcher = await openLauncherStream(listener.port, fixture);
    try {
      expect(hub.endForHost({ host: 'project', projectKey: KEY_A })).toBe(1);
      await editor.closed;
      const nudge = ssePublication({ event: { type: 'registry-changed' } });
      expect(nudge).not.toBeNull();
      expect(hub.publish(nudge ?? diagnosticPublication())).toMatchObject({
        kind: 'delivered',
        streams: 1,
      });
      await waitFor(() => launcher.frames.join('').includes('\n\n'));
    } finally {
      launcher.end();
    }
  });
});
