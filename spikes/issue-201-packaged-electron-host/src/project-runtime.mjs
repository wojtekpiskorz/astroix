import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePackageCommand } from './command-discovery.mjs';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const proofStateByRun = new WeakMap();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds, value) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds, value));
}

function startupDeadline(milliseconds) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`project runtime startup timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (typeof address !== 'object' || address === null) {
        reservation.close();
        reject(new Error('could not reserve an ephemeral port'));
        return;
      }
      reservation.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function childEnvironment(executablePath, projectKey) {
  const path = [dirname(executablePath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  const env = {
    ASTRO_DISABLE_UPDATE_CHECK: 'true',
    ASTROIX_PROJECT_KEY: projectKey,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: path,
  };
  if (typeof process.env.HOME === 'string') env.HOME = process.env.HOME;
  if (typeof process.env.TMPDIR === 'string') env.TMPDIR = process.env.TMPDIR;
  return env;
}

async function waitForHttp(url, isClosing) {
  let lastObservation = 'no request attempted';
  while (!isClosing()) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastObservation = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`Astro readiness cancelled; last observation: ${lastObservation}`);
}

function publicChildResult(record) {
  if (record?.result !== undefined) return record.result;
  return {
    outcome: 'not-started',
    code: null,
    signal: null,
    forced: record?.forced ?? false,
  };
}

export function inspectProjectRuntimeProcesses(run) {
  const proofState = proofStateByRun.get(run);
  if (proofState === undefined) throw new TypeError('unknown project run');
  return {
    workerPid: proofState.children.get('worker')?.child.pid,
    astroPid: proofState.children.get('astro')?.child.pid,
  };
}

export function inspectProjectRuntimeState(run) {
  const proofState = proofStateByRun.get(run);
  if (proofState === undefined) throw new TypeError('unknown project run');
  return proofState.state();
}

export function crashProjectRuntimeChild(run, role) {
  if (role !== 'worker' && role !== 'astro') throw new TypeError('role must be worker or astro');
  const proofState = proofStateByRun.get(run);
  if (proofState === undefined) throw new TypeError('unknown project run');
  const record = proofState.children.get(role);
  if (record === undefined || record.result !== undefined) return false;
  return record.child.kill('SIGKILL');
}

export function startProjectRuntime({
  project,
  executablePath,
  workerEntryPath = join(moduleDirectory, 'project-worker.mjs'),
  startupTimeoutMs = 20_000,
  terminationGraceMs = 500,
  resolveCommand = (input) => resolvePackageCommand(input),
  certifyProxy,
  trace = () => {},
}) {
  if (typeof project?.key !== 'string' || typeof project?.root !== 'string') {
    throw new TypeError('project.key and project.root are required');
  }
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new TypeError('executablePath is required');
  }

  const startedAt = new Date().toISOString();
  const readyResult = deferred();
  const closedResult = deferred();
  const listeners = new Set();
  const children = new Map();
  let state = 'starting';
  let readySettled = false;
  let closeStarted = false;
  let closeReason;
  let closeCause;
  let projectInspection;

  readyResult.promise.catch(() => {});

  function emit(event) {
    const publicEvent = { projectKey: project.key, ...event };
    trace(publicEvent);
    for (const listener of listeners) listener(publicEvent);
  }

  function settleReadyWithError(error) {
    if (readySettled) return;
    readySettled = true;
    readyResult.reject(error);
  }

  function spawnChild(role, args, options = {}) {
    const env = childEnvironment(executablePath, project.key);
    emit({
      type: 'child-spawned',
      role,
      executablePath,
      args: [...args],
      cwd: project.root,
      env: { ...env },
      shell: false,
    });
    const child = spawn(executablePath, args, {
      cwd: project.root,
      env,
      shell: false,
      stdio: options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    const closed = deferred();
    const record = { child, closed: closed.promise, result: undefined, forced: false };
    children.set(role, record);

    for (const streamName of ['stdout', 'stderr']) {
      child[streamName]?.on('data', (chunk) => {
        emit({ type: 'child-output', role, stream: streamName, text: chunk.toString() });
      });
    }
    child.once('error', (error) => {
      if (record.result === undefined) {
        record.result = {
          outcome: 'spawn-error',
          code: null,
          signal: null,
          forced: record.forced,
          error: error.message,
        };
      }
    });
    child.once('close', (code, signal) => {
      if (record.result === undefined) {
        record.result = {
          outcome: signal === null ? 'exited' : 'signaled',
          code,
          signal,
          forced: record.forced,
        };
      }
      closed.resolve(record.result);
      emit({ type: 'child-closed', role, result: { ...record.result } });
      if (!closeStarted) {
        void beginClose({
          reason: `unexpected-${role}-close`,
          cause: `${role}-close`,
          readyError: new Error(
            `${role} closed unexpectedly with ${record.result.code}/${record.result.signal}`,
          ),
        });
      }
    });
    return child;
  }

  async function terminateChild(record) {
    if (record === undefined || record.result !== undefined) return;
    record.child.kill('SIGTERM');
    const exitedAfterTerm = await Promise.race([
      record.closed.then(() => true),
      delay(terminationGraceMs, false),
    ]);
    if (exitedAfterTerm) return;
    record.forced = true;
    record.child.kill('SIGKILL');
    await record.closed;
  }

  function beginClose({ reason, cause, readyError }) {
    if (closeStarted) return closedResult.promise;
    closeStarted = true;
    closeReason = reason;
    closeCause = cause;
    state = 'stopping';
    settleReadyWithError(
      readyError ?? new Error(`project runtime stopped during startup: ${reason}`),
    );
    emit({ type: 'closing', reason, cause });

    void (async () => {
      await Promise.all([...children.values()].map((record) => terminateChild(record)));
      state = 'closed';
      const report = {
        projectKey: project.key,
        reason: closeReason,
        cause: closeCause,
        startedAt,
        closedAt: new Date().toISOString(),
        children: {
          worker: publicChildResult(children.get('worker')),
          astro: publicChildResult(children.get('astro')),
        },
      };
      emit({ type: 'closed', report });
      closedResult.resolve(report);
    })();
    return closedResult.promise;
  }

  void (async () => {
    try {
      const [workerPort, astroPort] = await Promise.all([reservePort(), reservePort()]);
      if (closeStarted) return;
      const command = resolveCommand({
        projectRoot: project.root,
        packageName: 'astro',
        binName: 'astro',
      });
      const vite = resolveCommand({
        projectRoot: project.root,
        packageName: 'vite',
        binName: 'vite',
      });
      const workerReady = deferred();
      const worker = spawnChild(
        'worker',
        [
          workerEntryPath,
          JSON.stringify({
            projectKey: project.key,
            port: workerPort,
            terminationMode: project.terminationMode,
            switchTarget: project.switchTarget,
          }),
        ],
        { ipc: true },
      );
      worker.on('message', (message) => {
        if (message?.type === 'ready' && message.port === workerPort) workerReady.resolve(message);
        if (message?.type === 'fatal') {
          void beginClose({
            reason: 'startup-failure',
            cause: message.kind ?? 'worker-failure',
            readyError: new Error(message.error ?? 'project worker failed during startup'),
          });
        }
      });
      spawnChild('astro', [
        command.commandPath,
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(astroPort),
        '--strictPort',
      ]);

      const startup = (async () => {
        const [workerStatus] = await Promise.all([
          workerReady.promise,
          waitForHttp(`http://127.0.0.1:${astroPort}/lab/home/`, () => closeStarted),
        ]);
        return certifyProxy?.({
          projectKey: project.key,
          projectRoot: project.root,
          workerPort,
          astroPort,
          workerAppUrl: workerStatus.appUrl,
        });
      })();
      const deadline = startupDeadline(startupTimeoutMs);
      const certification = await Promise.race([startup, deadline.promise]).finally(
        deadline.cancel,
      );
      if (closeStarted) return;
      state = 'running';
      projectInspection = {
        type: 'project',
        revision: 1,
        project: {
          base: project.base ?? '/',
          sourceDirectory: project.sourceDirectory ?? '.',
          scopedStyleStrategy: project.scopedStyleStrategy ?? 'attribute',
          certifiedVersions: {
            astro: command.packageVersion,
            vite: vite.packageVersion,
          },
        },
      };
      readySettled = true;
      const descriptor = {
        projectKey: project.key,
        worker: 'ready',
        astro: 'ready',
        certification,
      };
      readyResult.resolve(descriptor);
      emit({ type: 'ready', descriptor });
      emit({ type: 'invalidation', resource: 'project', revision: projectInspection.revision });
    } catch (error) {
      const startupError = error instanceof Error ? error : new Error(String(error));
      const timedOut = startupError.message.includes('timed out');
      void beginClose({
        reason: timedOut ? 'startup-timeout' : 'startup-failure',
        cause: timedOut ? 'startup-timeout' : 'startup-failure',
        readyError: startupError,
      });
    }
  })();

  const run = {
    ready: readyResult.promise,
    closed: closedResult.promise,
    async inspect(request) {
      if (request?.type !== 'project') throw new Error('unsupported inspection request');
      if (state !== 'running' || projectInspection === undefined) {
        const error = new Error(`project inspection unavailable while runtime is ${state}`);
        error.code = 'ASTROIX_RUNTIME_NOT_READY';
        throw error;
      }
      return structuredClone(projectInspection);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop(reason) {
      return beginClose({ reason, cause: 'requested' });
    },
  };
  proofStateByRun.set(run, { children, state: () => state });
  return run;
}
