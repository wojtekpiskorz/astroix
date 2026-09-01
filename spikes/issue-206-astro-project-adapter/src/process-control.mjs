import { fork, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, Socket } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('./composition-worker.mjs', import.meta.url));

export async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`cannot find executable ${name} on PATH`);
}

export async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to reserve a TCP port');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function runCommand(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = capture(child);
  const result = await childExit(child);
  const captured = output();
  if (result.code !== 0) {
    throw new Error(
      `command failed (${executable} ${args.join(' ')}): exit ${result.code ?? 'null'} signal ${result.signal ?? 'none'}\n${captured.stderr}\n${captured.stdout}`,
    );
  }
  return { ...captured, ...result };
}

export async function startAstroDev(options) {
  const projectRequire = createRequire(join(options.projectRoot, 'package.json'));
  const manifestPath = projectRequire.resolve('astro/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.astro;
  if (typeof relativeBin !== 'string') throw new Error('managed Astro package has no astro bin');
  const astroBin = join(dirname(manifestPath), relativeBin);
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [astroBin, 'dev', '--host', '127.0.0.1', '--ignore-lock', '--port', String(options.port)],
    {
      cwd: options.projectRoot,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = capture(child);
  const exit = childExit(child);
  let exitError;
  let exitResult;
  void exit.then(
    (result) => {
      exitResult = result;
    },
    (error) => {
      exitError = error;
    },
  );
  try {
    await waitFor(
      async () => {
        if (exitError) throw exitError;
        if (exitResult) {
          throw new Error(`managed Astro exited before readiness: ${JSON.stringify(exitResult)}`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${options.port}/`);
          return response.status === 200;
        } catch {
          return false;
        }
      },
      (ready) => ready === true,
      `managed Astro readiness on ${options.port}`,
      20_000,
    );
  } catch (error) {
    await terminateChild(child, exit);
    const captured = output();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${captured.stderr}\n${captured.stdout}`,
      { cause: error },
    );
  }
  return {
    child,
    exit,
    output,
    pid: child.pid,
    port: options.port,
    startupMs: rounded(performance.now() - startedAt),
  };
}

export function startComposition(options) {
  const child = fork(workerPath, [], {
    cwd: options.projectRoot,
    env: options.env,
    execArgv: [],
    execPath: process.execPath,
    silent: true,
  });
  const output = capture(child);
  const exit = childExit(child);
  let requestId = 0;
  const pending = new Map();
  let forceKillTimer;
  let settleReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => {
    rejectReady(new Error('composition worker readiness timed out after 20000ms'));
    beginTermination();
  }, 20_000);

  function beginTermination() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000);
  }

  child.on('message', (message) => {
    if (message?.type === 'ready') {
      clearTimeout(readyTimer);
      settleReady(message);
      return;
    }
    if (message?.type === 'fatal') {
      clearTimeout(readyTimer);
      const error = errorFromPayload(message.error);
      error.proofPayload = message;
      rejectReady(error);
      return;
    }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    if (message.type === 'error') waiter.reject(errorFromPayload(message.error));
    else waiter.resolve(message);
    pending.delete(message.id);
  });
  exit.then(
    (result) => {
      clearTimeout(readyTimer);
      clearTimeout(forceKillTimer);
      const error = new Error(
        `composition worker exited: ${JSON.stringify(result)}\n${output().stderr}\n${output().stdout}`,
      );
      rejectReady(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
    (error) => {
      clearTimeout(readyTimer);
      clearTimeout(forceKillTimer);
      rejectReady(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  );

  const request = (type, fields = {}, timeoutMs = 15_000) => {
    const id = ++requestId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`composition worker ${type} request timed out after ${timeoutMs}ms`));
        beginTermination();
      }, timeoutMs);
      pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
    if (!child.connected) {
      pending.get(id)?.reject(new Error(`composition worker is disconnected before ${type}`));
      pending.delete(id);
      return response;
    }
    child.send({ ...fields, id, type }, (error) => {
      if (!error) return;
      pending.get(id)?.reject(error);
      pending.delete(id);
      beginTermination();
    });
    return response;
  };
  return {
    child,
    close: async (reason) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { alreadyExited: true, exit: await exit, output: output() };
      }
      try {
        const response = await request('close', { reason }, 5_000);
        const result = await withRejectingDeadline(exit, 5_000, 'composition worker close');
        return { ...response.report, exit: result, output: output() };
      } catch (error) {
        beginTermination();
        await exit.catch(() => {});
        throw error;
      }
    },
    exit,
    inspect: async () => (await request('inspect')).inspection,
    output,
    pid: child.pid,
    ready,
  };
}

export async function stopAstroDev(handle, reason) {
  const startedAt = performance.now();
  let forced = false;
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGTERM');
  }
  let result = await withDeadline(handle.exit, 5_000);
  if (!result) {
    forced = true;
    handle.child.kill('SIGKILL');
    result = await handle.exit;
  }
  await waitFor(
    () => portOpen(handle.port),
    (open) => open === false,
    `managed Astro port ${handle.port} release`,
    5_000,
  );
  return {
    exit: result,
    forced,
    output: handle.output(),
    pid: handle.pid,
    portClosed: true,
    reason,
    shutdownMs: rounded(performance.now() - startedAt),
  };
}

export async function terminateAndReap(handle) {
  return terminateChild(handle.child, handle.exit);
}

export async function waitFor(read, accept, label, timeoutMs = 10_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

export async function readJsonLines(path) {
  const text = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = bounded(stdout + chunk.toString());
  });
  child.stderr?.on('data', (chunk) => {
    stderr = bounded(stderr + chunk.toString());
  });
  return () => ({ stderr, stdout });
}

function bounded(text) {
  return text.length > 40_000 ? text.slice(-40_000) : text;
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withRejectingDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateChild(child, exit) {
  const safeExit = exit.catch((error) => ({ code: null, error: String(error), signal: null }));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const result = await withDeadline(safeExit, 5_000);
  if (result) return result;
  child.kill('SIGKILL');
  return safeExit;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const closed = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', closed);
    socket.once('timeout', closed);
    socket.connect(port, '127.0.0.1');
  });
}

function errorFromPayload(payload) {
  const error = new Error(payload?.message ?? 'composition worker failed');
  error.code = payload?.code;
  error.stack = payload?.stack ?? error.stack;
  return error;
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}
