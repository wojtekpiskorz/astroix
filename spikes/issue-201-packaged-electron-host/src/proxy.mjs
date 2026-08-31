import { createHash } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';

function projectKeyFromHost(host) {
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const suffix = '.localhost';
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : undefined;
}

function rawUpgradeRequest(request, head) {
  const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  lines.push('', '');
  return Buffer.concat([Buffer.from(lines.join('\r\n')), head]);
}

function proxyHttp(request, response, upstreamPort, trackProjectSocket) {
  trackProjectSocket(request.socket);
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
      setHost: false,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.once('error', (error) => {
    if (!response.headersSent) response.writeHead(502);
    response.end(error.message);
  });
  upstream.once('socket', trackProjectSocket);
  request.pipe(upstream);
}

function createProxyServer({ runtimeForHost, handleControlRequest, onUpgrade }) {
  const sockets = new Set();
  const projectSockets = new Map();

  function trackProjectSocket(projectKey, socket) {
    let tracked = projectSockets.get(projectKey);
    if (tracked === undefined) {
      tracked = new Set();
      projectSockets.set(projectKey, tracked);
    }
    if (tracked.has(socket)) return;
    tracked.add(socket);
    socket.once('close', () => {
      tracked.delete(socket);
      if (tracked.size === 0 && projectSockets.get(projectKey) === tracked) {
        projectSockets.delete(projectKey);
      }
    });
  }

  function revokeProject(projectKey) {
    const tracked = projectSockets.get(projectKey);
    if (tracked === undefined) return 0;
    projectSockets.delete(projectKey);
    for (const socket of tracked) socket.destroy();
    return tracked.size;
  }

  const server = createHttpServer((request, response) => {
    const projectKey = projectKeyFromHost(request.headers.host ?? '');
    const runtime = projectKey === undefined ? undefined : runtimeForHost(projectKey);
    const pathname = new URL(request.url ?? '/', 'http://proxy.invalid').pathname;
    if (runtime === undefined) {
      response.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('unknown project host');
      return;
    }
    trackProjectSocket(projectKey, request.socket);
    if (pathname.startsWith('/__astroix/control/')) {
      void Promise.resolve(handleControlRequest(request, response, projectKey)).catch((error) => {
        if (!response.headersSent) response.writeHead(500);
        response.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    proxyHttp(
      request,
      response,
      pathname.startsWith('/__astroix/app/') ? runtime.appPort : runtime.upstreamPort,
      (socket) => trackProjectSocket(projectKey, socket),
    );
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const projectKey = projectKeyFromHost(request.headers.host ?? '');
    const runtime = projectKey === undefined ? undefined : runtimeForHost(projectKey);
    if (runtime === undefined) {
      socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
      return;
    }
    trackProjectSocket(projectKey, socket);
    const outbound = rawUpgradeRequest(request, head);
    const observation = {
      projectKey,
      method: request.method,
      url: request.url,
      host: request.headers.host,
      origin: request.headers.origin,
      protocol: request.headers['sec-websocket-protocol'],
      outboundSha256: createHash('sha256').update(outbound).digest('hex'),
      upstreamStatusLine: undefined,
    };
    const upstream = connectTcp(runtime.upstreamPort, '127.0.0.1');
    trackProjectSocket(projectKey, upstream);
    upstream.once('connect', () => {
      upstream.write(outbound);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once('data', (chunk) => {
      observation.upstreamStatusLine = chunk.toString('latin1').split('\r\n', 1)[0];
      onUpgrade(observation);
    });
    upstream.once('error', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
  });
  return { server, sockets, revokeProject };
}

function listen(server, port, host, options = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ...options }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close({ server, sockets }) {
  return new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

export async function startLoopbackProxy({
  port,
  runtimeForHost,
  handleControlRequest = (_request, response) => {
    response.writeHead(404);
    response.end();
  },
  onUpgrade = () => {},
}) {
  const ipv4 = createProxyServer({ runtimeForHost, handleControlRequest, onUpgrade });
  const ipv6 = createProxyServer({ runtimeForHost, handleControlRequest, onUpgrade });
  try {
    await listen(ipv4.server, port, '127.0.0.1');
    await listen(ipv6.server, port, '::1', { ipv6Only: true });
  } catch (error) {
    await Promise.allSettled([close(ipv4), close(ipv6)]);
    throw error;
  }
  return {
    port,
    addresses: [ipv4.server.address(), ipv6.server.address()],
    revokeProject(projectKey) {
      return ipv4.revokeProject(projectKey) + ipv6.revokeProject(projectKey);
    },
    async close() {
      await Promise.all([close(ipv4), close(ipv6)]);
    },
  };
}
