import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { release as osRelease, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from '@playwright/test';

import { assemblePackagedApp } from './src/package-app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROOF_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(ROOT, 'spikes', 'issue-198-runtime-spine', 'plain-project');
const ELECTRON = {
  version: '44.1.0',
  platform: 'darwin',
  arch: 'arm64',
  sha256: '9e624a8c44dee2792a532551f224ec8b8649b654a0e039416164fbf620888512',
};
const ORIGINAL_COLOR = 'rgb(10, 20, 30)';
const EDITED_COLOR = 'rgb(40, 50, 60)';

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('listener did not expose a TCP port'));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

async function reservePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function commandOutput(command, args, options = {}) {
  const { timeoutMs = 20_000, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const result = await new Promise((resolvePromise, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, timedOut });
    });
  });
  return { ...result, stdout, stderr };
}

async function copyManagedProject(parent, name, title, { dependencies = true } = {}) {
  const project = join(parent, name);
  await cp(FIXTURE, project, {
    recursive: true,
    filter: (source) => !['.astro', 'node_modules'].includes(basename(source)),
  });
  if (dependencies) await symlink(join(ROOT, 'node_modules'), join(project, 'node_modules'), 'dir');
  const pagePath = join(project, 'site', 'pages', 'home.astro');
  const page = await readFile(pagePath, 'utf8');
  await writeFile(pagePath, page.replace('Runtime spine', title));
  return {
    key: name,
    root: project,
    sourceFile: pagePath,
    base: '/lab',
    sourceDirectory: 'site',
    scopedStyleStrategy: 'where',
  };
}

async function createProjects(tempRoot) {
  await mkdir(tempRoot, { recursive: true });
  const alpha = await copyManagedProject(
    tempRoot,
    'alpha project ; $shell poison',
    'Alpha project',
  );
  alpha.key = 'alpha';
  alpha.switchTarget = 'beta';
  const beta = await copyManagedProject(tempRoot, 'beta-project', 'Beta project');
  beta.key = 'beta';
  beta.switchTarget = 'alpha';
  const rollback = await copyManagedProject(tempRoot, 'rollback-project', 'Rollback project');
  rollback.key = 'rollback';
  const timeout = await copyManagedProject(tempRoot, 'timeout-project', 'Timeout project');
  timeout.key = 'timeout';
  timeout.commandPathOverride = join(timeout.root, 'non-listening-astro.mjs');
  await writeFile(timeout.commandPathOverride, 'setInterval(() => {}, 1_000);\n');
  const composition = await copyManagedProject(
    tempRoot,
    'composition-failure-project',
    'Composition failure project',
  );
  composition.key = 'composition';
  composition.terminationMode = 'composition-fail';
  const forced = await copyManagedProject(tempRoot, 'forced-stop-project', 'Forced stop project');
  forced.key = 'forced';
  forced.terminationMode = 'ignore-term';
  const missing = await copyManagedProject(
    tempRoot,
    'missing-local-astro-project',
    'Missing Astro project',
    { dependencies: false },
  );
  missing.key = 'missing';
  return { alpha, beta, rollback, timeout, composition, forced, missing };
}

async function createPoisonedPath(tempRoot) {
  const directory = join(tempRoot, 'poisoned interactive path');
  const sentinel = join(tempRoot, 'PATH-WAS-USED');
  await mkdir(directory, { recursive: true });
  for (const name of ['node', 'astro', 'sh']) {
    const path = join(directory, name);
    await writeFile(path, `#!/bin/sh\necho ${name} >> ${JSON.stringify(sentinel)}\nexit 97\n`);
    await chmod(path, 0o755);
  }
  return { directory, sentinel };
}

async function writeConfig(tempRoot, name, projects, fixedPort, overrides = {}) {
  const directory = join(tempRoot, name);
  const registryDir = join(directory, 'registry');
  const userDataDir = join(directory, 'user-data');
  const tracePath = join(directory, 'trace.jsonl');
  const path = join(directory, 'proof-config.json');
  await Promise.all([
    mkdir(registryDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ]);
  const config = {
    allowProofOnlyStaleLockRecovery: true,
    fixedPort,
    initialProjectKey: 'alpha',
    projects: Object.values(projects).map(({ sourceFile: _sourceFile, ...project }) => project),
    registryDir,
    startupTimeoutMs: 10_000,
    terminationGraceMs: 300,
    tracePath,
    userDataDir,
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { config, path };
}

async function readTrace(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessesGone(pids, label) {
  await waitFor(
    () => pids.filter((pid) => processExists(pid)),
    (remaining) => remaining.length === 0,
    label,
    10_000,
  );
}

async function isPortOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = new Socket();
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    const closed = () => {
      socket.destroy();
      resolvePromise(false);
    };
    socket.once('error', closed);
    socket.once('timeout', closed);
    socket.connect(port, '127.0.0.1');
  });
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) =>
    child.once('exit', (code, signal) => resolvePromise({ code, signal })),
  );
}

async function invoke(application, type, payload = {}) {
  return application.evaluate(
    (_electron, { command, input }) => globalThis.__astroixProof.request(command, input),
    { command: type, input: payload },
  );
}

async function launchPackaged(packaged, configPath, poisonedPath) {
  const launchStartedAt = performance.now();
  const application = await electron.launch({
    executablePath: packaged.executablePath,
    env: {
      ...process.env,
      ASTROIX_PROOF_CONFIG: configPath,
      ASTROIX_PROOF_SECRET: 'must-not-cross-the-main-boundary',
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      NODE_OPTIONS: '--trace-warnings',
      PATH: poisonedPath,
    },
  });
  await application.evaluate(async () => globalThis.__astroixProof.ready);
  return { application, startupMs: performance.now() - launchStartedAt };
}

async function processFamily(rootPid) {
  const result = await commandOutput('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command=']);
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: match[4],
    }));
  const family = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => family.has(row.pid));
}

async function packageEvidence(packaged) {
  const [verify, display, executable, quarantine, gatekeeper] = await Promise.all([
    commandOutput('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      packaged.appPath,
    ]),
    commandOutput('/usr/bin/codesign', ['-dv', '--verbose=4', packaged.appPath]),
    commandOutput('/usr/bin/file', [packaged.executablePath]),
    commandOutput('/usr/bin/xattr', ['-p', 'com.apple.quarantine', packaged.appPath]),
    commandOutput('/usr/sbin/spctl', [
      '--assess',
      '--type',
      'execute',
      '--verbose=4',
      packaged.appPath,
    ]),
  ]);
  assert.equal(verify.code, 0, verify.stderr);
  assert.match(display.stderr, /Signature=adhoc/);
  assert.match(executable.stdout, /Mach-O 64-bit executable arm64/);
  return {
    architecture: executable.stdout.trim(),
    codesign: display.stderr.trim().split('\n').filter(Boolean),
    distributionSignature: 'none',
    gatekeeper: {
      code: gatekeeper.code,
      output: `${gatekeeper.stdout}${gatekeeper.stderr}`.trim(),
    },
    notarized: false,
    quarantineAttributePresent: quarantine.code === 0,
  };
}

async function assertLiveSecurity(application, page, fixedPort) {
  const status = await application.evaluate(() => globalThis.__astroixProof.status());
  const preferences = status.windowPreferences;
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.nodeIntegrationInWorker, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.webviewTag, false);
  assert.equal(preferences.preload, undefined);

  const appCapabilities = await page.evaluate(() => ({
    electron: typeof globalThis.electron,
    ipc: typeof globalThis.ipcRenderer,
    process: typeof globalThis.process,
    require: typeof globalThis.require,
  }));
  const canvasCapabilities = await page
    .frameLocator('#canvas')
    .locator('body')
    .evaluate(() => ({
      electron: typeof globalThis.electron,
      ipc: typeof globalThis.ipcRenderer,
      parentHeading: parent.document.querySelector('h1')?.textContent,
      process: typeof globalThis.process,
      require: typeof globalThis.require,
    }));
  assert.deepEqual(appCapabilities, {
    electron: 'undefined',
    ipc: 'undefined',
    process: 'undefined',
    require: 'undefined',
  });
  assert.deepEqual(canvasCapabilities, {
    electron: 'undefined',
    ipc: 'undefined',
    parentHeading: 'Astroix packaged-host proof',
    process: 'undefined',
    require: 'undefined',
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const iframe = document.querySelector('#canvas');
      return {
        directDocument: iframe.contentDocument !== null,
        iframeOrigin: iframe.contentWindow.location.origin,
        parentOrigin: location.origin,
      };
    }),
    {
      directDocument: true,
      iframeOrigin: `http://alpha.localhost:${fixedPort}`,
      parentOrigin: `http://alpha.localhost:${fixedPort}`,
    },
  );

  const permission = await page.evaluate(
    () =>
      new Promise((resolvePromise) => {
        navigator.geolocation.getCurrentPosition(
          () => resolvePromise('allowed'),
          (error) => resolvePromise(`denied:${error.code}`),
          { timeout: 1_000 },
        );
      }),
  );
  assert.match(permission, /^denied:/);
  assert.equal(
    await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
    ),
    'denied',
  );
  await waitFor(
    () => application.evaluate(() => globalThis.__astroixProof.status().denied),
    (denied) => denied.requests.length > 0 && denied.checks.length > 0,
    'both Electron permission denial handlers',
  );

  assert.equal(await page.evaluate(() => window.open('https://example.com/') === null), true);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.com/blank';
    link.target = '_blank';
    document.body.append(link);
    link.click();
  });
  await waitFor(
    () => application.evaluate(() => globalThis.__astroixProof.status()),
    (next) => next.denied.popups.length >= 2 && next.windowCount === 1,
    'popup and target=_blank denial',
  );
  assert.equal(
    await page.evaluate(() => {
      const webview = document.createElement('webview');
      document.body.append(webview);
      return typeof webview.getWebContentsId;
    }),
    'undefined',
  );

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'data:text/plain,blocked-download';
    link.download = 'blocked.txt';
    document.body.append(link);
    link.click();
  });
  await waitFor(
    () => application.evaluate(() => globalThis.__astroixProof.status().denied.downloads),
    (downloads) => downloads.length > 0,
    'download denial',
  );

  const originalUrl = page.url();
  for (const target of [
    'https://example.com/',
    `http://wrong.localhost:${fixedPort}/__astroix/app/`,
    'file:///etc/passwd',
    'data:text/html,blocked',
  ]) {
    await page.evaluate((url) => location.assign(url), target);
    await delay(100);
    assert.equal(page.url(), originalUrl);
  }
  assert.equal(
    await page.evaluate(() => {
      globalThis.__javascriptNavigationExecuted = false;
      location.assign('javascript:globalThis.__javascriptNavigationExecuted=true');
      return globalThis.__javascriptNavigationExecuted;
    }),
    false,
  );
  assert.equal(
    await page.evaluate(async () =>
      fetch('/__astroix/control/probe-edit', { method: 'POST' }).then(
        (response) => response.status,
      ),
    ),
    204,
  );
  await page.evaluate(() => {
    const probe = document.createElement('iframe');
    probe.id = 'external-canvas-probe';
    probe.src = 'https://example.com/external-canvas';
    document.body.append(probe);
  });
  await waitFor(
    () => application.evaluate(() => globalThis.__astroixProof.status()),
    (next) => next.denied.frames.length > 0 && next.editingEnabled === false,
    'external canvas denial and edit revocation',
  );
  await waitFor(
    () =>
      page.evaluate(async () =>
        fetch('/__astroix/control/probe-edit', { method: 'POST' }).then(
          (response) => response.status,
        ),
      ),
    (statusCode) => statusCode === 423,
    'representative edit operation denial after authority revocation',
  );
  await page.evaluate(() => {
    document.querySelector('#external-canvas-probe')?.remove();
  });
}

async function exerciseHmr(page, sourceFile, tracePath, fixedPort) {
  const frame = page.frameLocator('#canvas');
  const original = await readFile(sourceFile, 'utf8');
  const loadsBefore = await frame.locator('body').evaluate(() => globalThis.__runtimeSpineLoads);
  try {
    await writeFile(sourceFile, original.replace(ORIGINAL_COLOR, EDITED_COLOR));
    await waitFor(
      () => frame.locator('.hero-title').evaluate((element) => getComputedStyle(element).color),
      (color) => color === EDITED_COLOR,
      'packaged same-origin CSS HMR',
    );
    assert.equal(
      await frame.locator('body').evaluate(() => globalThis.__runtimeSpineLoads),
      loadsBefore,
    );
  } finally {
    await writeFile(sourceFile, original);
  }
  const upgrade = await waitFor(
    async () =>
      (await readTrace(tracePath)).find((entry) => entry.event === 'raw-websocket-upgrade'),
    Boolean,
    'raw Vite HMR upgrade observation',
  );
  assert.equal(upgrade.host, `alpha.localhost:${fixedPort}`);
  assert.equal(upgrade.origin, `http://alpha.localhost:${fixedPort}`);
  assert.equal(upgrade.protocol, 'vite-hmr');
  assert.match(upgrade.url, /token=/);
  assert.equal(upgrade.upstreamStatusLine, 'HTTP/1.1 101 Switching Protocols');
  return upgrade;
}

async function exerciseExclusivity({ application, packaged, configEntry, tempRoot, poisonedPath }) {
  const second = await commandOutput(packaged.executablePath, [], {
    env: {
      ...process.env,
      ASTROIX_PROOF_CONFIG: configEntry.path,
      ELECTRON_ENABLE_SECURITY_WARNINGS: 'true',
      PATH: poisonedPath,
    },
  });
  assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
  await waitFor(
    async () => readTrace(configEntry.config.tracePath),
    (events) =>
      events.some((entry) => entry.event === 'second-instance-contender-exited') &&
      events.some((entry) => entry.event === 'second-instance-observed'),
    'Electron second-instance handshake',
  );
  assert.equal(
    (await readTrace(configEntry.config.tracePath)).filter(
      (entry) => entry.event === 'control-spawned',
    ).length,
    1,
  );
  assert.equal(
    (await application.evaluate(() => globalThis.__astroixProof.status())).windowCount,
    1,
  );

  const controlEntry = join(packaged.resourcesPath, 'app', 'src', 'control-plane.mjs');
  const controlEnv = {
    ASTRO_DISABLE_UPDATE_CHECK: 'true',
    ASTROIX_CONTROL_ELECTRON_VERSION: ELECTRON.version,
    ELECTRON_RUN_AS_NODE: '1',
    HOME: process.env.HOME,
    PATH: poisonedPath,
    TMPDIR: process.env.TMPDIR,
  };
  const registryContender = await commandOutput(
    packaged.executablePath,
    [controlEntry, configEntry.path],
    { env: controlEnv },
  );
  assert.equal(registryContender.code, 73, registryContender.stderr);
  assert.match(registryContender.stderr, /already has a live writer/);

  const occupiedPort = await reservePort();
  const foreignListener = createServer();
  await listen(foreignListener, occupiedPort);
  const collisionConfig = await writeConfig(
    tempRoot,
    'port-collision',
    Object.fromEntries(configEntry.config.projects.map((project) => [project.key, project])),
    occupiedPort,
  );
  try {
    const collision = await commandOutput(
      packaged.executablePath,
      [controlEntry, collisionConfig.path],
      { env: controlEnv },
    );
    assert.equal(collision.code, 74, collision.stderr);
    assert.match(collision.stderr, /EADDRINUSE/);
  } finally {
    await closeServer(foreignListener);
  }
  return {
    electronSecondInstance: 'primary retained one window and one control plane',
    fixedPortCollisionExit: 74,
    registryContenderExit: 73,
  };
}

async function exerciseRuntimeFaults(application, projects) {
  const timeout = await invoke(application, 'probe-startup-timeout', {
    projectKey: 'timeout',
    startupTimeoutMs: 250,
  });
  assert.match(timeout.readyError, /startup timed out after 250ms/);
  assert.equal(timeout.report.reason, 'startup-timeout');
  assert.notEqual(timeout.report.children.worker.outcome, 'unreaped');
  assert.notEqual(timeout.report.children.astro.outcome, 'unreaped');
  await waitForProcessesGone(
    [timeout.processes.workerPid, timeout.processes.astroPid],
    'startup-timeout child reaping',
  );

  const cancelled = await invoke(application, 'probe-cancelled-startup', {
    projectKey: 'timeout',
  });
  assert.equal(cancelled.samePromise, true);
  assert.equal(cancelled.report.reason, 'startup-cancelled-by-owner');
  assert.match(cancelled.readyError, /startup-cancelled-by-owner/);
  await waitForProcessesGone(
    [cancelled.processes.workerPid, cancelled.processes.astroPid],
    'cancelled-startup child reaping',
  );

  const composition = await invoke(application, 'probe-composition-failure', {
    projectKey: 'composition',
  });
  assert.equal(composition.report.cause, 'composition-failure');
  assert.notEqual(composition.report.cause, 'startup-timeout');
  await waitForProcessesGone(
    [composition.processes.workerPid, composition.processes.astroPid],
    'classified composition-failure child reaping',
  );

  const forced = await invoke(application, 'probe-forced-stop', { projectKey: 'forced' });
  assert.equal(forced.samePromise, true);
  assert.equal(forced.report.children.worker.forced, true);
  assert.equal(forced.report.children.worker.signal, 'SIGKILL');
  assert.equal(forced.report.children.astro.forced, false);
  await waitForProcessesGone(
    [forced.processes.workerPid, forced.processes.astroPid],
    'forced-stop child reaping',
  );

  const missing = await invoke(application, 'probe-missing-command', { projectKey: 'missing' });
  assert.equal(missing.rejected, true);
  assert.equal(missing.code, 'MODULE_NOT_FOUND');

  const workerCrash = await invoke(application, 'crash-worker');
  assert.equal(workerCrash.report.cause, 'worker-close');
  assert.equal(workerCrash.report.children.worker.signal, 'SIGKILL');
  assert.equal(workerCrash.noAutomaticRestart.state, 'closed');
  await waitForProcessesGone(
    [workerCrash.before.workerPid, workerCrash.before.astroPid],
    'worker-crash sibling cleanup',
  );

  const workerRestart = await invoke(application, 'restart-active');
  assert.notEqual(workerRestart.processes.workerPid, workerCrash.before.workerPid);
  assert.notEqual(workerRestart.processes.astroPid, workerCrash.before.astroPid);

  const astroCrash = await invoke(application, 'crash-astro');
  assert.equal(astroCrash.report.cause, 'astro-close');
  assert.equal(astroCrash.report.children.astro.signal, 'SIGKILL');
  assert.equal(astroCrash.noAutomaticRestart.state, 'closed');
  await waitForProcessesGone(
    [astroCrash.before.workerPid, astroCrash.before.astroPid],
    'managed-Astro-crash sibling cleanup',
  );
  const astroRestart = await invoke(application, 'restart-active');
  assert.equal(astroRestart.projectInspection.type, 'project');
  assert.equal(projects.beta.key, 'beta');
  return {
    timeout,
    cancelled,
    composition,
    forced,
    workerCrash,
    workerRestart,
    astroCrash,
    astroRestart,
  };
}

async function exerciseRendererCrash(packaged, configEntry, poisonedPath) {
  let application;
  try {
    ({ application } = await launchPackaged(packaged, configEntry.path, poisonedPath));
    const before = await invoke(application, 'snapshot');
    await application.evaluate(() => globalThis.__astroixProof.crashRenderer());
    const status = await waitFor(
      () => application.evaluate(() => globalThis.__astroixProof.status()),
      (next) => next.rendererRevoked === true && next.editingEnabled === false,
      'renderer crash revocation',
    );
    const runtime = await waitFor(
      () => invoke(application, 'snapshot'),
      (next) => next.state === 'closed',
      'renderer crash project-runtime stop',
    );
    assert.equal(status.windowCount, 1);
    await waitForProcessesGone(
      [before.processes.workerPid, before.processes.astroPid],
      'renderer-crash child cleanup',
    );
    const exit = childExit(application.process());
    await application.evaluate(() => globalThis.__astroixProof.quit());
    await exit;
    application = undefined;
    return { runtime, windowRecreated: false };
  } finally {
    if (application !== undefined) await application.close().catch(() => {});
  }
}

async function exerciseAbruptMainExit(packaged, configEntry, poisonedPath) {
  let application;
  try {
    ({ application } = await launchPackaged(packaged, configEntry.path, poisonedPath));
    const status = await application.evaluate(() => globalThis.__astroixProof.status());
    const pids = [
      status.controlPid,
      status.control.active.processes.workerPid,
      status.control.active.processes.astroPid,
    ];
    const exit = childExit(application.process());
    application.process().kill('SIGKILL');
    const mainExit = await exit;
    await waitForProcessesGone(pids, 'parent-IPC-disconnect child cleanup');
    await waitFor(
      async () => readTrace(configEntry.config.tracePath),
      (events) =>
        events.some(
          (entry) =>
            entry.event === 'control-cleanup-finished' && entry.reason === 'parent-ipc-disconnect',
        ),
      'control cleanup after abrupt Electron-main exit',
    );
    application = undefined;
    return { mainExit, childPidsGone: pids };
  } finally {
    if (application !== undefined) await application.close().catch(() => {});
  }
}

async function run() {
  assert.equal(process.platform, 'darwin', 'the packaged-host proof is macOS-only');
  assert.equal(process.arch, 'arm64', 'this proof pins the Apple-silicon artifact');

  const tempRoot = await mkdtemp(join(tmpdir(), 'astroix-electron-host-'));
  let application;
  let passed = false;
  try {
    const projects = await createProjects(join(tempRoot, 'projects'));
    const poisoned = await createPoisonedPath(tempRoot);
    const primaryConfig = await writeConfig(tempRoot, 'primary', projects, await reservePort());
    const packaged = await assemblePackagedApp({
      electron: ELECTRON,
      outputDirectory: join(tempRoot, 'packaged'),
      sourceDirectory: PROOF_ROOT,
    });
    const packaging = await packageEvidence(packaged);
    const launch = await launchPackaged(packaged, primaryConfig.path, poisoned.directory);
    application = launch.application;
    const status = await application.evaluate(() => globalThis.__astroixProof.status());
    assert.equal(status.isPackaged, true);
    assert.equal(status.electronVersion, ELECTRON.version);
    assert.equal(await realpath(status.resourcesPath), await realpath(packaged.resourcesPath));
    assert.equal(status.control.release, 'node');
    assert.equal(status.control.runAsNodeFuseObservedEnabled, true);
    assert.equal(
      await realpath(status.control.nodeExecutable),
      await realpath(packaged.executablePath),
    );
    assert.equal(status.control.shell, false);
    assert.equal(status.control.path, poisoned.directory);
    assert.equal(status.control.nodeOptions, undefined);
    assert.equal(status.control.secretPresent, false);
    assert.equal(status.control.active.state, 'running');
    assert.ok(status.control.active.handleReturnMs < 25);
    assert.deepEqual(status.control.active.projectInspection, {
      type: 'project',
      revision: 1,
      project: {
        base: '/lab',
        sourceDirectory: 'site',
        scopedStyleStrategy: 'where',
        certifiedVersions: { astro: '7.2.7', vite: '8.2.2' },
      },
    });
    assert.doesNotMatch(JSON.stringify(status.control.active.projectInspection), /pid/i);
    assert.ok(Number.isInteger(status.control.active.processes.workerPid));
    assert.ok(Number.isInteger(status.control.active.processes.astroPid));
    assert.equal(status.control.proxy.port, primaryConfig.config.fixedPort);

    const page = await application.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(await page.locator('h1').textContent(), 'Astroix packaged-host proof');
    assert.equal(
      await page.frameLocator('#canvas').locator('.hero-title').textContent(),
      'Alpha project',
    );
    const hmr = await exerciseHmr(
      page,
      projects.alpha.sourceFile,
      primaryConfig.config.tracePath,
      primaryConfig.config.fixedPort,
    );
    await assertLiveSecurity(application, page, primaryConfig.config.fixedPort);

    const failedPermitSwitch = await invoke(application, 'probe-switch-permit-failure', {
      projectKey: 'rollback',
    });
    assert.equal(failedPermitSwitch.rejected, true);
    assert.match(failedPermitSwitch.error, /navigation permit rejected/);
    assert.equal(failedPermitSwitch.rollback.report.reason, 'project-switch-rollback');
    assert.equal(failedPermitSwitch.active.projectKey, 'alpha');
    await waitForProcessesGone(
      [
        failedPermitSwitch.rollback.processes.workerPid,
        failedPermitSwitch.rollback.processes.astroPid,
      ],
      'navigation-permit rollback child reaping',
    );
    assert.equal(
      (await fetch(`http://rollback.localhost:${primaryConfig.config.fixedPort}/__astroix/app/`))
        .status,
      421,
    );

    const alphaBeforeSwitch = await invoke(application, 'snapshot');
    const switchAttempts = await page.evaluate(async () =>
      Promise.all(
        [0, 1].map(async () => {
          const response = await fetch('/__astroix/control/switch?project=beta', {
            method: 'POST',
          });
          const text = await response.text();
          return { status: response.status, text };
        }),
      ),
    );
    assert.deepEqual(switchAttempts.map(({ status: statusCode }) => statusCode).sort(), [200, 409]);
    const successfulSwitch = switchAttempts.find(({ status: statusCode }) => statusCode === 200);
    const switchResult = JSON.parse(successfulSwitch.text);
    await page.evaluate((url) => location.replace(url), switchResult.appUrl);
    await page.waitForURL(`http://beta.localhost:${primaryConfig.config.fixedPort}/__astroix/app/`);
    assert.equal(
      await page.frameLocator('#canvas').locator('.hero-title').textContent(),
      'Beta project',
    );
    const afterSwitch = await invoke(application, 'snapshot');
    assert.equal(afterSwitch.projectKey, 'beta');
    await waitForProcessesGone(
      [alphaBeforeSwitch.processes.workerPid, alphaBeforeSwitch.processes.astroPid],
      'switched-away project child reaping',
    );
    assert.equal(
      (await fetch(`http://alpha.localhost:${primaryConfig.config.fixedPort}/__astroix/app/`))
        .status,
      421,
    );
    const switchTrace = await readTrace(primaryConfig.config.tracePath);
    const alphaRevokedIndex = switchTrace.findIndex(
      (entry) =>
        entry.event === 'project-route-revoked' &&
        entry.projectKey === 'alpha' &&
        entry.reason === 'project-switch',
    );
    const alphaChildClosedIndex = switchTrace.findIndex(
      (entry) =>
        entry.event === 'project-runtime-event' &&
        entry.projectKey === 'alpha' &&
        entry.type === 'child-closed',
    );
    assert.ok(alphaRevokedIndex >= 0);
    assert.ok(alphaChildClosedIndex > alphaRevokedIndex);
    assert.ok(switchTrace[alphaRevokedIndex].socketsClosed > 0);
    assert.equal(
      new URL(page.url()).port,
      String(primaryConfig.config.fixedPort),
      'project switch must retain the control-plane fixed port',
    );

    const family = await processFamily(application.process().pid);
    assert.ok(family.length >= 5, `expected Electron/process family, saw ${family.length}`);
    const aggregateRssMiB = family.reduce((sum, row) => sum + row.rssKiB, 0) / 1024;

    const exclusivity = await exerciseExclusivity({
      application,
      packaged,
      configEntry: primaryConfig,
      tempRoot,
      poisonedPath: poisoned.directory,
    });
    const lifecycle = await exerciseRuntimeFaults(application, projects);
    assert.doesNotMatch(JSON.stringify(lifecycle), /unreaped/);
    assert.equal(await readFile(poisoned.sentinel, 'utf8').catch(() => ''), '');

    const beforeControlCrash = await invoke(application, 'snapshot');
    assert.deepEqual(await invoke(application, 'crash-control'), { exitingWith: 86 });
    await waitFor(
      () => application.evaluate(() => globalThis.__astroixProof.status()),
      (next) => next.controlExited === true,
      'control-plane crash observation',
    );
    await waitForProcessesGone(
      [beforeControlCrash.processes.workerPid, beforeControlCrash.processes.astroPid],
      'transient process-group cleanup after control crash',
    );
    await waitFor(
      () => isPortOpen(primaryConfig.config.fixedPort),
      (open) => open === false,
      'fixed port release after control crash',
    );
    const restartedControl = await application.evaluate(() =>
      globalThis.__astroixProof.restartControl(),
    );
    assert.equal(restartedControl.registry.staleRecovered, true);
    assert.equal(restartedControl.active.state, 'running');
    assert.notEqual(
      restartedControl.active.processes.workerPid,
      beforeControlCrash.processes.workerPid,
    );

    const quitStatus = await application.evaluate(() => globalThis.__astroixProof.status());
    const quitPids = [
      quitStatus.controlPid,
      quitStatus.control.active.processes.workerPid,
      quitStatus.control.active.processes.astroPid,
    ];
    const quitStartedAt = performance.now();
    const exited = childExit(application.process());
    await application.evaluate(() => globalThis.__astroixProof.quit());
    const quitExit = await exited;
    const shutdownMs = performance.now() - quitStartedAt;
    assert.equal(quitExit.code, 0);
    await waitForProcessesGone(quitPids, 'normal app-quit process cleanup');
    assert.equal(await isPortOpen(primaryConfig.config.fixedPort), false);
    const quitTrace = await readTrace(primaryConfig.config.tracePath);
    assert.ok(quitTrace.some((entry) => entry.event === 'before-quit-cleanup-started'));
    assert.ok(quitTrace.some((entry) => entry.event === 'before-quit-cleanup-finished'));
    application = undefined;

    const rendererConfig = await writeConfig(
      tempRoot,
      'renderer-crash',
      projects,
      await reservePort(),
    );
    const rendererCrash = await exerciseRendererCrash(packaged, rendererConfig, poisoned.directory);
    const abruptConfig = await writeConfig(tempRoot, 'abrupt-main', projects, await reservePort());
    const abruptMain = await exerciseAbruptMainExit(packaged, abruptConfig, poisoned.directory);

    const report = {
      environment: {
        arch: process.arch,
        electron: ELECTRON.version,
        macOS: osRelease(),
        nodeOutsidePackage: process.version,
        packagedNode: status.control.nodeVersion,
        packagedNodeModuleAbi: status.control.moduleAbi,
        packagedNodeOpenSSL: status.control.opensslVersion,
      },
      packaging,
      metrics: {
        aggregateRssMiB: Math.round(aggregateRssMiB * 10) / 10,
        processCount: family.length,
        startupMs: Math.round(launch.startupMs),
        shutdownMs: Math.round(shutdownMs),
      },
      proven: {
        abruptMain,
        controlCrashRestart: {
          previous: beforeControlCrash,
          restarted: restartedControl.active,
          staleLockAdapter: 'proof-only',
        },
        exclusivity,
        hmr: {
          host: hmr.host,
          origin: hmr.origin,
          protocol: hmr.protocol,
          status: hmr.upstreamStatusLine,
          url: hmr.url,
        },
        lifecycle: {
          cancelledStartup: lifecycle.cancelled.report,
          classifiedCompositionFailure: lifecycle.composition.report,
          forcedStop: lifecycle.forced.report,
          managedAstroCrash: lifecycle.astroCrash.report,
          projectWorkerCrash: lifecycle.workerCrash.report,
          startupTimeout: lifecycle.timeout.report,
        },
        rendererCrash,
        sameHostSwitch: {
          active: afterSwitch,
          concurrentStatuses: switchAttempts.map(({ status: statusCode }) => statusCode),
          permitFailureRollback: failedPermitSwitch,
        },
      },
      limits: [
        'ELECTRON_RUN_AS_NODE is proof-only and couples the runtime to Electron fuses and ABI',
        'no native-addon managed-project fixture was exercised',
        'ad-hoc arm64 signing is not Developer ID signing, notarization, or Gatekeeper acceptance',
        'Finder launch, Intel, Rosetta, and detached descendant cleanup remain unproven',
        'the stale registry-lock adapter is disposable; the registry and edit-authority grilling ticket owns the permanent design',
        'content, routes, and styles inspection remain owned by the separate AstroProjectAdapter proof',
        'the composition case proves fatal classification and sibling cleanup, not a real composition-resource failure',
        'manual Resources/app assembly does not choose a permanent packager',
      ],
    };
    process.stdout.write(`PROOF_REPORT ${JSON.stringify(report)}\n`);
    process.stdout.write('PASS packaged Electron host and process lifecycle\n');
    passed = true;
  } finally {
    if (application !== undefined) await application.close().catch(() => {});
    if (passed) await rm(tempRoot, { recursive: true, force: true });
    else process.stderr.write(`FAILED proof retained at ${tempRoot}\n`);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
