import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  crashProjectRuntimeChild,
  inspectProjectRuntimeProcesses,
  inspectProjectRuntimeState,
  startProjectRuntime,
} from '../src/project-runtime.mjs';

async function makeAstroCommand(source) {
  const root = await mkdtemp(join(tmpdir(), 'astroix-project-runtime-'));
  const commandPath = join(root, 'astro.mjs');
  await writeFile(commandPath, source);
  return { root, commandPath };
}

const healthyAstroSource = `
import { createServer } from 'node:http';
const portIndex = process.argv.indexOf('--port');
const port = Number(process.argv[portIndex + 1]);
const server = createServer((request, response) => {
  if (request.url === '/lab/home/') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<h1>lab</h1>');
    return;
  }
  response.writeHead(404);
  response.end('missing');
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => server.close(() => process.exit(0)));
`;

function resolveFixtureCommand(commandPath) {
  return ({ packageName }) => ({
    commandPath,
    packageName,
    packageVersion: packageName === 'astro' ? '7.2.7-test' : '8.2.2-test',
  });
}

test('returns a project run handle before startup settles', async () => {
  const fixture = await makeAstroCommand('setInterval(() => {}, 1_000);\n');
  try {
    const run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
    });

    assert.equal(typeof run.inspect, 'function');
    assert.equal(typeof run.subscribe, 'function');
    assert.equal(typeof run.stop, 'function');
    assert.ok(run.ready instanceof Promise);
    assert.ok(run.closed instanceof Promise);

    await run.stop('test-cleanup');
    await assert.rejects(run.ready, /test-cleanup/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('certifies both sibling children and stops idempotently', async () => {
  const fixture = await makeAstroCommand(healthyAstroSource);
  const trace = [];
  const subscribed = [];
  try {
    const run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      terminationGraceMs: 250,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
      trace: (event) => trace.push(event),
    });
    const unsubscribe = run.subscribe((event) => subscribed.push(event));

    assert.deepEqual(await run.ready, {
      projectKey: 'alpha',
      worker: 'ready',
      astro: 'ready',
      certification: undefined,
    });
    assert.deepEqual(await run.inspect({ type: 'project' }), {
      type: 'project',
      revision: 1,
      project: {
        base: '/',
        sourceDirectory: '.',
        scopedStyleStrategy: 'attribute',
        certifiedVersions: { astro: '7.2.7-test', vite: '8.2.2-test' },
      },
    });
    await assert.rejects(run.inspect({ type: 'status' }), /unsupported inspection request/);
    assert.ok(
      subscribed.some(
        (event) =>
          event.type === 'invalidation' && event.resource === 'project' && event.revision === 1,
      ),
    );
    assert.deepEqual(
      trace
        .filter((event) => event.type === 'child-spawned')
        .map((event) => ({
          role: event.role,
          executablePath: event.executablePath,
          shell: event.shell,
          runAsNode: event.env.ELECTRON_RUN_AS_NODE,
        })),
      [
        {
          role: 'worker',
          executablePath: process.execPath,
          shell: false,
          runAsNode: '1',
        },
        {
          role: 'astro',
          executablePath: process.execPath,
          shell: false,
          runAsNode: '1',
        },
      ],
    );

    const firstStop = run.stop('normal-stop');
    const secondStop = run.stop('ignored-second-reason');
    assert.strictEqual(firstStop, secondStop);
    unsubscribe();
    const subscribedBeforeClose = subscribed.length;
    const report = await firstStop;
    assert.equal(report.reason, 'normal-stop');
    assert.equal(report.cause, 'requested');
    assert.equal(report.children.worker.outcome, 'exited');
    assert.equal(report.children.astro.outcome, 'exited');
    assert.doesNotMatch(JSON.stringify(report), /"pid"|ChildProcess/);
    assert.equal(subscribed.length, subscribedBeforeClose);
    assert.equal(inspectProjectRuntimeState(run), 'closed');
    await assert.rejects(
      run.inspect({ type: 'project' }),
      /project inspection unavailable while runtime is closed/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('proof helpers inspect and crash exact children without widening the public handle', async () => {
  const fixture = await makeAstroCommand(healthyAstroSource);
  try {
    const run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      terminationGraceMs: 250,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
    });
    await run.ready;

    const processes = inspectProjectRuntimeProcesses(run);
    assert.ok(Number.isInteger(processes.workerPid));
    assert.ok(Number.isInteger(processes.astroPid));
    assert.doesNotMatch(JSON.stringify(await run.inspect({ type: 'project' })), /pid/i);

    assert.equal(crashProjectRuntimeChild(run, 'worker'), true);
    const report = await run.closed;
    assert.equal(report.cause, 'worker-close');
    assert.equal(report.children.worker.outcome, 'signaled');
    assert.notEqual(report.children.astro.outcome, 'unreaped');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('reports composition startup failure separately from a readiness timeout', async () => {
  const fixture = await makeAstroCommand(healthyAstroSource);
  let run;
  try {
    run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root, terminationMode: 'composition-fail' },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      terminationGraceMs: 250,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
    });

    await assert.rejects(run.ready, /composition startup failed/);
    const report = await run.closed;
    assert.equal(report.cause, 'composition-failure');
    assert.notEqual(report.cause, 'startup-timeout');
  } finally {
    await run?.stop('test-cleanup');
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('startup timeout is terminal and stops both children', async () => {
  const fixture = await makeAstroCommand('setInterval(() => {}, 1_000);\n');
  try {
    const run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root },
      executablePath: process.execPath,
      startupTimeoutMs: 100,
      terminationGraceMs: 100,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
    });

    await assert.rejects(run.ready, /startup timed out after 100ms/);
    const report = await run.closed;
    assert.equal(report.reason, 'startup-timeout');
    assert.equal(report.cause, 'startup-timeout');
    assert.notEqual(report.children.worker.outcome, 'unreaped');
    assert.notEqual(report.children.astro.outcome, 'unreaped');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('worker serves the natural canvas and fetch-driven switch flow', async () => {
  const fixture = await makeAstroCommand(healthyAstroSource);
  let run;
  try {
    run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root, switchTarget: 'gamma' },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      terminationGraceMs: 250,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
      async certifyProxy({ workerAppUrl }) {
        const html = await (await fetch(workerAppUrl)).text();
        const script = await (await fetch(new URL('app.js', workerAppUrl))).text();
        assert.match(html, /<iframe[^>]+src="\/lab\/home\/"/);
        assert.match(html, /data-project-target="gamma"/);
        assert.match(script, /method: 'POST'/);
        assert.match(script, /__astroix\/control\/switch\?project=/);
        assert.match(script, /location\.replace\(result\.appUrl\)/);
        assert.doesNotMatch(`${html}\n${script}`, /electron|ipcRenderer|contextBridge/);
        return { workerUi: 'certified' };
      },
    });

    assert.deepEqual((await run.ready).certification, { workerUi: 'certified' });
  } finally {
    await run?.stop('test-cleanup');
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('ignore-term worker escalates to a bounded SIGKILL', async () => {
  const fixture = await makeAstroCommand(healthyAstroSource);
  try {
    const run = startProjectRuntime({
      project: { key: 'alpha', root: fixture.root, terminationMode: 'ignore-term' },
      executablePath: process.execPath,
      startupTimeoutMs: 5_000,
      terminationGraceMs: 50,
      resolveCommand: resolveFixtureCommand(fixture.commandPath),
    });
    await run.ready;

    const report = await run.stop('forced-stop-proof');
    assert.equal(report.children.worker.forced, true);
    assert.equal(report.children.worker.outcome, 'signaled');
    assert.equal(report.children.worker.signal, 'SIGKILL');
    assert.equal(report.children.astro.forced, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
