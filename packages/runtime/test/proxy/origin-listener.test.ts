import { listenerCount } from 'node:events';
import { Agent, request as httpRequest } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASTROIX_GENERATED_HEADER,
  createOriginListener,
  InvalidProjectKeyError,
  NonLoopbackUpstreamError,
  OriginLeaseOccupiedError,
  type OriginListener,
} from '../../origin/origin-listener.ts';
import {
  KEY_A,
  KEY_B,
  rawExchange,
  rawGet,
  type StandInUpstream,
  startStandInUpstream,
  waitFor,
} from './stand-ins.ts';

/**
 * The F1 focused real-socket legs (#233): the six Host-rejection
 * classes end-to-end (malformed, duplicate, trailing-dot, stale,
 * unknown, rebinding — ADR-0007's mandatory negative matrix), the
 * natural-route pass-through with direct-DOM loading, the reserved
 * namespace never proxied, lease grant occupancy, revocation ordering
 * (tracked HTTP and upgrade sockets die BEFORE the children), and the
 * A-to-B-to-A retired-host shape. Every leg runs against real loopback
 * sockets on OS-assigned ports; the "managed dev server" is a real
 * stand-in HTTP server, never a mock.
 */

interface Fixture {
  readonly listener: OriginListener;
  readonly lease: ReturnType<OriginListener['grantProjectLease']>;
  readonly upstream: StandInUpstream;
}

let fixture: Fixture | null = null;

beforeEach(async () => {
  const upstream = await startStandInUpstream([
    {
      path: '/',
      status: 200,
      body: '<!doctype html><html><body><main id="natural-root">fixture page</main></body></html>',
      contentType: 'text/html; charset=utf-8',
    },
    {
      path: '/docs/some/page',
      status: 200,
      body: '<!doctype html><html><body><article id="docs">base route body</article></body></html>',
      contentType: 'text/html; charset=utf-8',
    },
    {
      path: '/hanging',
      status: 200,
      body: 'held open',
      contentType: 'text/plain',
      hanging: true,
    },
  ]);
  const listener = await createOriginListener();
  const lease = listener.grantProjectLease({
    projectKey: KEY_A,
    upstream: { host: '127.0.0.1', port: upstream.port },
  });
  fixture = { listener, lease, upstream };
});

afterEach(async () => {
  const current = fixture;
  fixture = null;
  await current?.listener.close();
  await current?.upstream.close();
});

describe('listener ownership and published origins', () => {
  it('binds loopback before the origin exists — the published origins carry the acquired port', async () => {
    const { listener, lease } = fixture as Fixture;
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.launcherOrigin).toBe(`http://launcher.localhost:${listener.port}`);
    expect(lease.origin).toBe(`http://${KEY_A}.localhost:${listener.port}`);
    expect(lease.hostname).toBe(`${KEY_A}.localhost`);
    expect(listener.activeLease?.projectKey).toBe(KEY_A);
  });

  it('stops answering once closed — close is terminal for the listener', async () => {
    const listener = await createOriginListener();
    const port = listener.port;
    await listener.close();
    await listener.close(); // idempotent
    await expect(rawExchange(port, rawGet('/', 'launcher.localhost'))).rejects.toThrow();
  });
});

describe('Host rejection (ADR-0007 mandatory negatives, end-to-end)', () => {
  it('rejects a malformed Host value', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', 'a..localhost'));
    expect(exchange.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a missing Host header', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(
      listener.port,
      'GET / HTTP/1.1\r\nConnection: close\r\n\r\n',
    );
    expect(exchange.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects duplicate Host headers', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(
      listener.port,
      `GET / HTTP/1.1\r\nHost: ${KEY_A}.localhost\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    );
    expect(exchange.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects the trailing-dot hostname as a distinct name', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', `${KEY_A}.localhost.`));
    expect(exchange.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown .localhost name with 404 and without upstream contact', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', 'nobody.localhost'));
    expect(exchange.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a rebinding foreign domain that resolved to loopback', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', 'rebind.attacker.example'));
    expect(exchange.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects a Host port that is not the listener port', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', `${KEY_A}.localhost:9999`));
    expect(exchange.status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('rejects absolute-form targets, CONNECT, and ambiguous reserved encodings', async () => {
    const { listener, upstream } = fixture as Fixture;
    const host = `${KEY_A}.localhost:${listener.port}`;
    const absolute = await rawExchange(
      listener.port,
      `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );
    expect(absolute.status).toBe(400);
    const connect = await rawExchange(
      listener.port,
      `CONNECT ${host}:80 HTTP/1.1\r\nHost: ${host}\r\n\r\n`,
    );
    expect(connect.status).toBe(405);
    expect((await rawExchange(listener.port, rawGet('/__astroix%2Fapp', host))).status).toBe(400);
    expect((await rawExchange(listener.port, rawGet('/%5f%5fastroix/app', host))).status).toBe(400);
    // backslash boundaries: WHATWG routers normalize \ to /, so these
    // are reserved-namespace claims in the normalizing view — refused,
    // never forwarded
    expect((await rawExchange(listener.port, rawGet('/__astroix\\app', host))).status).toBe(400);
    expect((await rawExchange(listener.port, rawGet('/__astroix%5Capp', host))).status).toBe(400);
    expect(upstream.requests).toHaveLength(0);
  });

  it('answers 421 for a stale (revoked) host — before and after a successor lease', async () => {
    const { listener, lease, upstream } = fixture as Fixture;
    await lease.revoke();
    const stale = await rawExchange(listener.port, rawGet('/', `${KEY_A}.localhost`));
    expect(stale.status).toBe(421);
    listener.grantProjectLease({
      projectKey: KEY_B,
      upstream: { host: '127.0.0.1', port: upstream.port },
    });
    const stillStale = await rawExchange(listener.port, rawGet('/', `${KEY_A}.localhost`));
    expect(stillStale.status).toBe(421);
    expect(upstream.requests).toHaveLength(0);
  });

  it('routes uppercase Host variants (HTTP host case-insensitivity)', async () => {
    const { listener, upstream } = fixture as Fixture;
    const exchange = await rawExchange(
      listener.port,
      rawGet('/', `${KEY_A.toUpperCase()}.localhost`),
    );
    expect(exchange.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });
});

describe('reserved namespace and launcher host', () => {
  it('never proxies /__astroix/ paths on the project host — unrouted reserved paths 404', async () => {
    const { listener, upstream } = fixture as Fixture;
    for (const target of [
      '/__astroix',
      '/__astroix/',
      '/__astroix/app/',
      '/__astroix/api/v1/none',
    ]) {
      const exchange = await rawExchange(listener.port, rawGet(target, KEY_A));
      expect(exchange.status, target).toBe(404);
      expect(exchange.headers.toLowerCase()).toContain(ASTROIX_GENERATED_HEADER);
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves the launcher host only through the reserved handler; natural launcher targets 404', async () => {
    const reserved: string[] = [];
    const listener = await createOriginListener({
      handleReserved: (_request, response) => {
        reserved.push('hit');
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '16' });
        response.end('reserved surface');
      },
    });
    try {
      const reservedExchange = await rawExchange(
        listener.port,
        rawGet('/__astroix/app/', 'launcher.localhost'),
      );
      expect(reservedExchange.status).toBe(200);
      expect(reservedExchange.body).toBe('reserved surface');
      expect(reserved).toHaveLength(1);
      const natural = await rawExchange(listener.port, rawGet('/', 'launcher.localhost'));
      expect(natural.status).toBe(404);
    } finally {
      await listener.close();
    }
  });
});

describe('natural-route proxying (canvas fidelity)', () => {
  it('streams the natural route verbatim: path, resolved base, and query unmodified, Host preserved', async () => {
    const { listener, lease, upstream } = fixture as Fixture;
    const target = '/docs/some/page?token=vite-token&x=1';
    const exchange = await rawExchange(listener.port, rawGet(target, lease.hostname));
    expect(exchange.status).toBe(200);
    expect(exchange.body).toContain('base route body');
    expect(exchange.headers.toLowerCase()).not.toContain(ASTROIX_GENERATED_HEADER);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET',
      url: target,
      host: lease.hostname,
    });
  });

  it('serves byte-identical responses to the upstream direct response', async () => {
    const { listener, lease, upstream } = fixture as Fixture;
    const direct = await rawExchange(upstream.port, rawGet('/', '127.0.0.1'));
    const proxied = await rawExchange(listener.port, rawGet('/', lease.hostname));
    expect(proxied.status).toBe(direct.status);
    expect(proxied.body).toBe(direct.body);
    expect(headerOf(proxied.headers, 'content-type')).toBe(
      headerOf(direct.headers, 'content-type'),
    );
  });

  it('loads the proxied document as direct DOM (the same-origin canvas contract, serverless stand-in)', async () => {
    const { listener, lease } = fixture as Fixture;
    const exchange = await rawExchange(listener.port, rawGet('/', lease.hostname));
    const document = globalThis.document;
    document.body.innerHTML = exchange.body;
    const root = document.querySelector('#natural-root');
    expect(root?.textContent).toBe('fixture page');
    document.body.innerHTML = '';
  });

  it('answers 502 when the upstream is unreachable, without exposing the upstream address', async () => {
    // The listener binds FIRST: the dead upstream's freed ephemeral port
    // can then never be the listener's own (a self-looping upstream).
    const listener = await createOriginListener();
    const deadUpstream = await startStandInUpstream();
    const port = deadUpstream.port;
    await deadUpstream.close();
    listener.grantProjectLease({ projectKey: KEY_A, upstream: { host: '127.0.0.1', port } });
    try {
      const exchange = await rawExchange(listener.port, rawGet('/', `${KEY_A}.localhost`));
      expect(exchange.status).toBe(502);
      expect(exchange.body).toBe('');
      expect(`${exchange.headers}\n${exchange.body}`).not.toContain(String(port));
    } finally {
      await listener.close();
    }
  });
});

describe('upstream loopback posture (the rebinding posture enforced at the seam)', () => {
  it('refuses any non-loopback upstream before routing state changes', async () => {
    const { upstream } = fixture as Fixture;
    const listener = await createOriginListener();
    try {
      for (const host of [
        '0.0.0.0',
        'localhost',
        'example.com',
        '10.0.0.1',
        '[::1]',
        '127.0.0.2',
      ]) {
        expect(() =>
          listener.grantProjectLease({
            projectKey: KEY_B,
            upstream: { host, port: upstream.port },
          }),
        ).toThrow(NonLoopbackUpstreamError);
      }
      // the refusal preceded routing: the lease is still grantable
      listener.grantProjectLease({
        projectKey: KEY_B,
        upstream: { host: '::1', port: upstream.port },
      });
      expect(listener.activeLease?.projectKey).toBe(KEY_B);
    } finally {
      await listener.close();
    }
  });
});

describe('lease grant occupancy', () => {
  it('refuses a second grant while a lease is active, then admits after revocation', async () => {
    const { listener, lease, upstream } = fixture as Fixture;
    expect(() =>
      listener.grantProjectLease({
        projectKey: KEY_B,
        upstream: { host: '127.0.0.1', port: upstream.port },
      }),
    ).toThrow(OriginLeaseOccupiedError);
    expect(() =>
      listener.grantProjectLease({
        projectKey: '0abcdefghijklmnopqrstuvw',
        upstream: { host: '127.0.0.1', port: upstream.port },
      }),
    ).toThrow(InvalidProjectKeyError);
    await lease.revoke();
    const next = listener.grantProjectLease({
      projectKey: KEY_B,
      upstream: { host: '127.0.0.1', port: upstream.port },
    });
    expect(listener.activeLease?.projectKey).toBe(KEY_B);
    expect(next.revoked).toBe(false);
  });
});

describe('revocation: tracked sockets die before child termination', () => {
  it('destroys tracked in-flight HTTP sockets before the revocation resolves', async () => {
    const { listener, lease, upstream } = fixture as Fixture;
    const order: string[] = [];
    // One in-flight proxied exchange over the hanging route — the only
    // thing that can end it is revocation.
    const inFlight = httpRequest(
      {
        host: '127.0.0.1',
        port: listener.port,
        method: 'GET',
        path: '/hanging',
        headers: { host: lease.hostname },
      },
      () => {
        order.push('responseArrived');
      },
    );
    inFlight.on('close', () => order.push('clientSocketClosed'));
    inFlight.on('error', () => order.push('clientSocketClosed'));
    inFlight.end();
    await waitFor(() => upstream.requests.some((request) => request.url.startsWith('/hanging')));
    const revocation = await lease.revoke();
    order.push('revocationResolved');
    expect(lease.revoked).toBe(true);
    expect(revocation).toMatchObject({ projectKey: KEY_A, outcome: 'complete' });
    expect(revocation.destroyedSockets).toBeGreaterThanOrEqual(2); // client and upstream legs
    expect(order.indexOf('clientSocketClosed')).toBeLessThan(order.indexOf('revocationResolved'));
    // The retired host answers 421 from the instant revoke() flipped it,
    // and the revocation report is idempotent — the same instance.
    expect((await rawExchange(listener.port, rawGet('/', lease.hostname))).status).toBe(421);
    await expect(lease.revoke()).resolves.toBe(revocation);
  });

  it('revokes tracked raw-upgrade sockets before child termination (the pre-reap order)', async () => {
    const order: string[] = [];
    const hmrStandIn = await startRawUpgradeStandIn();
    const listener = await createOriginListener();
    const lease = listener.grantProjectLease({
      projectKey: KEY_B,
      upstream: { host: '127.0.0.1', port: hmrStandIn.port },
    });
    try {
      const client = connect({ host: '127.0.0.1', port: listener.port });
      const clientClosed = onceClosed(client);
      client.on('error', () => {});
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.resume(); // a socket nobody reads never observes the peer's close
      client.write(hmrOpening(lease.hostname, listener.port));
      await waitFor(() => hmrStandIn.handshakes > 0);
      const revocation = await lease.revoke();
      order.push('revocationResolved');
      expect(revocation.outcome).toBe('complete');
      expect(revocation.destroyedSockets).toBeGreaterThanOrEqual(2);
      await clientClosed; // the tunnel's client socket died before revocation resolved
      expect(order).toEqual(['revocationResolved']);
      client.destroy();
    } finally {
      await listener.close();
      await hmrStandIn.close();
    }
  });
});

describe('launcher-owned reserved sockets (ownership-tagged revocation)', () => {
  it('survive a project-lease revoke untouched and die with the listener', async () => {
    let push: (chunk: string) => void = () => {};
    let reservedSocket: Socket | undefined;
    const listener = await createOriginListener({
      handleReserved: (_request, response, track) => {
        const socket = response.socket;
        if (socket !== null && socket !== undefined) {
          track(socket);
          reservedSocket = socket;
        }
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('held-open');
        push = (chunk) => response.write(chunk);
      },
    });
    const upstream = await startStandInUpstream([
      { path: '/hanging', status: 200, body: 'held', contentType: 'text/plain', hanging: true },
    ]);
    try {
      // One held-open launcher-side reserved connection.
      const reservedClient = connect({ host: '127.0.0.1', port: listener.port });
      reservedClient.on('error', () => {});
      const reservedChunks: Buffer[] = [];
      reservedClient.on('data', (chunk: Buffer) => reservedChunks.push(chunk));
      await new Promise<void>((resolve) => reservedClient.once('connect', resolve));
      reservedClient.write(
        'GET /__astroix/app/ HTTP/1.1\r\nHost: launcher.localhost\r\nConnection: keep-alive\r\n\r\n',
      );
      await waitFor(() => reservedChunks.length > 0);

      // One in-flight proxied exchange on a project lease.
      const lease = listener.grantProjectLease({
        projectKey: KEY_A,
        upstream: { host: '127.0.0.1', port: upstream.port },
      });
      const proxied = httpRequest(
        {
          host: '127.0.0.1',
          port: listener.port,
          method: 'GET',
          path: '/hanging',
          headers: { host: lease.hostname },
        },
        () => {},
      );
      proxied.on('error', () => {});
      proxied.end();
      await waitFor(() => upstream.requests.length > 0);

      // The revoke destroys ONLY the lease's legs; the launcher-owned
      // reserved connection keeps flowing across it.
      const revocation = await lease.revoke();
      expect(revocation.destroyedSockets).toBeGreaterThanOrEqual(2);
      expect(reservedSocket?.destroyed).toBe(false);
      push('still-alive');
      await waitFor(() => Buffer.concat(reservedChunks).toString('latin1').includes('still-alive'));

      // Listener close is terminal for BOTH owners.
      await listener.close();
      await new Promise<void>((resolve) => {
        if (reservedSocket?.destroyed === true) {
          resolve();
          return;
        }
        reservedSocket?.once('close', resolve);
      });
      expect(reservedSocket?.destroyed).toBe(true);
      reservedClient.destroy();
    } finally {
      await listener.close();
      await upstream.close();
    }
  });
});

describe('A-to-B-to-A retired host', () => {
  it('retires A, routes B, re-leases A fresh — the old lease never resurrects', async () => {
    const upstreamA = await startStandInUpstream([
      { path: '/', status: 200, body: 'upstream A generation 1', contentType: 'text/plain' },
    ]);
    const upstreamA2 = await startStandInUpstream([
      { path: '/', status: 200, body: 'upstream A generation 2', contentType: 'text/plain' },
    ]);
    const upstreamB = await startStandInUpstream([
      { path: '/', status: 200, body: 'upstream B', contentType: 'text/plain' },
    ]);
    const listener = await createOriginListener();
    try {
      const first = listener.grantProjectLease({
        projectKey: KEY_A,
        upstream: { host: '127.0.0.1', port: upstreamA.port },
      });
      expect((await rawExchange(listener.port, rawGet('/', first.hostname))).body).toContain(
        'upstream A generation 1',
      );
      const firstRevocation = await first.revoke();

      const second = listener.grantProjectLease({
        projectKey: KEY_B,
        upstream: { host: '127.0.0.1', port: upstreamB.port },
      });
      // A is retired while B is active — an old tab's host answers 421.
      expect((await rawExchange(listener.port, rawGet('/', first.hostname))).status).toBe(421);
      expect((await rawExchange(listener.port, rawGet('/', second.hostname))).body).toContain(
        'upstream B',
      );

      await second.revoke();
      // A-to-B-to-A: the same key re-leased serves a FRESH route (new
      // upstream, new lease object); the first lease stays revoked and
      // its revocation stays idempotent.
      const third = listener.grantProjectLease({
        projectKey: KEY_A,
        upstream: { host: '127.0.0.1', port: upstreamA2.port },
      });
      expect((await rawExchange(listener.port, rawGet('/', third.hostname))).body).toContain(
        'upstream A generation 2',
      );
      expect(first.revoked).toBe(true);
      await expect(first.revoke()).resolves.toBe(firstRevocation);
      expect(third.revoked).toBe(false);
      expect(upstreamA.requests).toHaveLength(1);
    } finally {
      await listener.close();
      await Promise.all([upstreamA.close(), upstreamA2.close(), upstreamB.close()]);
    }
  });
});

describe('tracked-socket bookkeeping under refetch churn (#382)', () => {
  it('holds ONE close listener per tracked socket across N composed operations over one keep-alive connection', async () => {
    // The churn shape of the finding: a keep-alive client socket serves
    // one composed operation per request (reserved registrations AND
    // proxied exchanges), and every one of them re-tracks the SAME
    // socket. A per-track close listener accumulated there until Node's
    // MaxListenersExceededWarning; the count must stay flat.
    const upstream = await startStandInUpstream([
      { path: '/', status: 200, body: 'canvas body', contentType: 'text/plain' },
    ]);
    let churnSocket: Socket | undefined;
    const listener = await createOriginListener({
      // The reserved surface is the probe's window onto the SERVER side
      // of the churn connection — the very object the bookkeeping
      // attaches to (the same `request.socket` the proxy leg tracks).
      // It registers the socket per request exactly like the real
      // reserved surface does (reserved-handler.ts / sse-surface.ts).
      handleReserved: (request, response, track) => {
        churnSocket = request.socket;
        track(request.socket);
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '3' });
        response.end('ack');
      },
    });
    listener.grantProjectLease({
      projectKey: KEY_A,
      upstream: { host: '127.0.0.1', port: upstream.port },
    });
    // One pooled connection, sequential exchanges — the browser's
    // generation-scoped refetch shape (never Connection: close).
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const leaked: string[] = [];
    const onWarning = (warning: Error): void => {
      if (warning.name === 'MaxListenersExceededWarning') leaked.push(warning.message);
    };
    process.on('warning', onWarning);
    try {
      const exchange = (path: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port: listener.port,
              agent,
              path,
              headers: { host: `${KEY_A}.localhost:${listener.port}` },
            },
            (response) => {
              response.resume();
              response.once('end', () => resolve());
            },
          );
          request.on('error', reject);
          request.end();
        });
      // Baseline after the first composed pair (one reserved, one proxied).
      await exchange('/__astroix/churn-probe');
      await exchange('/');
      const baseline = listenerCount(churnSocket as Socket, 'close');
      expect(baseline).toBeGreaterThan(0); // the one tracking listener is really attached
      // The churn: 24 more composed pairs — far past Node's default
      // 10-listener trip wire, which the pre-fix accumulation crossed.
      for (let i = 0; i < 24; i += 1) {
        await exchange('/__astroix/churn-probe');
        await exchange('/');
      }
      expect(upstream.requests).toHaveLength(25); // every proxied leg really ran
      expect(listenerCount(churnSocket as Socket, 'close')).toBe(baseline);
      // The warning is emitted on a nextTick — drain the queue before
      // judging its absence.
      await new Promise((resolve) => setImmediate(resolve));
      expect(leaked).toEqual([]);
    } finally {
      process.off('warning', onWarning);
      agent.destroy();
      await listener.close();
      await upstream.close();
    }
  });
});

describe('output hygiene', () => {
  it('every listener-synthesized response and revocation report is free of disclosure shapes', async () => {
    const { listener, lease } = fixture as Fixture;
    const artifacts: string[] = [];
    for (const host of ['nobody.localhost', `${KEY_A}.localhost.`, `${KEY_A}.localhost:9`]) {
      artifacts.push(JSON.stringify(await rawExchange(listener.port, rawGet('/', host))));
    }
    await lease.revoke();
    artifacts.push(JSON.stringify(await rawExchange(listener.port, rawGet('/', lease.hostname))));
    artifacts.push(JSON.stringify(await lease.revoke()));
    for (const artifact of artifacts) {
      expect(findDisclosure(artifact)).toBeNull();
    }
  });
});

/** Extracts one header value from a raw CRLF header block. */
function headerOf(headers: string, name: string): string | undefined {
  const line = headers
    .split('\r\n')
    .find((candidate) => candidate.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(line.indexOf(':') + 1).trim();
}

function onceClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
  });
}

/** One raw opening handshake the tunnel legs send (the browser Vite client's shape). */
function hmrOpening(hostname: string, port: number): string {
  return [
    'GET /?token=vite-hmr-token HTTP/1.1',
    `Host: ${hostname}:${port}`,
    `Origin: http://${hostname}:${port}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Protocol: vite-hmr',
    '',
    '',
  ].join('\r\n');
}

/** A raw TCP stand-in that answers real 101 handshakes with its own bytes. */
async function startRawUpgradeStandIn(): Promise<{
  readonly port: number;
  readonly handshakes: number;
  close(): Promise<void>;
}> {
  let handshakes = 0;
  const sockets: Socket[] = [];
  const server = createNetServer((socket) => {
    sockets.push(socket);
    let seen = '';
    socket.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1');
      if (!seen.includes('\r\n\r\n')) return;
      handshakes += 1;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n',
      );
      seen = '';
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('raw stand-in did not bind');
  return {
    port: address.port,
    get handshakes(): number {
      return handshakes;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
