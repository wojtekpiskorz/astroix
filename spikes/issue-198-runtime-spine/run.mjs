import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractStylesSync } from '@astrojs/compiler-binding';
import { chromium } from '@playwright/test';
import postcss from 'postcss';
import { createServerModuleRunner } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(import.meta.dirname, 'plain-project');
const SERVER_SYMBOL = Symbol.for('astroix.runtime-spine.vite-server');
const ORIGINAL_COLOR = 'rgb(10, 20, 30)';
const EDITED_COLOR = 'rgb(40, 50, 60)';
const assertions = [];
const metrics = {};
const require = createRequire(import.meta.url);
const astroPackageDir = dirname(require.resolve('astro/package.json'));
const vitePackagePath = require.resolve('vite/package.json');

function check(name, condition, detail = '') {
  assertions.push({ name, pass: Boolean(condition), detail });
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

function equal(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  check(
    name,
    pass,
    pass
      ? JSON.stringify(actual)
      : `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}

async function waitFor(read, accept, label, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function copyProject(parent, name) {
  const target = join(parent, name);
  cpSync(FIXTURE, target, {
    recursive: true,
    filter: (source) => !['.astro', 'node_modules'].includes(basename(source)),
  });
  symlinkSync(join(ROOT, 'node_modules'), join(target, 'node_modules'), 'dir');
  return target;
}

function astroPrivate(relativePath) {
  return import(pathToFileURL(join(astroPackageDir, relativePath)).href);
}

async function loadConfigOutside(project, hookLog) {
  process.env.ASTROIX_RUNTIME_SPINE_HOOK_LOG = hookLog;
  const [{ resolveConfig }, { createSettings }, { AstroLogger }, { runHookConfigSetup }] =
    await Promise.all([
      astroPrivate('dist/core/config/config.js'),
      astroPrivate('dist/core/config/settings.js'),
      astroPrivate('dist/core/logger/core.js'),
      astroPrivate('dist/integrations/hooks.js'),
    ]);
  const { astroConfig } = await resolveConfig({ root: project, logLevel: 'silent' }, 'dev');
  let settings = await createSettings(astroConfig, 'silent', project);
  settings = await runHookConfigSetup({
    settings,
    command: 'dev',
    logger: new AstroLogger({ level: 'silent', destination: { write() {} } }),
  });
  const aliases = settings.config.vite.resolve?.alias ?? {};
  const aliasValue = Array.isArray(aliases)
    ? aliases.find((entry) => entry.find === '@fixture')?.replacement
    : aliases['@fixture'];
  return {
    srcDir: fileURLToPath(settings.config.srcDir),
    base: settings.config.base,
    scopedStyleStrategy: settings.config.scopedStyleStrategy,
    aliasValue,
    integrationNames: settings.config.integrations.map((integration) => integration.name),
  };
}

async function startProgrammaticAstro(project, hookLog, configFile) {
  process.env.ASTROIX_RUNTIME_SPINE_HOOK_LOG = hookLog;
  delete globalThis[SERVER_SYMBOL];
  const { default: dev } = await astroPrivate('dist/core/dev/dev.js');
  const startedAt = performance.now();
  const devServer = await dev({
    root: project,
    configFile,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  const viteServer = globalThis[SERVER_SYMBOL];
  check('project instrumentation exposed the Vite server', viteServer !== undefined);
  const address = devServer.address;
  check(
    'programmatic Astro bound an ephemeral TCP port',
    typeof address === 'object' && address !== null && address.port > 0,
  );
  return {
    devServer,
    viteServer,
    origin: `http://127.0.0.1:${address.port}`,
    bootMs: performance.now() - startedAt,
  };
}

function rewriteCanvasPath(url) {
  const parsed = new URL(url, 'http://proxy.invalid');
  const prefix = '/lab/__astroix/canvas';
  if (parsed.pathname.startsWith(prefix))
    parsed.pathname = `/lab${parsed.pathname.slice(prefix.length) || '/'}`;
  return `${parsed.pathname}${parsed.search}`;
}

async function startProxy(upstreamPort) {
  const upgradedSockets = new Set();
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (new URL(url, 'http://proxy.invalid').pathname === '/lab/__astroix/app/') {
      const body =
        '<!doctype html><html><body><h1>Astroix app stand-in</h1><iframe id="canvas" src="/lab/__astroix/canvas/home/"></iframe></body></html>';
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: rewriteCanvasPath(url),
        headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(error.message);
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    websocketServer.handleUpgrade(req, socket, head, (client) => {
      const protocol = req.headers['sec-websocket-protocol'];
      const upstream = new WebSocket(
        `ws://127.0.0.1:${upstreamPort}${req.url ?? '/'}`,
        typeof protocol === 'string' ? protocol : undefined,
        { headers: req.headers.origin ? { origin: req.headers.origin } : undefined },
      );
      const pending = [];
      client.on('message', (data, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else pending.push([data, binary]);
      });
      upstream.on('open', () => {
        for (const [data, binary] of pending) upstream.send(data, { binary });
        pending.length = 0;
      });
      upstream.on('message', (data, binary) => client.send(data, { binary }));
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
      client.on('error', () => upstream.terminate());
      upstream.on('error', () => client.terminate());
      upgradedSockets.add(client);
      upgradedSockets.add(upstream);
      client.once('close', () => upgradedSockets.delete(client));
      upstream.once('close', () => upgradedSockets.delete(upstream));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  check(
    'standalone proxy bound an ephemeral TCP port',
    typeof address === 'object' && address !== null && address.port > 0,
  );
  return { server, origin: `http://127.0.0.1:${address.port}`, upgradedSockets };
}

function closeHttpServer(server, upgradedSockets = new Set()) {
  return new Promise((resolvePromise, reject) => {
    for (const socket of upgradedSockets) socket.terminate();
    server.close((error) => (error ? reject(error) : resolvePromise()));
    server.closeAllConnections?.();
  });
}

async function outsidePayload(origin, project) {
  const realProject = realpathSync(project);
  const sourceFile = realpathSync(join(project, 'site/pages/home.astro'));
  const source = readFileSync(sourceFile, 'utf8');
  const block = extractStylesSync(source)[0];
  check('compiler exposed the scoped style block', block !== undefined);
  const moduleUrl = `/${relative(realProject, sourceFile).split(sep).join('/')}?astro&type=style&index=0&lang.css`;
  const html = await fetch(`${origin}/lab/home/`).then((response) => response.text());
  const compiledStyle = html.match(
    /<style[^>]*data-vite-dev-id="[^"]*home\.astro\?astro&amp;type=style&amp;index=0[^"]*"[^>]*>([\s\S]*?)<\/style>/,
  );
  check(
    'outside pipeline observed Astro compiled scoped CSS in dev HTML',
    compiledStyle?.[1] !== undefined,
    html.slice(0, 500),
  );
  const compiledCss = compiledStyle[1];
  const sourceOffset = source.indexOf(block.content);
  check('style block bytes map back to the Astro source', sourceOffset >= 0);
  const records = [];
  postcss.parse(block.content).walkRules((rule) => {
    if (!rule.source?.start || !rule.source?.end) return;
    const start = sourceOffset + rule.source.start.offset;
    const end = sourceOffset + rule.source.end.offset;
    records.push({
      selector: rule.selector,
      effectiveSelector: null,
      range: { start, end },
      sourceBytes: source.slice(start, end),
    });
  });
  const effectiveSelectors = [];
  postcss.parse(compiledCss).walkRules((rule) => effectiveSelectors.push(rule.selector));
  for (const [index, record] of records.entries()) {
    record.effectiveSelector = effectiveSelectors[index] ?? null;
  }
  return { sourceFile, source, compiledCss, records, moduleId: moduleUrl };
}

function targetRecord(payload) {
  const record = payload.records.find((candidate) => candidate.selector === '.hero-title');
  check('payload contains the hero rule', record !== undefined);
  return record;
}

async function cssomRule(page, selectorFragment = '.hero-title') {
  return page.evaluate((fragment) => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if ('selectorText' in rule && rule.selectorText.includes(fragment)) return rule.cssText;
      }
    }
    return null;
  }, selectorFragment);
}

async function exerciseBrowser(proxyOrigin, sourceFile) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    console.log('RUN browser-app-load');
    await page.goto(`${proxyOrigin}/lab/__astroix/app/`, { waitUntil: 'commit' });
    const iframe = await page.waitForSelector('#canvas');
    const frame = await waitFor(() => iframe.contentFrame(), Boolean, 'canvas frame attachment');
    check('app stand-in rendered a canvas iframe', frame !== undefined);
    await frame.waitForSelector('.hero-title');
    const bridge = await page.evaluate(() => {
      const iframe = document.querySelector('#canvas');
      const title = iframe.contentDocument.querySelector('.hero-title');
      return {
        parentOrigin: location.origin,
        iframeOrigin: iframe.contentWindow.location.origin,
        directDocument: Boolean(iframe.contentDocument?.querySelector('.hero-title')),
        matches: title.matches('.hero-title'),
      };
    });
    equal('parent and canvas origins are equal', bridge.parentOrigin, bridge.iframeOrigin);
    check('parent has direct contentDocument access', bridge.directDocument);
    check('selection uses Element.matches()', bridge.matches);
    equal(
      'custom alias rendered through the real config',
      await frame.locator('[data-alias]').textContent(),
      'Alias resolved outside the managed server',
    );

    console.log('RUN browser-navigation');
    await frame.getByRole('link', { name: 'Read first article' }).click();
    await frame.waitForURL(/\/lab\/articles\/first\/$/);
    const inspectedPath = await page.evaluate(
      () => document.querySelector('#canvas').contentWindow.location.pathname,
    );
    equal('parent inspects canvas navigation', inspectedPath, '/lab/articles/first/');

    console.log('RUN browser-hmr');
    await frame.goto(`${proxyOrigin}/lab/__astroix/canvas/home/`, { waitUntil: 'commit' });
    await frame.waitForSelector('.hero-title');
    const loadsBeforeEdit = await frame.evaluate(() => window.__runtimeSpineLoads);
    const original = readFileSync(sourceFile, 'utf8');
    writeFileSync(sourceFile, original.replace(ORIGINAL_COLOR, EDITED_COLOR));
    try {
      await waitFor(
        () => frame.locator('.hero-title').evaluate((element) => getComputedStyle(element).color),
        (color) => color === EDITED_COLOR,
        'same-origin canvas CSS HMR',
      );
      equal(
        'CSS HMR updates without a canvas document reload',
        await frame.evaluate(() => window.__runtimeSpineLoads),
        loadsBeforeEdit,
      );
      return { page, frame, browser, original };
    } catch (error) {
      writeFileSync(sourceFile, original);
      throw error;
    }
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function exerciseRunnerAndRoutes(viteServer, project, hookLog) {
  const hot = viteServer.environments.ssr.hot;
  const listenerCount = () =>
    typeof hot.listenerCount === 'function' ? hot.listenerCount('send') : null;
  const before = listenerCount();
  const runner = createServerModuleRunner(viteServer.environments.ssr);
  const during = listenerCount();
  let closed = false;
  try {
    const configModule = await runner.import(
      pathToFileURL(join(project, 'site/content.config.ts')).href,
    );
    check(
      'content schema loaded through a fresh runner',
      typeof configModule.collections?.articles?.schema === 'object',
    );
    const contentModule = await runner.import('astro:content');
    const entries = await contentModule.getCollection('articles');
    equal('content collection loaded through Astro core', entries.map((entry) => entry.id).sort(), [
      'first',
      'second',
    ]);

    const observations = readJsonLines(hookLog);
    equal(
      'managed programmatic config hook invocation count is observable',
      observations.filter((entry) => entry.hook === 'astro:config:setup').length,
      1,
    );
    const routesObservation = observations.findLast(
      (entry) => entry.hook === 'astro:routes:resolved',
    );
    check('route hook captured resolved routes', routesObservation !== undefined);
    const articleRoute = routesObservation.routes.find((route) =>
      route.entrypoint?.includes('[slug].astro'),
    );
    check('dynamic article route was enumerated', articleRoute !== undefined);
    const entrypoint = articleRoute.entrypoint.startsWith('/')
      ? articleRoute.entrypoint
      : join(project, articleRoute.entrypoint);
    const routeModule = await runner.import(pathToFileURL(entrypoint).href);
    const staticPaths = await routeModule.getStaticPaths();
    equal(
      'fresh runner enumerated concrete route params',
      staticPaths.map((entry) => entry.params.slug).sort(),
      ['first', 'second'],
    );
  } finally {
    await runner.close();
    closed = true;
  }
  const after = listenerCount();
  check('fresh module runner was closed', closed);
  if (before !== null && during !== null && after !== null) {
    check(
      'fresh runner closure restored the SSR hot listener count',
      after === before,
      `before=${before} during=${during} after=${after}`,
    );
  }
  return { listenerCountBefore: before, listenerCountDuring: during, listenerCountAfter: after };
}

function endpointRecords(payload, project) {
  return payload.map((record) => {
    const source = readFileSync(join(project, record.file), 'utf8');
    return { ...record, sourceBytes: source.slice(record.range.start, record.range.end) };
  });
}

async function readOracle(origin, project) {
  const pageResponse = await fetch(`${origin}/lab/home/?builder=0`);
  if (!pageResponse.ok) throw new Error(`reference page failed: ${pageResponse.status}`);
  const records = await waitFor(
    async () => {
      const response = await fetch(`${origin}/__astroix/index`);
      if (!response.ok) throw new Error(`reference index failed: ${response.status}`);
      return endpointRecords(await response.json(), project);
    },
    (payload) =>
      payload.some((record) => record.selector === '.hero-title' && record.effectiveSelector),
    'current integration effective selector endpoint',
  );
  return { records };
}

async function exerciseOracle(parent, sourceImportUrl, expectedBefore, expectedAfter) {
  const project = copyProject(parent, 'reference');
  const referenceConfig = join(project, 'astro.reference.config.mjs');
  writeFileSync(
    referenceConfig,
    `import baseConfig from './astro.config.mjs';\nimport astroix from ${JSON.stringify(sourceImportUrl)};\nexport default { ...baseConfig, integrations: [...(baseConfig.integrations ?? []), astroix()] };\n`,
  );
  const hookLog = join(parent, 'reference-hooks.jsonl');
  const server = await startProgrammaticAstro(project, hookLog, 'astro.reference.config.mjs');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sourceFile = join(project, 'site/pages/home.astro');
  const original = readFileSync(sourceFile, 'utf8');
  try {
    await page.goto(`${server.origin}/lab/home/?builder=0`, { waitUntil: 'commit' });
    const before = await readOracle(server.origin, project);
    const beforeRecord = targetRecord(before);
    const beforeMatches = await page
      .locator(beforeRecord.effectiveSelector)
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => `${node.tagName}.${node.classList.contains('hero-title') ? 'hero-title' : ''}`,
        ),
      );
    const beforeCssom = await cssomRule(page);

    writeFileSync(sourceFile, original.replace(ORIGINAL_COLOR, EDITED_COLOR));
    await waitFor(
      async () => targetRecord(await readOracle(server.origin, project)).sourceBytes,
      (bytes) => bytes.includes(EDITED_COLOR),
      'current integration invalidation after source edit',
    );
    const afterCssom = await waitFor(
      async () => {
        await page.reload({ waitUntil: 'commit' });
        await page.waitForSelector('.hero-title');
        return cssomRule(page);
      },
      (css) => css?.includes(EDITED_COLOR),
      'current integration browser CSS invalidation',
    );
    const after = await readOracle(server.origin, project);
    const afterRecord = targetRecord(after);
    const afterMatches = await page
      .locator(afterRecord.effectiveSelector)
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => `${node.tagName}.${node.classList.contains('hero-title') ? 'hero-title' : ''}`,
        ),
      );
    equal(
      'outside and current integration effective selector before edit',
      targetRecord(expectedBefore).effectiveSelector,
      beforeRecord.effectiveSelector,
    );
    equal(
      'outside and current integration effective selector after edit',
      targetRecord(expectedAfter).effectiveSelector,
      afterRecord.effectiveSelector,
    );
    equal(
      'outside and current integration source bytes before edit',
      targetRecord(expectedBefore).sourceBytes,
      beforeRecord.sourceBytes,
    );
    equal(
      'outside and current integration source bytes after edit',
      targetRecord(expectedAfter).sourceBytes,
      afterRecord.sourceBytes,
    );
    equal('current integration selector matches the expected DOM node before edit', beforeMatches, [
      'H1.hero-title',
    ]);
    equal('current integration selector matches the expected DOM node after edit', afterMatches, [
      'H1.hero-title',
    ]);
    check(
      'current browser emits scoped CSS bytes before edit',
      beforeCssom?.includes(ORIGINAL_COLOR),
    );
    check(
      'current browser emits invalidated scoped CSS bytes after edit',
      afterCssom?.includes(EDITED_COLOR),
    );
  } finally {
    writeFileSync(sourceFile, original);
    await browser.close();
    await server.devServer.stop();
  }
}

async function commandOutput(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  return { exitCode, stdout, stderr };
}

async function exerciseManagedCli(parent) {
  const project = copyProject(parent, 'managed-cli');
  const hookLog = join(parent, 'managed-cli-hooks.jsonl');
  const astroBin = join(astroPackageDir, 'bin/astro.mjs');
  const startedAt = performance.now();
  const spawnOptions = {
    cwd: project,
    env: {
      ...process.env,
      ASTROIX_RUNTIME_SPINE_HOOK_LOG: hookLog,
      ASTRO_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
  };
  let daemonPid = null;
  try {
    const start = await commandOutput(
      process.execPath,
      [astroBin, 'dev', '--background', '--port', '0', '--host', '127.0.0.1'],
      spawnOptions,
    );
    check('managed astro dev --port 0 command exited cleanly', start.exitCode === 0, start.stderr);
    const output = `${start.stdout}\n${start.stderr}`;
    const port = Number(output.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/)?.[1] ?? 0);
    daemonPid = Number(output.match(/pid (\d+)/)?.[1] ?? 0);
    check('managed astro dev --port 0 reported an ephemeral port', port > 0, output);
    check('managed astro dev reported its daemon pid', daemonPid > 0, output);
    metrics.managedCliBootMs = Math.round(performance.now() - startedAt);
    const response = await fetch(`http://127.0.0.1:${port}/lab/home/`);
    check('managed astro dev --port 0 served the plain project', response.ok);
    await Bun.sleep(500);
    const rss = await commandOutput('ps', ['-o', 'rss=', '-p', String(daemonPid)]);
    check('managed process RSS was readable', rss.exitCode === 0 && Number(rss.stdout.trim()) > 0);
    metrics.managedCliSteadyRssKiB = Number(rss.stdout.trim());
    const watcher = await waitFor(
      () =>
        readJsonLines(hookLog).findLast((entry) => entry.hook === 'runtime-spine:watcher-snapshot'),
      Boolean,
      'managed process watcher snapshot',
    );
    metrics.watchedDirectories = watcher.watchedDirectories;
    metrics.watchedEntries = watcher.watchedEntries;
    metrics.watcherListeners = watcher.watcherListeners;
    const shutdownAt = performance.now();
    const stop = await commandOutput(process.execPath, [astroBin, 'dev', 'stop'], spawnOptions);
    metrics.managedCliShutdownMs = Math.round(performance.now() - shutdownAt);
    check('managed astro dev process shut down through the CLI', stop.exitCode === 0, stop.stderr);
    daemonPid = null;
  } finally {
    if (daemonPid)
      await commandOutput(process.execPath, [astroBin, 'dev', 'stop'], spawnOptions).catch(
        () => {},
      );
  }
}

async function main() {
  check('plain-project fixture exists', existsSync(join(FIXTURE, 'astro.config.mjs')));
  const canonicalTmp = realpathSync(tmpdir());
  const temp = mkdtempSync(join(canonicalTmp, 'astroix-runtime-spine-'));
  const plain = copyProject(temp, 'plain');
  const outsideHookLog = join(temp, 'outside-config-hooks.jsonl');
  const programmaticHookLog = join(temp, 'programmatic-hooks.jsonl');
  let programmatic;
  let proxy;
  let browserExercise;
  try {
    console.log('RUN outside-config');
    const config = await loadConfigOutside(plain, outsideHookLog);
    equal('outside config load preserves custom srcDir', relative(plain, config.srcDir), 'site');
    equal('outside config load preserves base', config.base, '/lab');
    equal(
      'outside config load preserves scoped-style strategy',
      config.scopedStyleStrategy,
      'where',
    );
    equal(
      'outside config load preserves alias',
      config.aliasValue,
      realpathSync(join(plain, 'site/lib')),
    );
    equal('plain project has no Astroix integration', config.integrationNames, [
      'runtime-spine:observer',
    ]);
    equal(
      'outside config setup hook invocation count is observable',
      readJsonLines(outsideHookLog).filter((entry) => entry.hook === 'astro:config:setup').length,
      1,
    );

    console.log('RUN plain-server-and-browser');
    programmatic = await startProgrammaticAstro(plain, programmaticHookLog);
    metrics.programmaticBootMs = Math.round(programmatic.bootMs);
    proxy = await startProxy(Number(new URL(programmatic.origin).port));
    console.log('RUN rendered-css-primer');
    await fetch(`${programmatic.origin}/lab/home/`);
    console.log('RUN outside-payload-before');
    const sourceFile = join(plain, 'site/pages/home.astro');
    const beforeOutside = await outsidePayload(programmatic.origin, plain);
    check(
      'outside pipeline reproduced a :where scoped selector',
      targetRecord(beforeOutside).effectiveSelector?.includes(':where('),
    );

    browserExercise = await exerciseBrowser(proxy.origin, sourceFile);
    console.log('RUN outside-payload-after');
    await fetch(`${programmatic.origin}/lab/home/`);
    const afterOutside = await waitFor(
      () => outsidePayload(programmatic.origin, plain),
      (payload) => targetRecord(payload).sourceBytes.includes(EDITED_COLOR),
      'outside payload invalidation after source edit',
    );
    const outsideMatched = await browserExercise.frame
      .locator(targetRecord(afterOutside).effectiveSelector)
      .evaluateAll((nodes) =>
        nodes.map(
          (node) => `${node.tagName}.${node.classList.contains('hero-title') ? 'hero-title' : ''}`,
        ),
      );
    equal('outside effective selector matches the concrete canvas node', outsideMatched, [
      'H1.hero-title',
    ]);
    check(
      'outside compiled CSS bytes changed after invalidation',
      beforeOutside.compiledCss !== afterOutside.compiledCss,
    );
    check(
      'outside compiled CSS carries the edited color output',
      afterOutside.compiledCss.includes('#28323c'),
    );

    console.log('RUN content-routes-runner');
    metrics.runnerListeners = await exerciseRunnerAndRoutes(
      programmatic.viteServer,
      plain,
      programmaticHookLog,
    );
    writeFileSync(sourceFile, browserExercise.original);
    await waitFor(
      () =>
        browserExercise.frame
          .locator('.hero-title')
          .evaluate((element) => getComputedStyle(element).color),
      (color) => color === ORIGINAL_COLOR,
      'source restoration through HMR',
    );
    await browserExercise.browser.close();
    browserExercise = null;
    await closeHttpServer(proxy.server, proxy.upgradedSockets);
    proxy = null;
    await programmatic.devServer.stop();
    programmatic = null;

    console.log('RUN current-integration-oracle');
    await exerciseOracle(
      temp,
      pathToFileURL(join(ROOT, 'src/index.ts')).href,
      beforeOutside,
      afterOutside,
    );
    console.log('RUN managed-cli-metrics');
    await exerciseManagedCli(temp);

    const astroVersion = JSON.parse(
      readFileSync(join(astroPackageDir, 'package.json'), 'utf8'),
    ).version;
    const viteVersion = JSON.parse(readFileSync(vitePackagePath, 'utf8')).version;
    metrics.astroVersion = astroVersion;
    metrics.viteVersion = viteVersion;
    equal('exact Astro version', astroVersion, '7.2.7');
    equal('exact Vite version', viteVersion, '8.2.2');

    console.log('PASS runtime-spine proof');
    for (const assertion of assertions) console.log(`PASS ${assertion.name}`);
    console.log(`METRICS ${JSON.stringify(metrics)}`);
  } finally {
    if (browserExercise) {
      writeFileSync(join(plain, 'site/pages/home.astro'), browserExercise.original);
      await browserExercise.browser.close().catch(() => {});
    }
    if (proxy) await closeHttpServer(proxy.server, proxy.upgradedSockets).catch(() => {});
    if (programmatic) await programmatic.devServer.stop().catch(() => {});
    delete process.env.ASTROIX_RUNTIME_SPINE_HOOK_LOG;
    if (temp.startsWith(`${canonicalTmp}${sep}astroix-runtime-spine-`))
      rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL runtime-spine proof');
  for (const assertion of assertions)
    console.error(
      `${assertion.pass ? 'PASS' : 'FAIL'} ${assertion.name}${assertion.detail ? ` | ${assertion.detail}` : ''}`,
    );
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
