import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { certifyProjectBeforeConfig } from './certification.mjs';
import { buildStaticIndex, joinEffectiveSelectors } from './index-payload.mjs';
import {
  readAstroInternalCssUtil,
  readClientEnvironment,
  readDevCssEntries,
  readRouteEntries,
  readRunnerContract,
  readSsrEnvironment,
  readTransformedModule,
  readViteClientCss,
  readViteRuntime,
} from './seam-contracts.mjs';

const requestedProjectRoot = requiredEnv('ASTROIX_PROOF_PROJECT_ROOT');
const projectRoot = await realpath(requestedProjectRoot);
const strategy = requiredEnv('ASTROIX_PROOF_STRATEGY');
const certifiedPairs = JSON.parse(requiredEnv('ASTROIX_PROOF_CERTIFIED_PAIRS'));
const watcherEvents = [];
const runnerAttempts = [];
let server;
let createServerModuleRunner;
let getDevCSSModuleName;
let pair;
let closing;

process.on('message', (message) => {
  void handleMessage(message);
});
process.on('SIGTERM', () => {
  void closeWorker('sigterm').finally(() => process.exit(0));
});

void start().catch(async (error) => {
  const cleanup = await closeWorker('startup-failure').catch((cleanupError) => ({
    cleanupError: serializeError(cleanupError),
    compositionServerClosed: false,
    reason: 'startup-failure',
  }));
  send({ cleanup, error: serializeError(error), type: 'fatal' });
  process.disconnect();
  process.exitCode = 1;
});

async function start() {
  const startedAt = performance.now();
  pair = await certifyProjectBeforeConfig(
    { certifiedPairs, projectRoot },
    async (certifiedPair) => certifiedPair,
  );
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  const astroManifestPath = projectRequire.resolve('astro/package.json');
  const astroPackageRoot = dirname(astroManifestPath);
  const astroConfig = await import(pathToFileURL(projectRequire.resolve('astro/config')).href);
  const vite = await import(pathToFileURL(projectRequire.resolve('vite')).href);
  const cssUtilPath = join(astroPackageRoot, 'dist', 'vite-plugin-css', 'util.js');
  const cssUtil = await import(pathToFileURL(cssUtilPath).href);
  if (typeof astroConfig.getViteConfig !== 'function') {
    throw new Error('AstroProjectAdapter public seam rejection: astro/config has no getViteConfig');
  }
  const viteRuntime = readViteRuntime(vite);
  createServerModuleRunner = viteRuntime.createServerModuleRunner;
  getDevCSSModuleName = readAstroInternalCssUtil(cssUtil, cssUtilPath);

  const configFactory = astroConfig.getViteConfig(
    {
      clearScreen: false,
      logLevel: 'silent',
      root: projectRoot,
      server: { middlewareMode: true },
    },
    { root: projectRoot },
  );
  const viteConfig = await configFactory({ command: 'serve', mode: 'development' });
  server = await viteRuntime.createServer(viteConfig);
  for (const event of ['add', 'change', 'unlink']) {
    server.watcher.on(event, (file) => {
      watcherEvents.push({
        event,
        file: relative(projectRoot, file).split(sep).join('/'),
        observedAt: Date.now(),
      });
    });
  }
  const inspection = await inspect();
  send({
    inspection,
    pid: process.pid,
    startupMs: Math.round((performance.now() - startedAt) * 10) / 10,
    type: 'ready',
  });
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  try {
    if (message.type === 'inspect') {
      send({ id: message.id, inspection: await inspect(), type: 'result' });
      return;
    }
    if (message.type === 'close') {
      const report = await closeWorker(message.reason ?? 'requested');
      send({ id: message.id, report, type: 'closed' });
      process.disconnect();
    }
  } catch (error) {
    send({ error: serializeError(error), id: message.id, type: 'error' });
  }
}

async function inspect() {
  if (!server || !createServerModuleRunner || !getDevCSSModuleName) {
    throw new Error('composition inspector is not ready');
  }
  const environment = server.environments.ssr;
  const { emitter, graph, pluginContainer } = readSsrEnvironment(environment);
  const client = readClientEnvironment(server.environments.client);

  const listenersBefore = emitter.listenerCount('send');
  const runner = readRunnerContract(createServerModuleRunner(environment));
  let inspectionError;
  let listenersConnected;
  let result;
  try {
    const routeModule = await runner.import('virtual:astro:routes');
    listenersConnected = emitter.listenerCount('send');
    const routes = readRouteEntries(routeModule);
    const contentModule = await runner.import('astro:content');
    if (typeof contentModule.getCollection !== 'function') {
      throw new Error(
        'AstroProjectAdapter private seam rejection: astro:content has no getCollection',
      );
    }
    const [blogEntries, homepageEntries] = await Promise.all([
      contentModule.getCollection('blog'),
      contentModule.getCollection('homepage'),
    ]);
    const configModule = await runner.import(join(projectRoot, 'src', 'content.config.ts'));
    const definitions = configModule.collections;
    if (!definitions || typeof definitions !== 'object') {
      throw new Error(
        'AstroProjectAdapter private seam rejection: content config has no collections object',
      );
    }
    const schemaNames = Object.entries(definitions)
      .filter(([, definition]) => definition?.schema !== undefined)
      .map(([name]) => name)
      .sort();
    const blogValidation = await definitions.blog?.schema?.safeParseAsync?.({
      tags: ['proof'],
      title: 'Valid proof entry',
    });
    if (blogValidation?.success !== true) {
      throw new Error('AstroProjectAdapter schema rejection: blog schema did not parse valid data');
    }

    const blogRoute = routes.find((route) => route.pattern === '/blog/[slug]');
    if (!blogRoute) {
      throw new Error('AstroProjectAdapter route rejection: /blog/[slug] is absent');
    }
    const routeModulePath = join(projectRoot, blogRoute.component);
    const pageModule = await runner.import(pathToFileURL(routeModulePath).href);
    if (typeof pageModule.getStaticPaths !== 'function') {
      throw new Error(
        'AstroProjectAdapter private seam rejection: blog route has no getStaticPaths export',
      );
    }
    const staticPaths = await pageModule.getStaticPaths({
      paginate: () => {
        throw new Error('proof route unexpectedly called paginate');
      },
      routePattern: blogRoute.pattern,
    });
    const renderedSlugs = [...staticPaths]
      .map((entry) => entry?.params?.slug)
      .filter((slug) => typeof slug === 'string')
      .sort();

    const indexRoute = routes.find((route) => route.pattern === '/');
    if (!indexRoute) throw new Error('AstroProjectAdapter route rejection: / is absent');
    const devCssId = getDevCSSModuleName(indexRoute.component);
    const devCssModule = await runner.import(devCssId);
    const cssEntries = readDevCssEntries(devCssModule);
    const resolvedDevCss = await pluginContainer.resolveId(devCssId);
    if (typeof resolvedDevCss?.id !== 'string') {
      throw new Error(
        `AstroProjectAdapter private seam rejection: cannot resolve ${devCssId} in SSR environment`,
      );
    }
    const devCssGraph = readTransformedModule(graph, resolvedDevCss.id);
    const pageUrl = `/${indexRoute.component.replace(/^\/+/, '')}`;
    const pageTransform = await client.transformRequest(pageUrl);
    if (!pageTransform?.code) {
      throw new Error(
        `AstroProjectAdapter private seam rejection: Vite client environment did not transform ${pageUrl}`,
      );
    }
    const compiledCssEntries = [];
    const clientCssGraph = [];
    for (const entry of cssEntries) {
      if (!entry.id.includes('?astro&type=style&index=')) {
        compiledCssEntries.push(entry);
        continue;
      }
      const transformed = await client.transformRequest(entry.url);
      if (!transformed?.code) {
        throw new Error(
          `AstroProjectAdapter private seam rejection: Vite client environment did not transform ${entry.url}`,
        );
      }
      const content = readViteClientCss(transformed.code);
      const [resolved, graphNodeByUrl] = await Promise.all([
        client.pluginContainer.resolveId(entry.url),
        client.moduleGraph.getModuleByUrl(entry.url),
      ]);
      if (typeof resolved?.id !== 'string') {
        throw new Error(
          `AstroProjectAdapter private seam rejection: Vite client environment cannot resolve ${entry.url}`,
        );
      }
      const graphModule = readTransformedModule(client.moduleGraph, resolved.id);
      if (graphNodeByUrl !== graphModule.node || graphModule.code !== transformed.code) {
        throw new Error(
          `AstroProjectAdapter private seam rejection: Vite client module graph does not own transformed ${entry.url}`,
        );
      }
      compiledCssEntries.push({ ...entry, content });
      clientCssGraph.push({
        cssContentBytes: Buffer.byteLength(content),
        id: projectRelativeId(resolved.id),
        transformedCodeBytes: Buffer.byteLength(transformed.code),
        url: entry.url,
        virtualEntryContentBytes: Buffer.byteLength(entry.content),
      });
    }
    const staticIndex = await buildStaticIndex(projectRoot);
    const payload = joinEffectiveSelectors(staticIndex, compiledCssEntries, {
      requiredScopedFiles: [indexRoute.component],
    });
    result = {
      content: {
        collections: {
          blog: blogEntries.map(projectEntry).sort(byId),
          homepage: homepageEntries.map(projectEntry).sort(byId),
        },
        schemaNames,
      },
      pair,
      privateSeams: {
        compiledCssEntries: cssEntries.map((entry) => ({
          contentBytes: Buffer.byteLength(entry.content),
          id: projectRelativeId(entry.id),
          url: entry.url,
        })),
        clientCssGraph,
        devCssModule: devCssId,
        moduleGraph: {
          id: projectRelativeId(resolvedDevCss.id),
          transformedCodeBytes: Buffer.byteLength(devCssGraph.code),
        },
        routeVirtualModule: 'virtual:astro:routes',
      },
      routes: {
        entries: routes,
        renderedSlugs,
      },
      runner: {
        isClosedBeforeClose: runner.isClosed(),
        listenersBefore,
        listenersConnected,
      },
      strategy,
      styles: { payload },
      watcherEvents: [...watcherEvents],
    };
  } catch (error) {
    inspectionError = error;
  }

  let cleanupError;
  let isClosedAfterClose = false;
  let listenersAfterClose;
  try {
    await runner.close();
    listenersAfterClose = emitter.listenerCount('send');
    isClosedAfterClose = runner.isClosed();
    if (listenersAfterClose !== listenersBefore) {
      throw new Error(
        `AstroProjectAdapter Vite runner cleanup rejection: send listeners changed from ${listenersBefore} to ${listenersAfterClose}`,
      );
    }
    if (!isClosedAfterClose) {
      throw new Error('AstroProjectAdapter Vite runner cleanup rejection: runner stayed open');
    }
  } catch (error) {
    cleanupError = error;
  }
  const attempt = {
    cleanupObserved: cleanupError === undefined,
    error: inspectionError instanceof Error ? inspectionError.message : undefined,
    isClosedAfterClose,
    listenersAfterClose,
    listenersBefore,
    listenersConnected,
    outcome: cleanupError ? 'cleanup-failed' : inspectionError ? 'inspection-rejected' : 'passed',
    sequence: runnerAttempts.length + 1,
  };
  runnerAttempts.push(attempt);
  if (cleanupError) {
    if (inspectionError) {
      throw new AggregateError(
        [inspectionError, cleanupError],
        'AstroProjectAdapter inspection and runner cleanup both failed',
      );
    }
    throw cleanupError;
  }
  if (inspectionError) throw inspectionError;

  result.runner = {
    ...result.runner,
    attempts: [...runnerAttempts],
    isClosedAfterClose,
    listenersAfterClose,
  };
  return result;
}

async function closeWorker(reason) {
  if (closing) return closing;
  closing = (async () => {
    const startedAt = performance.now();
    const compositionServerCreated = Boolean(server);
    if (server) await server.close();
    return {
      compositionServerCreated,
      compositionServerClosed: true,
      pid: process.pid,
      reason,
      shutdownMs: Math.round((performance.now() - startedAt) * 10) / 10,
      watcherEvents: [...watcherEvents],
    };
  })();
  return closing;
}

function projectEntry(entry) {
  return {
    body: typeof entry.body === 'string' ? entry.body.trim() : null,
    data: entry.data,
    filePath: entry.filePath ? projectRelativeId(entry.filePath) : null,
    id: entry.id,
  };
}

function projectRelativeId(id) {
  const normalized = String(id).split(sep).join('/');
  const normalizedRoot = projectRoot.split(sep).join('/');
  return normalized.replace(normalizedRoot, '<project>');
}

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function send(message) {
  process.send?.(message);
}

function serializeError(error) {
  return {
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
