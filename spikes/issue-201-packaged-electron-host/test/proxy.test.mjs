import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import test from 'node:test';

import { startLoopbackProxy } from '../src/proxy.mjs';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function reservePort() {
  const reservation = createTcpServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

function nextData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
}

function socketClosed(socket) {
  if (socket.destroyed || socket.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('socket did not close after revocation')),
      1_000,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.once('close', done);
    socket.once('end', done);
  });
}

test('routes app and natural project paths without replacing the virtual Host', async () => {
  const observed = [];
  const app = createHttpServer((request, response) => {
    observed.push({ target: 'app', host: request.headers.host, url: request.url });
    response.end('app');
  });
  const astro = createHttpServer((request, response) => {
    observed.push({ target: 'astro', host: request.headers.host, url: request.url });
    response.end('astro');
  });
  const [appPort, astroPort, proxyPort] = await Promise.all([
    listen(app),
    listen(astro),
    reservePort(),
  ]);
  const proxy = await startLoopbackProxy({
    port: proxyPort,
    runtimeForHost: (key) => (key === 'alpha' ? { appPort, upstreamPort: astroPort } : undefined),
  });
  try {
    assert.equal(
      await fetch(`http://alpha.localhost:${proxyPort}/__astroix/app/`).then((response) =>
        response.text(),
      ),
      'app',
    );
    assert.equal(
      await fetch(`http://alpha.localhost:${proxyPort}/lab/home/`).then((response) =>
        response.text(),
      ),
      'astro',
    );
    assert.deepEqual(observed, [
      {
        target: 'app',
        host: `alpha.localhost:${proxyPort}`,
        url: '/__astroix/app/',
      },
      { target: 'astro', host: `alpha.localhost:${proxyPort}`, url: '/lab/home/' },
    ]);
  } finally {
    await proxy.close();
    await Promise.all([close(app), close(astro)]);
  }
});

test('tunnels the Vite upgrade request and upstream 101 response as raw bytes', async () => {
  let upstreamRequest;
  const upstream = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      upstreamRequest = chunk.toString('latin1');
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await reservePort();
  let observation;
  const proxy = await startLoopbackProxy({
    port: proxyPort,
    runtimeForHost: (key) =>
      key === 'alpha' ? { appPort: upstreamPort, upstreamPort } : undefined,
    onUpgrade: (next) => (observation = next),
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = connect(proxyPort, '127.0.0.1');
      let bytes = '';
      socket.once('connect', () => {
        socket.write(
          `GET /@vite/client?token=proof-token HTTP/1.1\r\nHost: alpha.localhost:${proxyPort}\r\nOrigin: http://alpha.localhost:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: cHJvb2YtcHJvb2YtcHJvb2Y=\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
        );
      });
      socket.on('data', (chunk) => (bytes += chunk.toString('latin1')));
      socket.once('end', () => resolve(bytes));
      socket.once('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(upstreamRequest, /^GET \/@vite\/client\?token=proof-token HTTP\/1\.1/);
    assert.match(upstreamRequest, new RegExp(`Host: alpha\\.localhost:${proxyPort}`));
    assert.match(upstreamRequest, new RegExp(`Origin: http://alpha\\.localhost:${proxyPort}`));
    assert.match(upstreamRequest, /Sec-WebSocket-Protocol: vite-hmr/);
    assert.deepEqual(
      {
        host: observation.host,
        origin: observation.origin,
        protocol: observation.protocol,
        status: observation.upstreamStatusLine,
        url: observation.url,
      },
      {
        host: `alpha.localhost:${proxyPort}`,
        origin: `http://alpha.localhost:${proxyPort}`,
        protocol: 'vite-hmr',
        status: 'HTTP/1.1 101 Switching Protocols',
        url: '/@vite/client?token=proof-token',
      },
    );
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test('revokes every HTTP and upgrade socket for one project before teardown', async () => {
  const upstreamSockets = new Set();
  const upstream = createHttpServer((_request, response) => {
    response.writeHead(200, { connection: 'keep-alive' });
    response.write('held-open');
  });
  upstream.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await reservePort();
  let routeActive = true;
  const proxy = await startLoopbackProxy({
    port: proxyPort,
    runtimeForHost: (key) =>
      routeActive && key === 'alpha' ? { appPort: upstreamPort, upstreamPort } : undefined,
  });
  const httpSocket = connect(proxyPort, '127.0.0.1');
  const upgradeSocket = connect(proxyPort, '127.0.0.1');
  try {
    await Promise.all([
      new Promise((resolve) => httpSocket.once('connect', resolve)),
      new Promise((resolve) => upgradeSocket.once('connect', resolve)),
    ]);
    httpSocket.write(
      `GET /held HTTP/1.1\r\nHost: alpha.localhost:${proxyPort}\r\nConnection: keep-alive\r\n\r\n`,
    );
    upgradeSocket.write(
      `GET /@vite/client HTTP/1.1\r\nHost: alpha.localhost:${proxyPort}\r\nOrigin: http://alpha.localhost:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: cHJvb2YtcHJvb2YtcHJvb2Y=\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    assert.match((await nextData(httpSocket)).toString(), /held-open/);
    assert.match((await nextData(upgradeSocket)).toString(), /101 Switching Protocols/);

    routeActive = false;
    const socketsClosed = proxy.revokeProject('alpha');
    assert.equal(socketsClosed, 4);
    await Promise.all([socketClosed(httpSocket), socketClosed(upgradeSocket)]);
    assert.equal((await fetch(`http://alpha.localhost:${proxyPort}/held`)).status, 421);
  } finally {
    httpSocket.destroy();
    upgradeSocket.destroy();
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
  }
});
