import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const HOLDER = join(TEST_DIRECTORY, '..', 'src', 'lease-holder.mjs');
const ORPHAN_SUPERVISOR = join(TEST_DIRECTORY, '..', 'src', 'orphan-supervisor.mjs');
const LEASE_FILES = {
  'registry-writer': 'registry-writer.sqlite',
  'edit-writer': 'edit-writer.sqlite',
};
const activeChildren = new Set();

test.afterEach(async () => {
  await Promise.all(
    [...activeChildren].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once('close', resolve));
      }
    }),
  );
});

function childEnvironment() {
  const env = {
    ASTROIX_EXPECTED_NODE: 'v24.20.0',
    PATH: '/usr/bin:/bin',
  };
  if (typeof process.env.TMPDIR === 'string') env.TMPDIR = process.env.TMPDIR;
  return env;
}

function startMessageChild(entry, config) {
  const child = spawn(process.execPath, [entry, JSON.stringify(config)], {
    env: childEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  const messages = [];
  const waiters = new Set();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.on('message', (message) => {
    messages.push(message);
    for (const waiter of waiters) waiter();
  });

  function nextAny(types, timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      let timer;
      const inspect = () => {
        const index = messages.findIndex((message) => types.includes(message?.type));
        if (index !== -1) {
          clearTimeout(timer);
          waiters.delete(inspect);
          resolve(messages.splice(index, 1)[0]);
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimeout(timer);
          waiters.delete(inspect);
          reject(
            new Error(
              `child exited before ${types.join(' or ')}: ${child.exitCode}/${child.signalCode}\n${stdout}${stderr}`,
            ),
          );
          return;
        }
        if (Date.now() >= deadline) {
          waiters.delete(inspect);
          reject(
            new Error(`timed out waiting for child ${types.join(' or ')}\n${stdout}${stderr}`),
          );
        }
      };
      timer = setTimeout(inspect, timeoutMs);
      waiters.add(inspect);
      inspect();
    });
  }

  return {
    child,
    next: (type, timeoutMs) => nextAny([type], timeoutMs),
    nextAny,
    output: () => ({ stdout, stderr }),
  };
}

function startHolder(privateStateDirectory, role, extra = {}) {
  return startMessageChild(HOLDER, { privateStateDirectory, role, ...extra });
}

async function waitForExit(holder) {
  const { child } = holder;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function ready(holder) {
  const message = await holder.next('ready');
  assert.equal(message.runtimeVersion, 'v24.20.0');
  assert.equal(message.executablePath, process.execPath);
}

async function acquire(holder) {
  const outcome = holder.nextAny(['acquired', 'denied']);
  holder.child.send({ type: 'start' });
  return outcome;
}

async function waitForPath(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function shutdown(holder) {
  if (holder.child.exitCode === null && holder.child.signalCode === null) {
    holder.child.send({ type: 'shutdown' });
  }
  const result = await waitForExit(holder);
  assert.deepEqual(result, { code: 0, signal: null }, JSON.stringify(holder.output()));
}

async function withPrivateState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'astroix-kernel-lease-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('first creation holds one fixed lease in private local state', () =>
  withPrivateState(async (directory) => {
    const holder = startHolder(directory, 'registry-writer');
    await ready(holder);
    const result = await acquire(holder);

    assert.equal(result.type, 'acquired');
    assert.equal(result.role, 'registry-writer');
    assert.equal(result.journalMode, 'delete');
    assert.equal(result.extensionsDisabled, true);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, LEASE_FILES['registry-writer']))).mode & 0o777, 0o600);

    await shutdown(holder);
  }));

test('barrier-started processes allow exactly one holder for the same lease', () =>
  withPrivateState(async (directory) => {
    const holders = [
      startHolder(directory, 'registry-writer'),
      startHolder(directory, 'registry-writer'),
    ];
    await Promise.all(holders.map(ready));
    const outcomes = await Promise.all(holders.map(acquire));

    assert.equal(outcomes.filter((outcome) => outcome?.type === 'acquired').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome?.type === 'denied').length, 1);
    const denied = outcomes.find((outcome) => outcome?.type === 'denied');
    assert.deepEqual(denied.error, {
      code: 'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
      message:
        'Astroix cannot acquire the registry-writer lease because another live process owns it. Astroix will not continue without exclusive ownership.',
      retryable: false,
    });
    assert.ok(denied.elapsedMs < 1_000, `contention waited ${denied.elapsedMs}ms`);
    assert.deepEqual(denied.sqliteError, {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
      errstr: 'database is locked',
    });
    assert.equal(JSON.stringify(denied).includes(directory), false);
    assert.equal('pid' in denied, false);

    await Promise.all(
      holders.map(async (holder, index) => {
        if (outcomes[index].type === 'acquired') await shutdown(holder);
        else assert.deepEqual(await waitForExit(holder), { code: 73, signal: null });
      }),
    );
  }));

test('instrumentation failures cannot alter lease authority outcomes', () =>
  withPrivateState(async (directory) => {
    const observed = startHolder(directory, 'registry-writer', {
      throwOnQualified: true,
    });
    await ready(observed);
    const observedOutcome = await acquire(observed);
    if (observedOutcome.type === 'acquired') await shutdown(observed);
    else await waitForExit(observed);
    assert.equal(observedOutcome.type, 'acquired');

    const owner = startHolder(directory, 'edit-writer');
    await ready(owner);
    assert.equal((await acquire(owner)).type, 'acquired');
    const contender = startHolder(directory, 'edit-writer', {
      throwOnContention: true,
    });
    await ready(contender);
    const contention = await acquire(contender);
    assert.deepEqual(await waitForExit(contender), { code: 73, signal: null });
    assert.equal(contention.type, 'denied');
    assert.equal(contention.error.code, 'ASTROIX_KERNEL_LEASE_UNAVAILABLE');
    await shutdown(owner);
  }));

test('asynchronous instrumentation failures cannot terminate lease holders', () =>
  withPrivateState(async (directory) => {
    const observed = startHolder(directory, 'registry-writer', {
      rejectOnQualified: true,
    });
    await ready(observed);
    assert.equal((await acquire(observed)).type, 'acquired');
    await shutdown(observed);

    const owner = startHolder(directory, 'edit-writer');
    await ready(owner);
    assert.equal((await acquire(owner)).type, 'acquired');
    const contender = startHolder(directory, 'edit-writer', {
      rejectOnContention: true,
    });
    await ready(contender);
    const contention = await acquire(contender);
    assert.equal(contention.type, 'denied');
    assert.equal(contention.error.code, 'ASTROIX_KERNEL_LEASE_UNAVAILABLE');
    assert.deepEqual(await waitForExit(contender), { code: 73, signal: null });
    await shutdown(owner);
  }));

test('different fixed lease names can be held concurrently', () =>
  withPrivateState(async (directory) => {
    const registry = startHolder(directory, 'registry-writer');
    const edit = startHolder(directory, 'edit-writer');
    await Promise.all([ready(registry), ready(edit)]);
    const outcomes = await Promise.all([acquire(registry), acquire(edit)]);

    assert.deepEqual(
      outcomes.map((outcome) => outcome.type),
      ['acquired', 'acquired'],
    );
    await Promise.all([shutdown(registry), shutdown(edit)]);
  }));

test('clean process exit releases the lease without unlinking its file', () =>
  withPrivateState(async (directory) => {
    const path = join(directory, LEASE_FILES['registry-writer']);
    const first = startHolder(directory, 'registry-writer');
    await ready(first);
    assert.equal((await acquire(first)).type, 'acquired');
    const before = await stat(path);
    await shutdown(first);

    const successor = startHolder(directory, 'registry-writer');
    await ready(successor);
    assert.equal((await acquire(successor)).type, 'acquired');
    const after = await stat(path);
    assert.equal(after.ino, before.ino);
    await shutdown(successor);
  }));

test('a lease remains exclusive through later synchronous exit listeners', () =>
  withPrivateState(async (directory) => {
    const exitBlockMarkerPath = join(directory, 'exit-listener-blocking');
    const first = startHolder(directory, 'registry-writer', {
      exitBlockMarkerPath,
      exitBlockMs: 750,
    });
    await ready(first);
    assert.equal((await acquire(first)).type, 'acquired');
    first.child.send({ type: 'shutdown' });
    await waitForPath(exitBlockMarkerPath);
    assert.doesNotThrow(() => process.kill(first.child.pid, 0));

    const contender = startHolder(directory, 'registry-writer');
    await ready(contender);
    const outcome = await acquire(contender);
    if (outcome.type === 'acquired') await shutdown(contender);
    else assert.deepEqual(await waitForExit(contender), { code: 73, signal: null });
    assert.deepEqual(await waitForExit(first), { code: 0, signal: null });

    assert.equal(outcome.type, 'denied');
    const successor = startHolder(directory, 'registry-writer');
    await ready(successor);
    assert.equal((await acquire(successor)).type, 'acquired');
    await shutdown(successor);
  }));

test('SIGKILL releases the lease without stale-owner recovery', () =>
  withPrivateState(async (directory) => {
    const path = join(directory, LEASE_FILES['edit-writer']);
    const first = startHolder(directory, 'edit-writer');
    await ready(first);
    assert.equal((await acquire(first)).type, 'acquired');
    const before = await stat(path);
    first.child.kill('SIGKILL');
    assert.deepEqual(await waitForExit(first), { code: null, signal: 'SIGKILL' });

    const successor = startHolder(directory, 'edit-writer');
    await ready(successor);
    assert.equal((await acquire(successor)).type, 'acquired');
    const after = await stat(path);
    assert.equal(after.ino, before.ino);
    await shutdown(successor);
  }));

test('a live orphaned edit executor excludes replacement until that process exits', () =>
  withPrivateState(async (directory) => {
    const exitMarkerPath = join(directory, 'orphan-exited');
    const supervisor = startMessageChild(ORPHAN_SUPERVISOR, {
      exitMarkerPath,
      orphanHoldMs: 750,
      privateStateDirectory: directory,
    });
    const orphanAcquired = await supervisor.next('orphan-acquired');
    assert.equal(orphanAcquired.runtimeVersion, 'v24.20.0');

    supervisor.child.kill('SIGKILL');
    assert.deepEqual(await waitForExit(supervisor), { code: null, signal: 'SIGKILL' });

    const blocked = startHolder(directory, 'edit-writer');
    await ready(blocked);
    const blockedOutcome = await acquire(blocked);
    assert.equal(blockedOutcome.type, 'denied');
    assert.equal(blockedOutcome.error.code, 'ASTROIX_KERNEL_LEASE_UNAVAILABLE');
    assert.deepEqual(await waitForExit(blocked), { code: 73, signal: null });

    await waitForPath(exitMarkerPath);
    const successor = startHolder(directory, 'edit-writer');
    await ready(successor);
    assert.equal((await acquire(successor)).type, 'acquired');
    await shutdown(successor);
  }));
