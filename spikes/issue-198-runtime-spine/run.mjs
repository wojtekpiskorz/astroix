import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
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

process.env.ASTRO_DISABLE_UPDATE_CHECK = 'true';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE = join(import.meta.dirname, 'plain-project');
const SERVER_SYMBOL = Symbol.for('astroix.runtime-spine.vite-server');
const ORIGINAL_COLOR = 'rgb(10, 20, 30)';
const EDITED_COLOR = 'rgb(40, 50, 60)';
const COMMAND_TIMEOUT_MS = 20_000;
const TEARDOWN_TIMEOUT_MS = 10_000;
const assertions = [];
const metrics = {};
const require = createRequire(import.meta.url);
const astroPackageDir = dirname(require.resolve('astro/package.json'));
const vitePackagePath = require.resolve('vite/package.json');

class ProofTeardownError extends AggregateError {
  constructor(errors, retainedPath) {
    super(errors, `proof teardown failed; temporary project retained at ${retainedPath}`);
    this.retainedPath = retainedPath;
  }
}

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

async function bounded(operation, label, timeoutMs = TEARDOWN_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureCleanup(errors, label, operation) {
  try {
    await bounded(operation(), label);
  } catch (error) {
    errors.push(
      new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      }),
    );
  }
}

function throwWithCleanup(workError, cleanupErrors, retainedPath) {
  if (cleanupErrors.length > 0) {
    const errors = workError === undefined ? cleanupErrors : [workError, ...cleanupErrors];
    throw new ProofTeardownError(errors, retainedPath);
  }
  if (workError !== undefined) throw workError;
}

function errorText(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function reportFailure(error) {
  console.error(errorText(error));
  if (error instanceof ProofTeardownError) {
    for (const [index, cause] of error.errors.entries()) {
      console.error(`TEARDOWN CAUSE ${index + 1}/${error.errors.length}: ${errorText(cause)}`);
    }
  }
}

function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function temporaryTreeSignature(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const relativePath = join(prefix, name);
      entries.push(`${relativePath}:${stat.mode}:${stat.size}:${Math.trunc(stat.mtimeMs)}`);
      if (stat.isDirectory()) visit(path, relativePath);
    }
  };
  visit(root);
  return entries.join('\n');
}

async function waitForTemporaryProjectQuiescence(temp) {
  let previous;
  let stableIntervals = 0;
  await waitFor(
    () => temporaryTreeSignature(temp),
    (signature) => {
      stableIntervals = signature === previous ? stableIntervals + 1 : 0;
      previous = signature;
      return stableIntervals >= 5;
    },
    'temporary project filesystem quiescence after resource teardown',
    3_000,
  );
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
  let devServer;
  try {
    devServer = await dev({
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
  } catch (workError) {
    if (devServer === undefined) throw workError;
    const cleanupErrors = [];
    await captureCleanup(cleanupErrors, 'post-start Astro server cleanup', () => devServer.stop());
    throwWithCleanup(workError, cleanupErrors, project);
  }
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
  const resource = {
    server,
    origin:
      typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : null,
    upgradedSockets,
  };
  try {
    check(
      'standalone proxy bound an ephemeral TCP port',
      typeof address === 'object' && address !== null && address.port > 0,
    );
    return resource;
  } catch (workError) {
    const cleanupErrors = [];
    await captureCleanup(cleanupErrors, 'post-start proxy cleanup', () =>
      closeHttpServer(resource.server, resource.upgradedSockets),
    );
    throwWithCleanup(workError, cleanupErrors, 'proxy has no project path');
  }
}

function closeHttpServer(server, upgradedSockets = new Set()) {
  return new Promise((resolvePromise, reject) => {
    for (const socket of upgradedSockets) socket.terminate();
    server.close((error) => (error ? reject(error) : resolvePromise()));
    server.closeAllConnections?.();
  });
}

function renderedScopedCss(html) {
  return html.match(
    /<style[^>]*data-vite-dev-id="[^"]*home\.astro\?astro&amp;type=style&amp;index=0[^"]*"[^>]*>([\s\S]*?)<\/style>/,
  )?.[1];
}

async function outsidePayload(origin, project) {
  const realProject = realpathSync(project);
  const sourceFile = realpathSync(join(project, 'site/pages/home.astro'));
  const source = readFileSync(sourceFile, 'utf8');
  const block = extractStylesSync(source)[0];
  check('compiler exposed the scoped style block', block !== undefined);
  const moduleUrl = `/${relative(realProject, sourceFile).split(sep).join('/')}?astro&type=style&index=0&lang.css`;
  const html = await fetch(`${origin}/lab/home/`).then((response) => response.text());
  const compiledCss = renderedScopedCss(html);
  check(
    'outside pipeline observed Astro compiled scoped CSS in dev HTML',
    compiledCss !== undefined,
    html.slice(0, 500),
  );
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
  let original;
  let sourceEdited = false;
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
    original = readFileSync(sourceFile, 'utf8');
    writeFileSync(sourceFile, original.replace(ORIGINAL_COLOR, EDITED_COLOR));
    sourceEdited = true;
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
  } catch (workError) {
    const cleanupErrors = [];
    if (sourceEdited) {
      await captureCleanup(cleanupErrors, 'failed browser source restoration', async () => {
        writeFileSync(sourceFile, original);
      });
    }
    await captureCleanup(cleanupErrors, 'failed browser close', () => browser.close());
    throwWithCleanup(workError, cleanupErrors, dirname(sourceFile));
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
  const html = await pageResponse.text();
  const renderedCss = renderedScopedCss(html);
  if (renderedCss === undefined)
    throw new Error('reference page did not contain rendered scoped CSS');
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
  return { records, renderedCss };
}

async function exerciseOracle(parent, sourceImportUrl, expectedBefore, expectedAfter) {
  const project = copyProject(parent, 'reference');
  const referenceConfig = join(project, 'astro.reference.config.mjs');
  writeFileSync(
    referenceConfig,
    `import baseConfig from './astro.config.mjs';\nimport astroix from ${JSON.stringify(sourceImportUrl)};\nexport default { ...baseConfig, integrations: [...(baseConfig.integrations ?? []), astroix()] };\n`,
  );
  const hookLog = join(parent, 'reference-hooks.jsonl');
  const sourceFile = join(project, 'site/pages/home.astro');
  let server;
  let browser;
  let original;
  let sourceEdited = false;
  let workError;
  try {
    server = await startProgrammaticAstro(project, hookLog, 'astro.reference.config.mjs');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    original = readFileSync(sourceFile, 'utf8');
    await page.goto(`${server.origin}/lab/home/?builder=0`, { waitUntil: 'commit' });
    await page.waitForSelector('.hero-title');
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
    sourceEdited = true;
    const after = await waitFor(
      () => readOracle(server.origin, project),
      (oracle) => {
        const hero = oracle.records.find((record) => record.selector === '.hero-title');
        return hero?.sourceBytes.includes(EDITED_COLOR) && oracle.renderedCss.includes('#28323c');
      },
      'current integration source and rendered CSS invalidation',
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
    equal(
      'outside and current integration compiled output bytes before edit',
      expectedBefore.compiledCss,
      before.renderedCss,
    );
    equal(
      'outside and current integration compiled output bytes after edit',
      expectedAfter.compiledCss,
      after.renderedCss,
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
  } catch (error) {
    workError = error;
  }
  const cleanupErrors = [];
  if (sourceEdited) {
    await captureCleanup(cleanupErrors, 'oracle source restoration', async () => {
      writeFileSync(sourceFile, original);
    });
  }
  if (browser !== undefined)
    await captureCleanup(cleanupErrors, 'oracle browser close', () => browser.close());
  if (server !== undefined)
    await captureCleanup(cleanupErrors, 'oracle Astro server stop', () => server.devServer.stop());
  throwWithCleanup(workError, cleanupErrors, project);
}

async function commandOutput(command, args, options = {}) {
  const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exitCode = await new Promise((resolvePromise, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${command} ${args.join(' ')} timed out after ${timeoutMs} ms; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
          ),
        );
        return;
      }
      resolvePromise(code);
    });
  });
  return { exitCode, stdout, stderr };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

async function sampleSteadyRss(pid) {
  const intervalMs = 300;
  const maxSamples = 15;
  const windowSize = 5;
  const tolerancePercent = 2;
  const minimumToleranceKiB = 4096;
  const samplesKiB = [];
  for (let index = 0; index < maxSamples; index += 1) {
    const sample = await commandOutput('ps', ['-o', 'rss=', '-p', String(pid)], {
      timeoutMs: 2_000,
    });
    const rssKiB = Number(sample.stdout.trim());
    if (sample.exitCode !== 0 || !Number.isFinite(rssKiB) || rssKiB <= 0) {
      throw new Error(
        `managed process RSS sample failed at ${index + 1}: ${JSON.stringify(sample)}`,
      );
    }
    samplesKiB.push(rssKiB);
    if (samplesKiB.length >= windowSize) {
      const windowKiB = samplesKiB.slice(-windowSize);
      const windowMedianKiB = median(windowKiB);
      const toleranceKiB = Math.max(
        minimumToleranceKiB,
        Math.ceil(windowMedianKiB * (tolerancePercent / 100)),
      );
      if (Math.max(...windowKiB) - Math.min(...windowKiB) <= toleranceKiB) {
        return {
          intervalMs,
          maxSamples,
          windowSize,
          tolerancePercent,
          minimumToleranceKiB,
          samplesKiB,
          convergedWindowKiB: windowKiB,
          toleranceKiB,
          steadyStateRssKiB: windowMedianKiB,
        };
      }
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `managed process RSS did not converge: samplesKiB=${JSON.stringify(samplesKiB)} criterion=last ${windowSize} samples span <= max(${minimumToleranceKiB} KiB, ${tolerancePercent}% of window median)`,
  );
}

function spawnManagedForeground(astroBin, spawnOptions) {
  const child = spawn(process.execPath, [astroBin, 'dev', '--port', '0', '--host', '127.0.0.1'], {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const resource = {
    child,
    stdout: '',
    stderr: '',
    spawnError: undefined,
    closeResult: undefined,
    closePromise: undefined,
  };
  child.stdout.on('data', (chunk) => (resource.stdout += chunk));
  child.stderr.on('data', (chunk) => (resource.stderr += chunk));
  child.on('error', (error) => (resource.spawnError = error));
  resource.closePromise = new Promise((resolvePromise) => {
    child.once('close', (code, signal) => {
      resource.closeResult = { code, signal };
      resolvePromise(resource.closeResult);
    });
  });
  return resource;
}

function managedOutput(resource) {
  return `${resource.stdout}\n${resource.stderr}`;
}

async function waitForManagedUrl(resource, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (resource.spawnError !== undefined) throw resource.spawnError;
    const output = managedOutput(resource);
    const url = output.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?:\/[^\s]*)?/)?.[0];
    if (url !== undefined) return new URL(url);
    if (resource.closeResult !== undefined) {
      throw new Error(
        `managed foreground child exited before reporting its URL: ${JSON.stringify({ ...resource.closeResult, output })}`,
      );
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `timed out waiting for managed foreground child URL; output=${JSON.stringify(managedOutput(resource))}`,
  );
}

async function pidIsAlive(pid) {
  return (await commandOutput('ps', ['-p', String(pid)], { timeoutMs: 2_000 })).exitCode === 0;
}

async function waitForPidExit(pid, label, timeoutMs) {
  await waitFor(
    () => pidIsAlive(pid),
    (alive) => !alive,
    label,
    timeoutMs,
  );
}

async function stopManagedForeground(resource) {
  const pid = resource.child.pid;
  let escalated = false;
  if (pid !== undefined && (await pidIsAlive(pid))) {
    if (!resource.child.kill('SIGTERM')) {
      throw new Error(`failed to send SIGTERM to managed foreground child ${pid}`);
    }
    try {
      await waitForPidExit(pid, 'managed foreground child graceful exit', 5_000);
    } catch (gracefulError) {
      escalated = true;
      if ((await pidIsAlive(pid)) && !resource.child.kill('SIGKILL')) {
        throw new AggregateError(
          [gracefulError],
          `failed to send SIGKILL to managed foreground child ${pid}`,
        );
      }
      await waitForPidExit(pid, 'managed foreground child forced exit', 3_000);
    }
  }
  await bounded(resource.closePromise, 'managed foreground child close event', 2_000);
  return { escalated };
}

async function exerciseManagedForeground(parent) {
  const project = copyProject(parent, 'managed-foreground');
  const hookLog = join(parent, 'managed-foreground-hooks.jsonl');
  const astroBin = join(astroPackageDir, 'bin/astro.mjs');
  const startedAt = performance.now();
  const spawnOptions = {
    cwd: project,
    env: {
      ...process.env,
      ASTROIX_RUNTIME_SPINE_HOOK_LOG: hookLog,
      ASTRO_DEV_BACKGROUND: '1',
      ASTRO_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
  };
  let managedChild;
  let workError;
  try {
    managedChild = spawnManagedForeground(astroBin, spawnOptions);
    const childPid = managedChild.child.pid;
    check(
      'managed foreground astro dev child has a process id',
      childPid !== undefined && childPid > 0,
      String(childPid),
    );
    const listeningUrl = await waitForManagedUrl(managedChild);
    const boundPort = Number(listeningUrl.port);
    check(
      'managed foreground astro dev reported an actual bound port',
      boundPort > 0,
      String(boundPort),
    );
    const configured = await waitFor(
      () => readJsonLines(hookLog).findLast((entry) => entry.hook === 'astro:config:setup'),
      Boolean,
      'managed foreground configured server port observation',
    );
    equal(
      'managed foreground astro dev preserved configured server port 0',
      configured.serverPort,
      0,
    );
    const listening = await waitFor(
      () =>
        readJsonLines(hookLog).findLast((entry) => entry.hook === 'runtime-spine:server-listening'),
      Boolean,
      'managed foreground actual bound port observation',
    );
    equal(
      'managed foreground observer actual port matches the CLI URL',
      listening.actualPort,
      boundPort,
    );
    metrics.managedConfiguredPort = configured.serverPort;
    metrics.managedBoundPort = boundPort;
    if (process.env.ASTROIX_RUNTIME_SPINE_FORCE_FAILURE === 'managed-start') {
      throw new Error('forced failure after managed foreground child start');
    }
    metrics.managedForegroundBootMs = Math.round(performance.now() - startedAt);
    const response = await fetch(`${listeningUrl.origin}/lab/home/`);
    check('managed foreground astro dev served the plain project', response.ok);
    const rss = await bounded(sampleSteadyRss(childPid), 'managed process RSS convergence', 15_000);
    metrics.managedForegroundSteadyRssKiB = rss.steadyStateRssKiB;
    metrics.managedForegroundRssSampling = rss;
    check(
      'managed process RSS reached the bounded steady-state criterion',
      rss.convergedWindowKiB.length === rss.windowSize,
    );
    const watcher = await waitFor(
      () =>
        readJsonLines(hookLog).findLast((entry) => entry.hook === 'runtime-spine:watcher-snapshot'),
      Boolean,
      'managed process watcher snapshot',
    );
    metrics.watchedDirectories = watcher.watchedDirectories;
    metrics.watchedEntries = watcher.watchedEntries;
    metrics.watcherListeners = watcher.watcherListeners;
  } catch (error) {
    workError = error;
  }
  const cleanupErrors = [];
  if (managedChild !== undefined) {
    const shutdownAt = performance.now();
    try {
      const shutdown = await stopManagedForeground(managedChild);
      metrics.managedForegroundShutdownMs = Math.round(performance.now() - shutdownAt);
      metrics.managedForegroundShutdownEscalated = shutdown.escalated;
      check('managed foreground astro dev child shut down', true);
      managedChild = undefined;
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `managed foreground child teardown failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            cause: error,
          },
        ),
      );
    }
  }
  throwWithCleanup(workError, cleanupErrors, project);
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
  let workError;
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
    if (process.env.ASTROIX_RUNTIME_SPINE_FORCE_FAILURE === 'plain-start') {
      throw new Error('forced failure after plain server and proxy start');
    }
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
    await bounded(browserExercise.browser.close(), 'plain browser close');
    browserExercise = null;
    await bounded(closeHttpServer(proxy.server, proxy.upgradedSockets), 'plain proxy close');
    proxy = null;
    await bounded(programmatic.devServer.stop(), 'plain Astro server stop');
    programmatic = null;

    console.log('RUN current-integration-oracle');
    await exerciseOracle(
      temp,
      pathToFileURL(join(ROOT, 'src/index.ts')).href,
      beforeOutside,
      afterOutside,
    );
    console.log('RUN managed-foreground-metrics');
    await exerciseManagedForeground(temp);

    const astroVersion = JSON.parse(
      readFileSync(join(astroPackageDir, 'package.json'), 'utf8'),
    ).version;
    const viteVersion = JSON.parse(readFileSync(vitePackagePath, 'utf8')).version;
    metrics.astroVersion = astroVersion;
    metrics.viteVersion = viteVersion;
    equal('exact Astro version', astroVersion, '7.2.7');
    equal('exact Vite version', viteVersion, '8.2.2');
  } catch (error) {
    workError = error;
  }
  const cleanupErrors = [];
  if (browserExercise != null) {
    await captureCleanup(cleanupErrors, 'main source restoration', async () => {
      writeFileSync(join(plain, 'site/pages/home.astro'), browserExercise.original);
    });
    await captureCleanup(cleanupErrors, 'main browser close', () =>
      browserExercise.browser.close(),
    );
  }
  if (proxy != null)
    await captureCleanup(cleanupErrors, 'main proxy close', () =>
      closeHttpServer(proxy.server, proxy.upgradedSockets),
    );
  if (programmatic != null)
    await captureCleanup(cleanupErrors, 'main Astro server stop', () =>
      programmatic.devServer.stop(),
    );
  delete process.env.ASTROIX_RUNTIME_SPINE_HOOK_LOG;
  if (cleanupErrors.length === 0 && !(workError instanceof ProofTeardownError)) {
    await captureCleanup(cleanupErrors, 'temporary project quiescence', () =>
      waitForTemporaryProjectQuiescence(temp),
    );
  }
  if (cleanupErrors.length > 0) throwWithCleanup(workError, cleanupErrors, temp);
  if (workError instanceof ProofTeardownError) throw workError;
  if (temp.startsWith(`${canonicalTmp}${sep}astroix-runtime-spine-`))
    rmSync(temp, { recursive: true, force: true });
  if (workError !== undefined) throw workError;
  console.log('PASS runtime-spine proof');
  for (const assertion of assertions) console.log(`PASS ${assertion.name}`);
  console.log(`METRICS ${JSON.stringify(metrics)}`);
}

main().catch((error) => {
  console.error('FAIL runtime-spine proof');
  for (const assertion of assertions)
    console.error(
      `${assertion.pass ? 'PASS' : 'FAIL'} ${assertion.name}${assertion.detail ? ` | ${assertion.detail}` : ''}`,
    );
  reportFailure(error);
  process.exitCode = 1;
});
