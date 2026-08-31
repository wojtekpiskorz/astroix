import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { resolvePackageCommand } from './command-discovery.mjs';
import {
  crashProjectRuntimeChild,
  inspectProjectRuntimeProcesses,
  inspectProjectRuntimeState,
  startProjectRuntime,
} from './project-runtime.mjs';
import { startLoopbackProxy } from './proxy.mjs';
import { acquireProofRegistryLock } from './registry-lock.mjs';
import { trace } from './trace.mjs';

const configPath = process.argv[2];
if (configPath === undefined) throw new Error('proof config path is required');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const record = (event, detail = {}) => trace(config.tracePath, 'control-plane', event, detail);
const projects = new Map(config.projects.map((project) => [project.key, project]));
const records = new Set();
const routes = new Map();
const navigationAcks = new Map();
let activeRecord;
let pendingSwitch;
let proxy;
let registryLock;
let cleanupPromise;
let navigationId = 0;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function projectOrigin(projectKey) {
  return `http://${projectKey}.localhost:${config.fixedPort}`;
}

function currentRoute(projectKey) {
  const route = routes.get(projectKey);
  return route?.run === route?.record.run ? route : undefined;
}

function proofProcesses(recordToInspect) {
  try {
    return inspectProjectRuntimeProcesses(recordToInspect.run);
  } catch {
    return { workerPid: undefined, astroPid: undefined };
  }
}

function revokeRecord(recordToRevoke, reason) {
  if (recordToRevoke === undefined || recordToRevoke.revoked) {
    return { routeRemoved: false, socketsClosed: 0 };
  }
  recordToRevoke.revoked = true;
  recordToRevoke.editingAuthorized = false;
  const route = routes.get(recordToRevoke.project.key);
  const routeRemoved = route?.record === recordToRevoke;
  if (routeRemoved) routes.delete(recordToRevoke.project.key);
  const socketsClosed = proxy?.revokeProject(recordToRevoke.project.key) ?? 0;
  record('project-route-revoked', {
    projectKey: recordToRevoke.project.key,
    reason,
    routeRemoved,
    socketsClosed,
  });
  return { routeRemoved, socketsClosed };
}

async function certifyProxy(recordToCertify, ports) {
  const route = {
    appPort: ports.workerPort,
    upstreamPort: ports.astroPort,
    record: recordToCertify,
    run: recordToCertify.run,
  };
  routes.set(ports.projectKey, route);
  const origin = projectOrigin(ports.projectKey);
  const [appResponse, canvasResponse] = await Promise.all([
    fetch(`${origin}/__astroix/app/`),
    fetch(`${origin}/lab/home/`),
  ]);
  if (!appResponse.ok || !canvasResponse.ok) {
    routes.delete(ports.projectKey);
    throw new Error(
      `proxy certification failed: app=${appResponse.status} canvas=${canvasResponse.status}`,
    );
  }
  const [app, canvas] = await Promise.all([appResponse.text(), canvasResponse.text()]);
  if (!app.includes('Astroix packaged-host proof') || !canvas.includes('hero-title')) {
    routes.delete(ports.projectKey);
    throw new Error('proxy certification did not observe the app and natural canvas contracts');
  }
  record('proxy-certified', {
    projectKey: ports.projectKey,
    appUrl: `${origin}/__astroix/app/`,
    canvasUrl: `${origin}/lab/home/`,
  });
  return {
    appUrl: `${origin}/__astroix/app/`,
    canvasUrl: `${origin}/lab/home/`,
    origin,
    sameHost: true,
  };
}

function createRecord(project, overrides = {}) {
  const calledAt = performance.now();
  const runtimeRecord = {
    project,
    run: undefined,
    handleReturnMs: undefined,
    editingAuthorized: false,
    revoked: false,
  };
  const run = startProjectRuntime({
    project,
    executablePath: process.execPath,
    startupTimeoutMs: overrides.startupTimeoutMs ?? config.startupTimeoutMs,
    terminationGraceMs: config.terminationGraceMs,
    resolveCommand(input) {
      const resolved = resolvePackageCommand(input);
      if (input.packageName === 'astro' && typeof project.commandPathOverride === 'string') {
        return { ...resolved, commandPath: project.commandPathOverride, source: 'proof-override' };
      }
      return resolved;
    },
    certifyProxy: (ports) => certifyProxy(runtimeRecord, ports),
    trace: (event) => {
      if (event.type === 'closing') revokeRecord(runtimeRecord, event.reason);
      record('project-runtime-event', event);
    },
  });
  runtimeRecord.run = run;
  runtimeRecord.handleReturnMs = performance.now() - calledAt;
  records.add(runtimeRecord);
  run.closed.then((report) => {
    revokeRecord(runtimeRecord, report.reason);
    record('project-runtime-closed', { report });
  });
  record('project-runtime-handle-returned', {
    projectKey: project.key,
    handleReturnMs: runtimeRecord.handleReturnMs,
  });
  return runtimeRecord;
}

async function startReady(project, overrides = {}) {
  const runtimeRecord = createRecord(project, overrides);
  const descriptor = await runtimeRecord.run.ready;
  return {
    runtimeRecord,
    value: {
      descriptor,
      handleReturnMs: runtimeRecord.handleReturnMs,
      processes: proofProcesses(runtimeRecord),
      projectInspection: await runtimeRecord.run.inspect({ type: 'project' }),
    },
  };
}

async function runtimeSnapshot(runtimeRecord = activeRecord) {
  if (runtimeRecord === undefined) return undefined;
  const state = inspectProjectRuntimeState(runtimeRecord.run);
  return {
    projectKey: runtimeRecord.project.key,
    handleReturnMs: runtimeRecord.handleReturnMs,
    processes: proofProcesses(runtimeRecord),
    state,
    projectInspection:
      state === 'running' ? await runtimeRecord.run.inspect({ type: 'project' }) : undefined,
  };
}

async function status() {
  const origin = activeRecord === undefined ? undefined : projectOrigin(activeRecord.project.key);
  return {
    active: await runtimeSnapshot(),
    appUrl: origin === undefined ? undefined : `${origin}/__astroix/app/`,
    arch: process.arch,
    controlPid: process.pid,
    electronRuntimeVersion: process.env.ASTROIX_CONTROL_ELECTRON_VERSION,
    envKeys: Object.keys(process.env).sort(),
    moduleAbi: process.versions.modules,
    nodeExecutable: process.execPath,
    nodeOptions: process.env.NODE_OPTIONS,
    nodeVersion: process.versions.node,
    opensslVersion: process.versions.openssl,
    origin,
    parentPid: process.ppid,
    path: process.env.PATH,
    proxy: proxy === undefined ? undefined : { addresses: proxy.addresses, port: proxy.port },
    registry: {
      lockPath: registryLock?.path,
      staleRecovered: registryLock?.staleRecovered,
    },
    release: process.release.name,
    runAsNodeFuseObservedEnabled: process.release.name === 'node',
    secretPresent: process.env.ASTROIX_PROOF_SECRET !== undefined,
    shell: false,
  };
}

async function requestNavigationPermit(origin) {
  if (process.send === undefined) throw new Error('main-process IPC is unavailable');
  const id = `navigation-${++navigationId}`;
  let timer;
  const acknowledged = new Promise((resolve, reject) => {
    navigationAcks.set(id, resolve);
    timer = setTimeout(() => {
      navigationAcks.delete(id);
      reject(new Error(`main did not acknowledge navigation permit ${id}`));
    }, 2_000);
  });
  process.send({ type: 'permit-navigation', id, origin });
  try {
    await acknowledged;
  } finally {
    clearTimeout(timer);
  }
}

async function switchProject(fromKey, targetKey, permitNavigation = requestNavigationPermit) {
  if (activeRecord?.project.key !== fromKey) throw new Error('switch source is not active');
  if (pendingSwitch !== undefined) throw new Error('a project switch is already pending');
  const project = projects.get(targetKey);
  if (project === undefined) throw new Error(`unknown project: ${targetKey}`);
  const transaction = { from: activeRecord, targetKey, to: undefined };
  pendingSwitch = transaction;
  let started;
  try {
    started = await startReady(project);
    transaction.to = started.runtimeRecord;
    await permitNavigation(projectOrigin(targetKey));
    record('project-switch-ready', { fromKey, targetKey });
    return {
      appUrl: `${projectOrigin(targetKey)}/__astroix/app/`,
      fixedPort: config.fixedPort,
      start: started.value,
    };
  } catch (error) {
    let rollback;
    if (started !== undefined) {
      const processes = proofProcesses(started.runtimeRecord);
      const revocation = revokeRecord(started.runtimeRecord, 'project-switch-rollback');
      const report = await started.runtimeRecord.run.stop('project-switch-rollback');
      rollback = { processes, report, revocation };
    }
    if (pendingSwitch === transaction) pendingSwitch = undefined;
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.rollback = rollback;
    throw failure;
  }
}

async function rollbackPendingSwitch(reason, url) {
  const transaction = pendingSwitch;
  if (transaction?.to === undefined) return { rolledBack: false };
  pendingSwitch = undefined;
  const processes = proofProcesses(transaction.to);
  const revocation = revokeRecord(transaction.to, reason);
  const report = await transaction.to.run.stop(reason);
  record('project-switch-rolled-back', { reason, targetKey: transaction.targetKey, url });
  return { rolledBack: true, processes, report, revocation };
}

async function commitNavigation(url) {
  if (pendingSwitch === undefined) return { committed: false };
  if (pendingSwitch.to === undefined) throw new Error('project switch target is not ready');
  const expected = `${projectOrigin(pendingSwitch.to.project.key)}/__astroix/app/`;
  if (new URL(url).href !== expected) throw new Error(`unexpected committed switch URL: ${url}`);
  const previous = pendingSwitch.from;
  const next = pendingSwitch.to;
  revokeRecord(previous, 'project-switch');
  activeRecord = next;
  activeRecord.editingAuthorized = true;
  pendingSwitch = undefined;
  const closeReport = await previous.run.stop('project-switch');
  record('project-switch-committed', {
    fromKey: previous.project.key,
    targetKey: activeRecord.project.key,
  });
  return { committed: true, closeReport, active: await runtimeSnapshot() };
}

async function handleControlRequest(request, response, projectKey) {
  const url = new URL(request.url ?? '/', 'http://control.invalid');
  if (request.method === 'POST' && url.pathname === '/__astroix/control/probe-edit') {
    const route = currentRoute(projectKey);
    const authorized = route?.record === activeRecord && activeRecord?.editingAuthorized === true;
    response.writeHead(authorized ? 204 : 423, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/__astroix/control/switch') {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const result = await switchProject(projectKey, url.searchParams.get('project'));
    const body = Buffer.from(JSON.stringify(result));
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    const body = Buffer.from(error instanceof Error ? error.message : String(error));
    response.writeHead(409, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': body.length,
    });
    response.end(body);
  }
}

async function crashActiveChild(role) {
  if (activeRecord === undefined) throw new Error('no active project runtime');
  const before = proofProcesses(activeRecord);
  if (!crashProjectRuntimeChild(activeRecord.run, role)) {
    throw new Error(`${role} was not running`);
  }
  const report = await activeRecord.run.closed;
  await delay(200);
  return {
    before,
    report,
    after: proofProcesses(activeRecord),
    noAutomaticRestart: { state: inspectProjectRuntimeState(activeRecord.run) },
  };
}

async function restartActive() {
  if (activeRecord === undefined) throw new Error('no active project is known');
  const previousProcesses = proofProcesses(activeRecord);
  const started = await startReady(activeRecord.project);
  activeRecord = started.runtimeRecord;
  activeRecord.editingAuthorized = true;
  return { previousProcesses, ...started.value };
}

async function probeStart(projectKey, options = {}) {
  const project = projects.get(projectKey);
  if (project === undefined) throw new Error(`unknown project: ${projectKey}`);
  const runtimeRecord = createRecord(project, options);
  let readyError;
  try {
    await runtimeRecord.run.ready;
  } catch (error) {
    readyError = error instanceof Error ? error.message : String(error);
  }
  return {
    readyError,
    processes: proofProcesses(runtimeRecord),
    report: await runtimeRecord.run.closed,
  };
}

async function probeCancelledStartup(projectKey) {
  const project = projects.get(projectKey);
  if (project === undefined) throw new Error(`unknown project: ${projectKey}`);
  const runtimeRecord = createRecord(project, { startupTimeoutMs: 5_000 });
  await delay(50);
  const processes = proofProcesses(runtimeRecord);
  const first = runtimeRecord.run.stop('startup-cancelled-by-owner');
  const samePromise = first === runtimeRecord.run.stop('ignored-second-stop');
  let readyError;
  try {
    await runtimeRecord.run.ready;
  } catch (error) {
    readyError = error instanceof Error ? error.message : String(error);
  }
  return { readyError, samePromise, processes, report: await first };
}

async function stopActive(reason) {
  if (activeRecord === undefined) return { reason, alreadyClosed: true };
  return activeRecord.run.stop(reason);
}

async function revokeEditing(reason, url) {
  if (activeRecord === undefined) return { revoked: false };
  activeRecord.editingAuthorized = false;
  record('editing-authority-revoked', {
    projectKey: activeRecord.project.key,
    reason,
    url,
  });
  return { revoked: true, projectKey: activeRecord.project.key };
}

async function probeSwitchPermitFailure(targetKey) {
  if (activeRecord === undefined) throw new Error('no active project runtime');
  try {
    await switchProject(activeRecord.project.key, targetKey, async () => {
      throw new Error('navigation permit rejected by proof injection');
    });
    return { rejected: false };
  } catch (error) {
    return {
      rejected: true,
      error: error instanceof Error ? error.message : String(error),
      rollback: error?.rollback,
      active: await runtimeSnapshot(),
    };
  }
}

async function cleanup(reason) {
  if (cleanupPromise !== undefined) return cleanupPromise;
  cleanupPromise = (async () => {
    const reports = await Promise.all(
      [...records].map((runtimeRecord) => runtimeRecord.run.stop(reason)),
    );
    await proxy?.close();
    const releasedRegistry = await registryLock?.release();
    record('control-cleanup-finished', { reason, reports, releasedRegistry });
    return { reason, reports, releasedRegistry };
  })();
  return cleanupPromise;
}

async function executeCommand(message) {
  switch (message.type) {
    case 'status':
      return status();
    case 'snapshot':
      return runtimeSnapshot();
    case 'navigation-committed':
      return commitNavigation(message.url);
    case 'navigation-failed':
      return rollbackPendingSwitch('project-navigation-failed', message.url);
    case 'revoke-editing':
      return revokeEditing(message.reason, message.url);
    case 'probe-switch-permit-failure':
      return probeSwitchPermitFailure(message.projectKey);
    case 'crash-worker':
      return crashActiveChild('worker');
    case 'crash-astro':
      return crashActiveChild('astro');
    case 'restart-active':
      return restartActive();
    case 'probe-startup-timeout':
      return probeStart(message.projectKey, { startupTimeoutMs: message.startupTimeoutMs });
    case 'probe-composition-failure':
      return probeStart(message.projectKey);
    case 'probe-cancelled-startup':
      return probeCancelledStartup(message.projectKey);
    case 'probe-forced-stop': {
      const project = projects.get(message.projectKey);
      if (project === undefined) throw new Error(`unknown project: ${message.projectKey}`);
      const started = await startReady(project);
      const processes = proofProcesses(started.runtimeRecord);
      const first = started.runtimeRecord.run.stop('forced-stop-proof');
      return {
        start: started.value,
        processes,
        samePromise: first === started.runtimeRecord.run.stop('ignored-second-stop'),
        report: await first,
      };
    }
    case 'probe-missing-command': {
      const project = projects.get(message.projectKey);
      if (project === undefined) throw new Error(`unknown project: ${message.projectKey}`);
      try {
        resolvePackageCommand({
          projectRoot: project.root,
          packageName: 'astro',
          binName: 'astro',
        });
        return { rejected: false };
      } catch (error) {
        return {
          rejected: true,
          code: error?.code,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case 'stop-active':
      return stopActive(message.reason);
    case 'shutdown':
      return cleanup(message.reason ?? 'shutdown');
    default:
      throw new Error(`unsupported control command: ${message.type}`);
  }
}

function installIpc() {
  process.on('message', (message) => {
    if (message?.type === 'permit-navigation-ack') {
      navigationAcks.get(message.replyTo)?.();
      navigationAcks.delete(message.replyTo);
      return;
    }
    if (message?.id === undefined) return;
    if (message.type === 'crash-control') {
      process.send?.({ replyTo: message.id, ok: true, value: { exitingWith: 86 } }, () => {
        setTimeout(() => process.exit(86), 20);
      });
      return;
    }
    void executeCommand(message).then(
      (value) => {
        process.send?.({ replyTo: message.id, ok: true, value }, () => {
          if (message.type === 'shutdown') {
            process.disconnect();
            process.exit(0);
          }
        });
      },
      (error) => {
        process.send?.({
          replyTo: message.id,
          ok: false,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      },
    );
  });
}

async function main() {
  record('control-starting', {
    electronRuntimeVersion: process.env.ASTROIX_CONTROL_ELECTRON_VERSION,
    nodeVersion: process.versions.node,
    moduleAbi: process.versions.modules,
    executablePath: process.execPath,
  });
  registryLock = await acquireProofRegistryLock({
    directory: config.registryDir,
    allowStaleRecovery: config.allowProofOnlyStaleLockRecovery,
  });
  record('registry-lock-acquired', {
    path: registryLock.path,
    staleRecovered: registryLock.staleRecovered,
  });
  proxy = await startLoopbackProxy({
    port: config.fixedPort,
    runtimeForHost: (key) => currentRoute(key),
    handleControlRequest,
    onUpgrade: (observation) => record('raw-websocket-upgrade', observation),
  });
  record('fixed-loopback-port-acquired', {
    port: config.fixedPort,
    addresses: proxy.addresses,
  });
  const initialProject = projects.get(config.initialProjectKey);
  if (initialProject === undefined) throw new Error('initial project is not registered');
  const started = await startReady(initialProject);
  activeRecord = started.runtimeRecord;
  activeRecord.editingAuthorized = true;
  installIpc();
  const controlStatus = await status();
  process.send?.({ type: 'ready', status: controlStatus });
  record('control-ready', { activeProjectKey: initialProject.key });
}

process.once('disconnect', () => {
  void cleanup('parent-ipc-disconnect').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void cleanup('control-sigterm').finally(() => process.exit(0));
});

try {
  await main();
} catch (error) {
  record('control-startup-failed', {
    code: error?.code,
    error: errorText(error),
  });
  await cleanup('startup-failure').catch((cleanupError) => {
    record('control-startup-cleanup-failed', { error: errorText(cleanupError) });
  });
  console.error(errorText(error));
  process.exitCode =
    error?.code === 'ASTROIX_REGISTRY_LOCKED' ? 73 : error?.code === 'EADDRINUSE' ? 74 : 1;
}
