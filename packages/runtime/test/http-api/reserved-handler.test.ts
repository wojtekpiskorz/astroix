import { connect } from 'node:net';
import { errorEnvelopeSchema } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReservedApiSurface } from '../../api/http/reserved-handler.ts';
import { createOriginListener, type OriginListener } from '../../origin/origin-listener.ts';
import {
  type RawExchange,
  rawExchange,
  type StandInUpstream,
  startStandInUpstream,
} from '../proxy/stand-ins.ts';
import {
  type AuthorityFixture,
  activateEnvelope,
  applyEditEnvelope,
  createAuthorityFixture,
  inspectEnvelope,
  KEY_A,
  launcherHeaders,
  listProjectsEnvelope,
  NEXT_SESSION,
  projectHeaders,
  projectListResult,
  rawPost,
} from './fixtures.ts';

/**
 * The F2 real-socket focused legs (#234): the reserved handler composed
 * behind F1's REAL origin listener on OS-assigned loopback ports — the
 * same deferred-binding composition every future host mounts (the
 * listener's port exists only after `listening`, and the authority
 * binds to it). The stand-in upstream proves the reserved namespace
 * never proxies; every admission, validation, and error-hygiene law of
 * the pure core is pinned once more at the wire, including the
 * transport-level byte-cap refusals only a socket can exercise.
 */

interface SocketFixture {
  readonly listener: OriginListener;
  readonly fixture: AuthorityFixture;
  readonly upstream: StandInUpstream;
}

let socket: SocketFixture | null = null;

beforeEach(async () => {
  const upstream = await startStandInUpstream();
  const surface = createReservedApiSurface();
  const listener = await createOriginListener({ handleReserved: surface.handler });
  const fixture = createAuthorityFixture({ expectedPort: listener.port });
  fixture.setExecutorResult(projectListResult());
  surface.setAuthority(fixture.authority);
  listener.grantProjectLease({
    projectKey: KEY_A,
    upstream: { host: '127.0.0.1', port: upstream.port },
  });
  socket = { listener, fixture, upstream };
});

afterEach(async () => {
  const current = socket;
  socket = null;
  await current?.listener.close();
  await current?.upstream.close();
});

function errorOf(exchange: { body: string }): { code: string } {
  return (errorEnvelopeSchema.parse(JSON.parse(exchange.body)) as { error: { code: string } })
    .error;
}

/** The upload piece size for the interleaved leg — small enough to yield the loop often. */
const UPLOAD_PIECE_BYTES = 64 * 1024;

/**
 * The chunked-cap leg's client shape (#320): a real client READS its
 * response while the upload is still in flight. The wire bytes are the
 * ones `rawExchange` would send in one giant write — the head, then the
 * chunk payload, then the terminating frames — but paced: the head
 * first, then the payload in bounded pieces with an event-loop yield
 * between them so response data drains concurrently, and the upload
 * stops the moment the complete response is captured. The single-write
 * shape races the reserved surface's deliberate flood-stop (the
 * post-413 destroy fires RST under unread receive data on linux, which
 * can flush the already-queued response bytes before this side ever
 * reads them — the observed ECONNRESET flake); interleaving removes
 * the race by consuming the response as it arrives. The surface always
 * answers with an explicit content-length (`withBody`'s law), so
 * "complete" is head + that many body bytes — deterministic, never
 * close-dependent. Teardown noise after capture (the flood-stop RST
 * landing late) is ignored: the evidence is already in hand. A refusal
 * that never completes fails loudly instead of resolving partial.
 */
function rawInterleavedUpload(
  port: number,
  head: string,
  payload: string,
  timeoutMs = 3000,
): Promise<RawExchange> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.setNoDelay(true);
      void pump();
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(
      () => failOnce(new Error('rawInterleavedUpload: no complete response before the timeout')),
      timeoutMs,
    );
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) return;
      const lengthMatch = /content-length:\s*(\d+)/i.exec(text.slice(0, split));
      if (lengthMatch === null) {
        failOnce(
          new Error('rawInterleavedUpload: response head without an explicit content-length'),
        );
        return;
      }
      const expected = Number.parseInt(lengthMatch[1] ?? '0', 10);
      if (bytes.length - split - 4 >= expected) settle();
    });
    socket.on('error', (error) => {
      if (settled) return; // post-capture teardown — the exchange is already evidence
      failOnce(error);
    });
    socket.on('close', () => {
      if (settled) return;
      failOnce(new Error('rawInterleavedUpload: connection closed before the response completed'));
    });

    function settle(): void {
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const bytes = Buffer.concat(chunks);
      const text = bytes.toString('latin1');
      const split = text.indexOf('\r\n\r\n');
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text);
      resolve({
        status: statusMatch === null ? 0 : Number.parseInt(statusMatch[1] ?? '0', 10),
        headers: split === -1 ? text : text.slice(0, split),
        body: split === -1 ? '' : text.slice(split + 4),
        bytes,
      });
    }
    function failOnce(error: Error): void {
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    }
    async function pump(): Promise<void> {
      socket.write(head);
      for (let offset = 0; offset < payload.length && !settled; offset += UPLOAD_PIECE_BYTES) {
        const piece = payload.slice(offset, offset + UPLOAD_PIECE_BYTES);
        // Backpressure made explicit: a slow server must never let the
        // whole remaining payload buffer in Node's writable queue — the
        // pacing guarantee is awaited, not incidental.
        if (!socket.write(piece)) {
          await new Promise<void>((resolve) => socket.once('drain', resolve));
        }
        // The yield is the heart of the fix: the event loop drains the
        // read side between upload pieces, not after the whole payload.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (!settled && !socket.destroyed) socket.write('\r\n0\r\n\r\n');
    }
  });
}

describe('admitted wire traffic', () => {
  it('serves a launcher read end to end: 200, no-store, generated marker, JSON envelope — and the upstream never sees it', async () => {
    const { listener, fixture, upstream } = socket as SocketFixture;
    const exchange = await rawExchange(
      listener.port,
      rawPost('/__astroix/api/v1/', launcherHeaders(fixture), listProjectsEnvelope()),
    );
    expect(exchange.status).toBe(200);
    expect(exchange.headers.toLowerCase()).toContain('cache-control: no-store');
    expect(exchange.headers.toLowerCase()).toContain('content-type: application/json');
    expect(exchange.headers.toLowerCase()).toContain('x-astroix-generated: 1');
    expect(exchange.headers.toLowerCase()).not.toContain('access-control');
    expect(JSON.parse(exchange.body).result.kind).toBe('project-list');
    expect(fixture.executed.map((sent) => sent.command.kind)).toEqual(['list-projects']);
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves a project-host session-scoped mutation end to end', async () => {
    const { listener, fixture, upstream } = socket as SocketFixture;
    const exchange = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1',
        projectHeaders(fixture, 'editor', {}, 'mutation'),
        applyEditEnvelope(),
      ),
    );
    expect(exchange.status).toBe(200);
    expect(fixture.executed[0]?.command.kind).toBe('apply-edit');
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves a launcher mutation (activate) end to end', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const exchange = await rawExchange(
      listener.port,
      rawPost('/__astroix/api/v1/', launcherHeaders(fixture, {}, 'mutation'), activateEnvelope()),
    );
    expect(exchange.status).toBe(200);
    expect(fixture.executed[0]?.command.kind).toBe('activate');
  });
});

describe('reserved routing at the wire', () => {
  it('answers unknown reserved routes and the not-yet-composed events path as resource-not-found', async () => {
    const { listener, fixture, upstream } = socket as SocketFixture;
    for (const target of [
      '/__astroix/api/v1/none',
      '/__astroix/events',
      '/__astroix/api/v2/thing',
    ]) {
      const exchange = await rawExchange(
        listener.port,
        rawPost(target, launcherHeaders(fixture), listProjectsEnvelope()),
      );
      expect(exchange.status, target).toBe(404);
      expect(errorOf(exchange).code, target).toBe('resource-not-found');
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers non-POST methods on the command endpoint as an unknown route', async () => {
    const { listener, fixture } = socket as SocketFixture;
    for (const method of ['GET', 'OPTIONS', 'DELETE']) {
      const exchange = await rawExchange(
        listener.port,
        rawPost('/__astroix/api/v1/', launcherHeaders(fixture), '', method),
      );
      expect(exchange.status, method).toBe(404);
    }
  });
});

describe('admission refusals at the wire', () => {
  it('fails closed before the authority is bound — the deferred-binding window answers the catch-all', async () => {
    const upstream = await startStandInUpstream();
    const surface = createReservedApiSurface();
    const listener = await createOriginListener({ handleReserved: surface.handler });
    try {
      const exchange = await rawExchange(
        listener.port,
        rawPost(
          '/__astroix/api/v1/',
          ['Host', `launcher.localhost:${listener.port}`, 'Cookie', 'x=1'],
          '{}',
        ),
      );
      expect(exchange.status).toBe(500);
      expect(errorOf(exchange).code).toBe('internal-error');
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await listener.close();
      await upstream.close();
    }
  });

  it('refuses a missing capability, a missing Fetch Metadata, and a wrong Origin with 403', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const noCookie = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1/',
        launcherHeaders(fixture, { Cookie: true }),
        listProjectsEnvelope(),
      ),
    );
    expect(noCookie.status).toBe(403);
    expect(errorOf(noCookie).code).toBe('unauthorized');
    const noFetchMetadata = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1/',
        launcherHeaders(fixture, { 'Sec-Fetch-Site': true }),
        listProjectsEnvelope(),
      ),
    );
    expect(noFetchMetadata.status).toBe(403);
    const wrongOrigin = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1/',
        launcherHeaders(fixture, { Origin: 'http://evil.example' }, 'mutation'),
        activateEnvelope(),
      ),
    );
    expect(wrongOrigin.status).toBe(403);
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses a stale SessionRef with 409 and echoes the pair', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const exchange = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1/',
        projectHeaders(fixture, 'editor'),
        inspectEnvelope(NEXT_SESSION),
      ),
    );
    expect(exchange.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(JSON.parse(exchange.body));
    expect(envelope.error.code).toBe('stale-session');
    expect(envelope.session).toEqual(NEXT_SESSION);
  });

  it('answers malformed JSON and unknown fields with the closed 400s', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const malformed = await rawExchange(
      listener.port,
      rawPost('/__astroix/api/v1/', launcherHeaders(fixture), '{not json'),
    );
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed).code).toBe('malformed-request');
    const unknownField = await rawExchange(
      listener.port,
      rawPost('/__astroix/api/v1/', launcherHeaders(fixture), listProjectsEnvelope({ rogue: 1 })),
    );
    expect(unknownField.status).toBe(400);
    expect(JSON.parse(unknownField.body).error.details).toEqual({
      issue: 'unknown-field',
      pointer: 'rogue',
    });
  });

  it('refuses duplicate security-relevant headers at the wire', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const base = launcherHeaders(fixture);
    const duplicated = await rawExchange(
      listener.port,
      rawPost(
        '/__astroix/api/v1/',
        [...base, 'Origin', 'http://a', 'Origin', 'http://b'],
        listProjectsEnvelope(),
      ),
    );
    expect(duplicated.status).toBe(400);
    expect(errorOf(duplicated).code).toBe('malformed-request');
  });

  it('never leaks a thrown executor error — 500 with the closed message only', async () => {
    const { listener, fixture } = socket as SocketFixture;
    fixture.failExecutor(new Error('EACCES /Users/secret/astro.config.mjs'));
    const exchange = await rawExchange(
      listener.port,
      rawPost('/__astroix/api/v1/', launcherHeaders(fixture), listProjectsEnvelope()),
    );
    expect(exchange.status).toBe(500);
    expect(errorOf(exchange).code).toBe('internal-error');
    expect(exchange.body).not.toContain('EACCES');
    expect(exchange.body).not.toContain('astro.config');
  });
});

describe('transport-level byte caps at the wire (the pre-parse bound)', () => {
  it('refuses a declared Content-Length over the transport cap unread — 413 with the declared count', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const oversized = 8 * 1024 * 1024 + 1024;
    const head = [
      'POST /__astroix/api/v1/ HTTP/1.1',
      `Host: launcher.localhost:${fixture.port}`,
      `Cookie: __astroix_host=${fixture.launcherCapability}`,
      `X-Astroix-Client: ${fixture.launcherClient}`,
      'Sec-Fetch-Site: same-origin',
      'Content-Type: application/json',
      `Content-Length: ${oversized}`,
      'Connection: close',
      '',
      '{ tiny',
    ].join('\r\n');
    const exchange = await rawExchange(listener.port, head);
    expect(exchange.status).toBe(413);
    expect(JSON.parse(exchange.body).error.details).toEqual({
      limit: 'editRequestBytes',
      receivedBytes: oversized,
    });
    expect(fixture.executed).toHaveLength(0);
  });

  it('refuses a chunked body the moment it crosses the cap — 413 with the observed count', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const payload = 'x'.repeat(8 * 1024 * 1024 + 4096);
    const head = [
      'POST /__astroix/api/v1/ HTTP/1.1',
      `Host: launcher.localhost:${fixture.port}`,
      `Cookie: __astroix_host=${fixture.launcherCapability}`,
      `X-Astroix-Client: ${fixture.launcherClient}`,
      'Sec-Fetch-Site: same-origin',
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      `${payload.length.toString(16)}\r\n`,
    ].join('\r\n');
    // Read interleaved with the upload (#320): the single giant write let
    // the flood-stop RST flush the queued 413 before it was ever read.
    const exchange = await rawInterleavedUpload(listener.port, head, payload);
    expect(exchange.status).toBe(413);
    const details = JSON.parse(exchange.body).error.details as {
      limit: string;
      receivedBytes: number;
    };
    expect(details.limit).toBe('editRequestBytes');
    expect(details.receivedBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(fixture.executed).toHaveLength(0);
  });
});

describe('the cookie law at the wire', () => {
  it('never answers with the capability: no response byte carries the secret', async () => {
    const { listener, fixture } = socket as SocketFixture;
    const legs: Array<[string, string, string[]]> = [
      ['stale session', inspectEnvelope(NEXT_SESSION), projectHeaders(fixture, 'editor')],
      [
        'missing binding',
        listProjectsEnvelope(),
        launcherHeaders(fixture, { 'X-Astroix-Client': true }),
      ],
      [
        'unauthorized role',
        applyEditEnvelope(),
        projectHeaders(fixture, 'diagnostic', {}, 'mutation'),
      ],
    ];
    for (const [name, body, headers] of legs) {
      const exchange = await rawExchange(
        listener.port,
        rawPost('/__astroix/api/v1/', headers, body),
      );
      expect(exchange.status, name).toBeGreaterThanOrEqual(400);
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.launcherCapability);
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.projectCapability);
      expect(exchange.bytes.toString('latin1'), name).not.toContain(fixture.editorClient);
    }
  });
});
