import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { certifyProjectBeforeConfig } from './src/certification.mjs';
import { normalizePayload } from './src/parity.mjs';
import {
  findExecutable,
  readJsonLines,
  reservePort,
  runCommand,
  startAstroDev,
  startComposition,
  stopAstroDev,
  terminateAndReap,
  waitFor,
} from './src/process-control.mjs';

const proofRoot = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(proofRoot, 'fixture');
const repositoryRoot = dirname(dirname(proofRoot));
const reportPath = join(proofRoot, 'REPORT.json');
const certifiedPair = { astro: '7.2.10', vite: '8.2.2' };
const certifiedPairs = [certifiedPair];
const startedAt = performance.now();
const tempRoot = await mkdtemp(join(tmpdir(), 'astroix-issue-206-'));
let succeeded = false;
let proofCompleted = false;

const report = {
  artifact: 'AstroProjectAdapter current-stable and duplicate-hook proof',
  certifiedPair,
  checkedAt: new Date().toISOString(),
  environment: {
    arch: process.arch,
    node: process.version,
    platform: process.platform,
  },
  issue: 206,
  outcome: 'running',
  tempWorkspace: { deletedAfterSuccess: false, retainedAfterFailure: false },
};

try {
  const bun = await findExecutable('bun');
  const git = await findExecutable('git');
  report.environment.bun = (await runCommand(bun, ['--version'])).stdout.trim();
  await assertRepositoryBuildExists();
  const preservedOracleBefore = await fingerprintPreservedOracle(git);

  const gateProject = await prepareProject('pre-config-gate', bun);
  report.preConfigCertification = await provePreConfigCertification(gateProject);
  report.plainProject = await inspectPlainProject(gateProject);

  report.strategies = {};
  for (const strategy of ['attribute', 'where']) {
    report.strategies[strategy] = await proveStrategy(strategy, bun);
  }
  report.incompatibleDuplicateHook = await proveIncompatibleDuplicateHook(bun);
  const preservedOracleAfter = await fingerprintPreservedOracle(git);
  assert.deepEqual(preservedOracleAfter, preservedOracleBefore);
  report.preservedIntegrationOracle = { ...preservedOracleAfter, unchanged: true };

  report.durationMs = rounded(performance.now() - startedAt);
  report.outcome = 'passed';
  proofCompleted = true;
  await writeReport(report);
  await rm(tempRoot, { force: true, recursive: true });
  report.tempWorkspace.deletedAfterSuccess = true;
  await writeReport(report);
  succeeded = true;
  process.stdout.write(`PROOF_REPORT ${JSON.stringify(report)}\n`);
} catch (error) {
  const tempWorkspaceExists = await stat(tempRoot)
    .then(() => true)
    .catch(() => false);
  const artifactWriteFailure = proofCompleted && !tempWorkspaceExists;
  report.durationMs = rounded(performance.now() - startedAt);
  report.failure = serializeError(error);
  report.failureStage = artifactWriteFailure ? 'artifact-finalization' : 'proof';
  report.outcome = artifactWriteFailure ? 'artifact-write-failed' : 'failed';
  report.tempWorkspace.deletedAfterSuccess = proofCompleted && !tempWorkspaceExists;
  report.tempWorkspace.retainedAfterFailure = tempWorkspaceExists;
  if (tempWorkspaceExists) report.tempWorkspace.retainedPath = tempRoot;
  await writeReport(report).catch(() => {});
  process.stderr.write(`PROOF_REPORT ${JSON.stringify(report)}\n`);
  throw error;
} finally {
  if (!succeeded && report.tempWorkspace.retainedAfterFailure) {
    process.stderr.write(`Retained failing proof workspace: ${tempRoot}\n`);
  } else if (!succeeded) {
    process.stderr.write('Proof workspace was deleted before artifact finalization failed.\n');
  }
}

async function provePreConfigCertification(projectRoot) {
  let configImportStarted = false;
  const wrongPair = [{ astro: certifiedPair.astro, vite: '0.0.0-uncertified' }];
  let diagnostic;
  try {
    await certifyProjectBeforeConfig({ certifiedPairs: wrongPair, projectRoot }, async () => {
      configImportStarted = true;
      return import(pathToFileURL(join(projectRoot, 'astro.config.mjs')).href);
    });
    assert.fail('uncertified pair unexpectedly passed certification');
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error);
  }
  assert.equal(configImportStarted, false);
  assert.match(
    diagnostic,
    /detected astro@7\.2\.10 \+ vite@8\.2\.2; certified pairs: astro@7\.2\.10 \+ vite@0\.0\.0-uncertified/,
  );
  assert.match(
    diagnostic,
    /failed contract: exact Astro\/Vite pair certification must pass before project config executes/,
  );
  return {
    configImportStarted,
    detectedPair: certifiedPair,
    diagnostic,
    rejectedBeforeConfigImport: true,
  };
}

async function inspectPlainProject(projectRoot) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const config = await readFile(join(projectRoot, 'astro.config.mjs'), 'utf8');
  const dependencyNames = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  }).sort();
  assert.deepEqual(dependencyNames, ['astro', 'vite']);
  assert.equal(config.includes('astroix()'), false);
  assert.equal(config.includes('@wojciechpiskorz/astroix'), false);
  const controlArtifacts = await astroixControlArtifacts(projectRoot);
  assert.deepEqual(controlArtifacts, []);
  return {
    astroixDependencyAbsent: true,
    astroixIntegrationAbsent: true,
    dependencyNames,
    hiddenControlArtifacts: controlArtifacts,
    projectOwnedObservableIntegration: true,
  };
}

async function proveStrategy(strategy, bun) {
  const managedRoot = await prepareProject(`${strategy}-managed`, bun);
  const oracleRoot = await prepareProject(`${strategy}-oracle`, bun);
  const managedTreeBefore = await fingerprintProjectTree(managedRoot);
  const hookLog = join(tempRoot, `${strategy}-duplicate-hooks.jsonl`);
  const oracleHookLog = join(tempRoot, `${strategy}-oracle-hooks.jsonl`);
  await writeOracleConfig(oracleRoot);

  const managedPort = await reservePort();
  const oraclePort = await reservePort();
  let browser;
  let composition;
  let managed;
  let oracle;
  let normalCompositionClose;
  let normalManagedClose;
  let normalOracleClose;

  try {
    managed = await startAstroDev({
      env: projectEnvironment(managedRoot, strategy, 'managed', hookLog),
      port: managedPort,
      projectRoot: managedRoot,
    });
    composition = startComposition({
      env: projectEnvironment(managedRoot, strategy, 'composition', hookLog),
      projectRoot: managedRoot,
    });
    const ready = await composition.ready;

    oracle = await startAstroDev({
      env: projectEnvironment(oracleRoot, strategy, 'oracle', oracleHookLog),
      port: oraclePort,
      projectRoot: oracleRoot,
    });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const managedPage = await context.newPage();
    const oraclePage = await context.newPage();
    await managedPage.goto(`http://127.0.0.1:${managedPort}/`);
    await oraclePage.goto(`http://127.0.0.1:${oraclePort}/?builder=0`);

    const inspection = await composition.inspect();
    assertInspection(inspection, strategy);
    await assertRenderedContent(managedPort, managedPage, inspection);

    const oraclePayload = await readOraclePayload(oraclePage);
    const adapterPayload = inspection.styles.payload;
    assert.deepEqual(normalizePayload(adapterPayload), normalizePayload(oraclePayload));
    const selectorApplications = await compareSelectorApplications(
      managedPage,
      oraclePage,
      adapterPayload,
      oraclePayload,
    );
    const hooks = await assertCompatibleDuplicateHooks(hookLog, managedRoot, managed, composition);
    const invalidation = await proveInvalidation(managedRoot, managedPage, composition, inspection);

    normalCompositionClose = await composition.close('strategy-complete');
    normalOracleClose = await stopAstroDev(oracle, 'strategy-complete');
    normalManagedClose = await stopAstroDev(managed, 'strategy-complete');
    await browser.close();
    browser = undefined;

    assert.equal(normalCompositionClose.compositionServerClosed, true);
    assert.equal(normalCompositionClose.exit.code, 0);
    assert.equal(normalManagedClose.forced, false);
    assert.equal(normalManagedClose.portClosed, true);
    assert.equal(normalOracleClose.forced, false);
    assert.equal(normalOracleClose.portClosed, true);
    const controlArtifacts = await astroixControlArtifacts(managedRoot);
    assert.deepEqual(controlArtifacts, []);
    const managedTreeAfter = await fingerprintProjectTree(managedRoot);
    const managedProjectMutation = assertExpectedProjectMutation(
      managedTreeBefore,
      managedTreeAfter,
      ['src/pages/index.astro'],
    );

    return {
      adapter: summarizeInspection(inspection),
      certifiedPair: inspection.pair,
      duplicateHookExecution: hooks,
      invalidation,
      lifecycle: {
        composition: lifecycleSummary(normalCompositionClose),
        managed: lifecycleSummary(normalManagedClose, managed.startupMs),
        oracle: lifecycleSummary(normalOracleClose, oracle.startupMs),
      },
      oracle: {
        disposableCopy: true,
        preservedIntegrationPayloadRecords: oraclePayload.length,
      },
      plainManagedProject: {
        hiddenControlArtifacts: controlArtifacts,
        mutation: managedProjectMutation,
      },
      parity: {
        normalizedPayloadEqual: true,
        selectorApplications,
      },
      strategy,
      startup: {
        compositionMs: ready.startupMs,
        managedMs: managed.startupMs,
        oracleMs: oracle.startupMs,
      },
    };
  } finally {
    await browser?.close().catch(() => {});
    if (composition && !normalCompositionClose) {
      await composition.close('strategy-failure').catch(() => terminateAndReap(composition));
    }
    if (oracle && !normalOracleClose) {
      await stopAstroDev(oracle, 'strategy-failure').catch(() => terminateAndReap(oracle));
    }
    if (managed && !normalManagedClose) {
      await stopAstroDev(managed, 'strategy-failure').catch(() => terminateAndReap(managed));
    }
  }
}

async function proveIncompatibleDuplicateHook(bun) {
  const projectRoot = await prepareProject('incompatible-duplicate', bun);
  const hookLog = join(tempRoot, 'incompatible-duplicate-hooks.jsonl');
  const exclusivePath = join(tempRoot, 'exclusive-project-resource');
  const port = await reservePort();
  const managed = await startAstroDev({
    env: projectEnvironment(projectRoot, 'attribute', 'managed', hookLog, {
      ASTROIX_PROOF_EXCLUSIVE_PATH: exclusivePath,
      ASTROIX_PROOF_INTEGRATION_MODE: 'exclusive',
    }),
    port,
    projectRoot,
  });
  let composition;
  let compositionFailure;
  let diagnostic;
  let managedClose;
  try {
    composition = startComposition({
      env: projectEnvironment(projectRoot, 'attribute', 'composition', hookLog, {
        ASTROIX_PROOF_EXCLUSIVE_PATH: exclusivePath,
        ASTROIX_PROOF_INTEGRATION_MODE: 'exclusive',
      }),
      projectRoot,
    });
    try {
      await composition.ready;
      assert.fail('incompatible duplicate hook unexpectedly started the composition inspector');
    } catch (error) {
      diagnostic = error instanceof Error ? error.message : String(error);
      compositionFailure = error?.proofPayload;
    }
    assert.match(
      diagnostic,
      new RegExp(
        `proof integration incompatible duplicate hook: exclusive side effect already claimed at ${escapeRegExp(exclusivePath)}`,
      ),
    );
    const exit = await composition.exit;
    assert.notEqual(exit.code, 0);
    assert.equal(compositionFailure?.cleanup?.compositionServerClosed, true);
    assert.equal(compositionFailure?.cleanup?.reason, 'startup-failure');
    const hooks = await readJsonLines(hookLog);
    const configHooks = hooks.filter((event) => event.hook === 'astro:config:setup');
    assert.deepEqual(
      configHooks.map((event) => event.role),
      ['managed', 'composition'],
    );
    assert.ok(configHooks.every((event) => event.processLocalConfigSetupCount === 1));
    assert.equal((await readFile(exclusivePath, 'utf8')).trim(), `managed:${managed.pid}`);
    managedClose = await stopAstroDev(managed, 'incompatible-duplicate-proved');
    return {
      compositionCleanup: compositionFailure.cleanup,
      compositionExit: exit,
      diagnostic,
      exactFailureSurfaced: true,
      hooks: configHooks.map(({ pid, processLocalConfigSetupCount, role }) => ({
        pid,
        processLocalConfigSetupCount,
        role,
      })),
      managedLifecycle: lifecycleSummary(managedClose, managed.startupMs),
      resourceOwner: 'managed',
    };
  } finally {
    if (
      composition &&
      composition.child.exitCode === null &&
      composition.child.signalCode === null
    ) {
      await terminateAndReap(composition);
    }
    if (!managedClose) {
      await stopAstroDev(managed, 'incompatible-proof-failure').catch(() =>
        terminateAndReap(managed),
      );
    }
  }
}

async function proveInvalidation(projectRoot, page, composition, initialInspection) {
  const sourcePath = join(projectRoot, 'src', 'pages', 'index.astro');
  const source = await readFile(sourcePath, 'utf8');
  const replacement = `.hero-lead {\n    color: rgb(12, 34, 56);\n  }`;
  assert.match(source, /\/\* ASTROIX_PROOF_STYLE_INSERT \*\//);
  const documentToken = await page.evaluate(() => {
    window.__astroixProofDocumentToken = crypto.randomUUID();
    return window.__astroixProofDocumentToken;
  });
  await writeFile(sourcePath, source.replace('/* ASTROIX_PROOF_STYLE_INSERT */', replacement));

  const transientSnapshotRejections = [];
  const updated = await waitFor(
    async () => {
      try {
        return await composition.inspect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          /compiled CSS rule count \d+ does not match static scoped rule count \d+/.test(message)
        ) {
          transientSnapshotRejections.push(message);
          return false;
        }
        throw error;
      }
    },
    (inspection) => {
      if (!inspection) return false;
      const lead = inspection.styles.payload.find(
        (record) => record.scoped && record.selector === '.hero-lead',
      );
      return lead?.effectiveSelector ? inspection : false;
    },
    'composition invalidation and fresh-runner re-inspection',
    15_000,
    150,
  );
  await waitFor(
    () =>
      page
        .locator('[data-proof-node="lead"]')
        .evaluate((element) => getComputedStyle(element).color),
    (color) => color === 'rgb(12, 34, 56)',
    'managed Astro HMR style update',
    15_000,
    100,
  );
  const tokenAfterHmr = await page.evaluate(() => window.__astroixProofDocumentToken);
  assert.equal(tokenAfterHmr, documentToken);
  assert.ok(
    updated.watcherEvents.some(
      (event) => event.event === 'change' && event.file === 'src/pages/index.astro',
    ),
  );
  assert.equal(
    initialInspection.styles.payload.some(
      (record) => record.selector === '.hero-lead' && record.scoped,
    ),
    false,
  );
  const lead = updated.styles.payload.find(
    (record) => record.selector === '.hero-lead' && record.scoped,
  );
  assert.ok(lead?.effectiveSelector);
  assert.equal(updated.runner.isClosedAfterClose, true);
  return {
    browserDocumentPreserved: tokenAfterHmr === documentToken,
    effectiveSelector: lead.effectiveSelector,
    freshRunnerClosed: updated.runner.isClosedAfterClose,
    runnerAttempts: updated.runner.attempts,
    sourceChangeObserved: true,
    transientSnapshotRejections,
    watcherEvents: updated.watcherEvents,
  };
}

async function assertRenderedContent(port, page, inspection) {
  assert.deepEqual(inspection.content.schemaNames, ['blog', 'homepage']);
  assert.deepEqual(
    inspection.content.collections.blog.map((entry) => entry.id),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    inspection.content.collections.homepage.map((entry) => entry.id),
    ['index'],
  );
  assert.deepEqual(inspection.routes.renderedSlugs, ['alpha', 'beta']);
  assert.ok(inspection.routes.entries.some((route) => route.pattern === '/'));
  assert.ok(inspection.routes.entries.some((route) => route.pattern === '/blog/[slug]'));
  assert.equal(await page.locator('[data-proof-node="title"]').textContent(), 'Adapter proof');
  assert.equal(
    await page.locator('[data-proof-node="lead"]').textContent(),
    'The project remains plain.',
  );
  for (const [slug, title] of [
    ['alpha', 'Alpha entry'],
    ['beta', 'Beta entry'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/blog/${slug}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`<h1[^>]*>${title}</h1>`));
  }
}

function assertInspection(inspection, strategy) {
  assert.deepEqual(inspection.pair, certifiedPair);
  assert.equal(inspection.strategy, strategy);
  assert.equal(inspection.runner.isClosedBeforeClose, false);
  assert.equal(inspection.runner.isClosedAfterClose, true);
  assert.equal(inspection.runner.listenersBefore, inspection.runner.listenersAfterClose);
  assert.ok(inspection.runner.listenersConnected > inspection.runner.listenersBefore);
  const listenerBaseline = inspection.runner.attempts[0]?.listenersBefore;
  assert.equal(typeof listenerBaseline, 'number');
  assert.ok(
    inspection.runner.attempts.every(
      (attempt) =>
        attempt.cleanupObserved &&
        attempt.isClosedAfterClose &&
        attempt.listenersBefore === listenerBaseline &&
        attempt.listenersAfterClose === listenerBaseline,
    ),
  );
  assert.ok(inspection.privateSeams.compiledCssEntries.length > 0);
  assert.ok(inspection.privateSeams.clientCssGraph.length > 0);
  assert.ok(
    inspection.privateSeams.clientCssGraph.every(
      (entry) => entry.cssContentBytes > 0 && entry.transformedCodeBytes > 0,
    ),
  );
  assert.ok(inspection.privateSeams.moduleGraph.transformedCodeBytes > 0);
  assert.equal(inspection.privateSeams.routeVirtualModule, 'virtual:astro:routes');
  const scoped = inspection.styles.payload.find(
    (record) => record.scoped && record.selector === '.hero-title',
  );
  assert.ok(scoped?.effectiveSelector);
  if (strategy === 'attribute') {
    assert.match(scoped.effectiveSelector, /\.hero-title\[data-astro-cid-[a-z0-9]+\]/);
  } else {
    assert.match(scoped.effectiveSelector, /\.hero-title:where\(\.astro-[a-z0-9]+\)/);
  }
}

async function readOraclePayload(page) {
  return waitFor(
    async () => {
      const response = await page.evaluate(async () => {
        const result = await fetch('/__astroix/index');
        return { payload: await result.json(), status: result.status };
      });
      assert.equal(response.status, 200);
      return response.payload;
    },
    (payload) =>
      Array.isArray(payload) &&
      payload.some((record) => record.scoped && typeof record.effectiveSelector === 'string')
        ? payload
        : false,
    'preserved integration oracle payload',
    10_000,
    200,
  );
}

async function compareSelectorApplications(managedPage, oraclePage, adapterPayload, oraclePayload) {
  const normalizedAdapter = normalizePayload(adapterPayload);
  const normalizedOracle = normalizePayload(oraclePayload);
  const adapterApplications = await selectorApplications(managedPage, normalizedAdapter);
  const oracleApplications = await selectorApplications(oraclePage, normalizedOracle);
  assert.deepEqual(adapterApplications, oracleApplications);
  return adapterApplications;
}

async function selectorApplications(page, payload) {
  const applications = [];
  for (const record of payload) {
    const selector = record.scoped ? record.effectiveSelector : record.selector;
    assert.ok(selector, `no effective selector for scoped record ${record.file}:${record.line}`);
    const renderedSelector = selector.includes('<scope>')
      ? selector.replaceAll('<scope>', await scopeToken(page, selector))
      : selector;
    const nodes = await page.evaluate((query) => {
      return [...document.querySelectorAll(query)]
        .map((element) => element.getAttribute('data-proof-node'))
        .filter(Boolean)
        .sort();
    }, renderedSelector);
    applications.push({
      file: record.file,
      line: record.line,
      nodes,
      selector: record.scoped ? normalizePayload([record])[0].effectiveSelector : selector,
    });
  }
  return applications;
}

async function scopeToken(page, selector) {
  const tokens = await page.locator('[data-proof-node="title"]').evaluate((element) => {
    const attribute = element
      .getAttributeNames()
      .find((name) => name.startsWith('data-astro-cid-'));
    const className = [...element.classList].find((name) => name.startsWith('astro-'));
    return {
      attribute: attribute?.slice('data-astro-cid-'.length),
      className: className?.slice('astro-'.length),
    };
  });
  const token = selector.includes('data-astro-cid-') ? tokens.attribute : tokens.className;
  if (!token) throw new Error(`rendered proof title has no scope token for ${selector}`);
  return token;
}

async function assertCompatibleDuplicateHooks(hookLog, projectRoot, managed, composition) {
  const hooks = await readJsonLines(hookLog);
  const configHooks = hooks.filter((event) => event.hook === 'astro:config:setup');
  assert.equal(configHooks.length, 2);
  assert.deepEqual(configHooks.map((event) => event.role).sort(), ['composition', 'managed']);
  assert.deepEqual(
    new Set(configHooks.map((event) => event.pid)),
    new Set([managed.pid, composition.pid]),
  );
  assert.ok(configHooks.every((event) => event.cwd === projectRoot));
  assert.ok(configHooks.every((event) => event.processLocalConfigSetupCount === 1));
  assert.ok(
    configHooks.every((event) => event.projectRoot === pathToFileURL(`${projectRoot}/`).href),
  );
  return {
    compatibleNonIdempotentAppendSucceeded: true,
    configHookExecutions: configHooks.map(({ hook, pid, processLocalConfigSetupCount, role }) => ({
      hook,
      pid,
      processLocalConfigSetupCount,
      role,
    })),
    executions: 2,
    meaning: 'one project-owned config hook in each separate real Astro execution',
  };
}

function summarizeInspection(inspection) {
  return {
    content: {
      collectionIds: Object.fromEntries(
        Object.entries(inspection.content.collections).map(([name, entries]) => [
          name,
          entries.map((entry) => entry.id),
        ]),
      ),
      schemaNames: inspection.content.schemaNames,
    },
    privateSeams: inspection.privateSeams,
    routes: inspection.routes,
    runner: inspection.runner,
    stylePayloadRecords: inspection.styles.payload.length,
  };
}

function lifecycleSummary(close, startupMs) {
  return {
    exit: close.exit,
    forced: close.forced ?? false,
    pid: close.pid,
    portClosed: close.portClosed,
    serverClosed: close.compositionServerClosed,
    shutdownMs: close.shutdownMs,
    startupMs,
  };
}

async function prepareProject(name, bun) {
  const destination = join(tempRoot, name);
  await cp(fixtureRoot, destination, {
    filter: (source) => {
      const fromFixture = relative(fixtureRoot, source).split(sep)[0];
      return !['.astro', 'node_modules'].includes(fromFixture);
    },
    recursive: true,
  });
  await runCommand(bun, ['install', '--frozen-lockfile'], { cwd: destination });
  return realpath(destination);
}

function projectEnvironment(projectRoot, strategy, role, hookLog, extra = {}) {
  return {
    ...process.env,
    ...extra,
    // Astro 7.2.10 auto-backgrounds under detected coding agents unless this
    // internal marker is present. A truthy marker with no --background flag
    // keeps this explicitly managed child in the foreground.
    ASTRO_DEV_BACKGROUND: '0',
    ASTROIX_PROOF_CERTIFIED_PAIRS: JSON.stringify(certifiedPairs),
    ASTROIX_PROOF_HOOK_LOG: hookLog,
    ASTROIX_PROOF_PROJECT_ROOT: projectRoot,
    ASTROIX_PROOF_ROLE: role,
    ASTROIX_PROOF_STRATEGY: strategy,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

async function writeOracleConfig(projectRoot) {
  const integrationUrl = pathToFileURL(join(repositoryRoot, 'dist', 'index.js')).href;
  const source = `import { defineConfig } from 'astro/config';
import astroix from ${JSON.stringify(integrationUrl)};
import { observableIntegration } from './proof-integration.mjs';

const strategy = process.env.ASTROIX_PROOF_STRATEGY ?? 'attribute';

export default defineConfig({
  ...(strategy === 'where' ? { scopedStyleStrategy: 'where' } : {}),
  vite: { server: { strictPort: true } },
  integrations: [
    observableIntegration({
      hookLog: process.env.ASTROIX_PROOF_HOOK_LOG,
      mode: 'append',
      role: process.env.ASTROIX_PROOF_ROLE ?? 'oracle',
    }),
    astroix(),
  ],
});
`;
  await writeFile(join(projectRoot, 'astro.config.mjs'), source);
}

async function assertRepositoryBuildExists() {
  const distIndex = join(repositoryRoot, 'dist', 'index.js');
  const distChrome = join(repositoryRoot, 'dist', 'chrome.js');
  for (const path of [distIndex, distChrome]) {
    const details = await stat(path).catch(() => null);
    assert.ok(details?.isFile(), `missing proof prerequisite ${path}; run bun run build first`);
  }
}

async function fingerprintPreservedOracle(git) {
  const listed = await runCommand(
    git,
    ['ls-files', '-z', '--', 'src', 'e2e/fixture', 'e2e/*.spec.ts'],
    { cwd: repositoryRoot },
  );
  const files = listed.stdout.split('\0').filter(Boolean).sort();
  assert.ok(files.length > 0, 'preserved integration oracle pathspec matched no tracked files');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(repositoryRoot, file)));
    hash.update('\0');
  }
  return { fileCount: files.length, sha256: hash.digest('hex') };
}

async function fingerprintProjectTree(projectRoot) {
  const records = [];
  await walk(projectRoot);
  records.sort((left, right) => left.path.localeCompare(right.path));
  const treeHash = createHash('sha256');
  for (const record of records) {
    treeHash.update(record.path);
    treeHash.update('\0');
    treeHash.update(record.sha256);
    treeHash.update('\0');
  }
  return {
    files: Object.fromEntries(records.map((record) => [record.path, record.sha256])),
    sha256: treeHash.digest('hex'),
  };

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.astro') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const projectPath = relative(projectRoot, path).split(sep).join('/');
        records.push({
          path: projectPath,
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        });
      }
    }
  }
}

function assertExpectedProjectMutation(before, after, allowedChangedPaths) {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  const changedPaths = paths.filter((path) => before.files[path] !== after.files[path]);
  assert.deepEqual(changedPaths, [...allowedChangedPaths].sort());
  return {
    afterSha256: after.sha256,
    beforeSha256: before.sha256,
    changedPaths,
    excludedGeneratedDirectories: ['.astro', 'node_modules'],
    unexpectedMutations: [],
  };
}

async function astroixControlArtifacts(projectRoot, directory = projectRoot) {
  const artifacts = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.astro') continue;
    const path = join(directory, entry.name);
    const projectPath = relative(projectRoot, path).split(sep).join('/');
    if (/^(?:.*\/)?(?:\.?astroix(?:$|[-_.])|__astroix)/i.test(projectPath)) {
      artifacts.push(projectPath);
    }
    if (entry.isDirectory()) artifacts.push(...(await astroixControlArtifacts(projectRoot, path)));
  }
  return artifacts.sort();
}

async function writeReport(value) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(value, null, 2)}\n`);
  await runCommand(
    join(repositoryRoot, 'node_modules', '.bin', 'biome'),
    ['format', '--write', reportPath],
    { cwd: repositoryRoot },
  );
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'NonError',
    stack: error instanceof Error ? error.stack : undefined,
  };
}
