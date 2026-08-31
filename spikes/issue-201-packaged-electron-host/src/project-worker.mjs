import { createServer } from 'node:http';

const rawConfig = process.argv[2];
if (rawConfig === undefined) throw new Error('project worker config is required');
const config = JSON.parse(rawConfig);
const switchTarget = config.switchTarget ?? 'beta';

if (config.terminationMode === 'composition-fail') {
  process.send?.({
    type: 'fatal',
    kind: 'composition-failure',
    error: 'composition startup failed by proof configuration',
  });
  setImmediate(() => process.exit(1));
}

const appScript = `
const button = document.querySelector('[data-project-target]');
button.addEventListener('click', async () => {
  const target = button.dataset.projectTarget;
  const response = await fetch(
    '/__astroix/control/switch?project=' + encodeURIComponent(target),
    { method: 'POST' },
  );
  if (!response.ok) throw new Error('project switch failed with HTTP ' + response.status);
  const result = await response.json();
  location.replace(result.appUrl);
});
`;

const appHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>Astroix packaged-host proof</title>
  </head>
  <body>
    <h1>Astroix packaged-host proof</h1>
    <button type="button" data-project-target="${switchTarget}">Switch project</button>
    <output id="project">${config.projectKey}</output>
    <iframe id="canvas" title="Project canvas" src="/lab/home/"></iframe>
    <script src="/__astroix/app/app.js"></script>
  </body>
</html>`;

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://worker.invalid').pathname;
  if (request.method === 'GET' && pathname === '/__astroix/app/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'self'; frame-src http: https:; script-src 'self'; object-src 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
    });
    response.end(appHtml);
    return;
  }
  if (request.method === 'GET' && pathname === '/__astroix/app/app.js') {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
    response.end(appScript);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

let closing = false;
function closeAndExit() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
}

process.once('disconnect', closeAndExit);
if (config.terminationMode === 'ignore-term') {
  process.on('SIGTERM', () => {});
} else {
  process.once('SIGTERM', closeAndExit);
}

server.once('error', (error) => {
  process.send?.({ type: 'fatal', error: error.message });
  process.exitCode = 1;
});
server.listen(config.port, '127.0.0.1', () => {
  process.send?.({
    type: 'ready',
    port: config.port,
    appUrl: `http://127.0.0.1:${config.port}/__astroix/app/`,
  });
});
