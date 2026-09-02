import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectWorker,
  type ProjectWorker,
} from '../../project-plane/worker/project-worker.ts';
import {
  EXIT_OK,
  EXIT_PROTOCOL,
  isWorkerWireIn,
  serveProjectWorker,
  type WorkerChannel,
  workerChannel,
} from '../../project-plane/worker/worker-ipc.ts';
import { type FakePlane, fakePlane } from './plane-fakes.ts';

/**
 * The worker's IPC serving loop (#230 focused tests), in-process: the
 * closed wire union (a malformed request is answered, a malformed WIRE
 * message is a terminal protocol crash), event forwarding, the stop
 * control, and the channel-disconnect fence — every closing path
 * cleanup-first, exit-last, exactly once. The cross-process truth of the
 * same loop runs in `worker-process.test.ts` over real forked children.
 */

/** An in-memory forked-channel pair: send → the other end's `message`; disconnect → both ends' `disconnect`. */
interface ChannelPair {
  readonly child: WorkerChannel;
  readonly parent: WorkerChannel;
  disconnect(): void;
}

function channelPair(): ChannelPair {
  const childEnd = new EventEmitter();
  const parentEnd = new EventEmitter();
  let connected = true;
  const side = (own: EventEmitter, other: EventEmitter): WorkerChannel => ({
    get connected() {
      return connected;
    },
    send: (message: unknown) => {
      if (!connected) return false;
      other.emit('message', message);
      return true;
    },
    on: (event, listener) => {
      own.on(event, listener);
      return own;
    },
    removeListener: (event, listener) => {
      own.removeListener(event, listener);
      return own;
    },
  });
  return {
    child: side(childEnd, parentEnd),
    parent: side(parentEnd, childEnd),
    disconnect: () => {
      if (connected) {
        connected = false;
        childEnd.emit('disconnect');
        parentEnd.emit('disconnect');
      }
    },
  };
}

/** A real worker served over the child end; everything the parent end receives. */
interface ServedLoop {
  readonly worker: ProjectWorker;
  readonly plane: FakePlane;
  readonly parent: WorkerChannel;
  readonly received: Array<Record<string, unknown>>;
  readonly exitCode: Promise<number>;
}

function serve(plane = fakePlane()): ServedLoop {
  const pair = channelPair();
  const worker = createProjectWorker({ plane: plane.plane, invalidationDebounceMs: 0 });
  const received: Array<Record<string, unknown>> = [];
  pair.parent.on('message', (message: unknown) => {
    received.push(message as Record<string, unknown>);
  });
  let resolveExit: (code: number) => void = () => {};
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  serveProjectWorker({
    channel: pair.child,
    worker,
    exitProcess: (code) => {
      resolveExit(code);
    },
  });
  return { worker, plane, parent: pair.parent, received, exitCode };
}

async function receivedCount(loop: ServedLoop, count: number): Promise<void> {
  await vi.waitFor(() => {
    if (loop.received.length < count) throw new Error('message not yet received');
  });
}

describe('isWorkerWireIn', () => {
  it('accepts the two typed wire messages and rejects everything else', () => {
    expect(isWorkerWireIn({ type: 'stop' })).toBe(true);
    expect(isWorkerWireIn({ type: 'inspect', id: 0, request: { kind: 'project' } })).toBe(true);
    expect(isWorkerWireIn({ type: 'inspect', id: 'x', request: { kind: 'project' } })).toBe(false);
    expect(isWorkerWireIn({ type: 'inspect', id: 1 })).toBe(false);
    expect(isWorkerWireIn({ type: 'restart' })).toBe(false);
    expect(isWorkerWireIn('stop')).toBe(false);
    expect(isWorkerWireIn(null)).toBe(false);
  });
});

describe('workerChannel', () => {
  it('lifts a process-shaped native channel onto the seam; refuses a process without one', () => {
    const native = {
      send: () => true,
      on: () => native,
      connected: true,
    } as unknown as NodeJS.Process;
    expect(workerChannel(native)).toBe(native);
    const channelless = { on: () => channelless, connected: false } as unknown as NodeJS.Process;
    expect(() => workerChannel(channelless)).toThrow(TypeError);
  });
});

describe('serveProjectWorker', () => {
  it('answers a typed inspection with its correlated result', async () => {
    const loop = serve();
    loop.parent.send({ type: 'inspect', id: 7, request: { kind: 'project' } });
    await receivedCount(loop, 1);
    expect(loop.received[0]).toEqual({
      type: 'inspect-result',
      id: 7,
      ok: true,
      result: {
        kind: 'project',
        revision: 1,
        payload: { certified: { astro: '7.2.10', vite: '8.2.2' } },
      },
    });
    await loop.worker.stop();
  });

  it('answers a malformed request with the malformed-request failure and stays alive', async () => {
    const loop = serve();
    loop.parent.send({ type: 'inspect', id: 1, request: { kind: 'eval' } });
    await receivedCount(loop, 1);
    expect(loop.received[0]).toEqual({
      type: 'inspect-result',
      id: 1,
      ok: false,
      failure: {
        code: 'malformed-request',
        message:
          'the request is not one of the typed project, content, routes, or styles inspection requests',
      },
    });

    loop.parent.send({ type: 'inspect', id: 2, request: { kind: 'routes' } });
    await receivedCount(loop, 2);
    expect((loop.received[1] as { ok: boolean }).ok).toBe(true);
    await loop.worker.stop();
  });

  it('forwards worker events (invalidation, diagnostic) over the channel', async () => {
    const loop = serve();
    const events: Array<Record<string, unknown>> = [];
    loop.parent.on('message', (message: unknown) => {
      if ((message as { type?: string }).type === 'event') {
        events.push((message as { event: Record<string, unknown> }).event);
      }
    });

    loop.plane.fireInvalidation('src/pages/index.astro');
    loop.plane.behaviors.content = 'adapter';
    loop.parent.send({ type: 'inspect', id: 1, request: { kind: 'content' } });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toEqual({
      type: 'invalidation',
      families: ['routes', 'styles'],
      revision: 1,
    });
    expect(events[1]).toEqual({
      type: 'diagnostic',
      level: 'error',
      message: 'the content inspection failed at the project adapter (seam-rejected)',
    });
    await loop.worker.stop();
  });

  it('the stop control runs cleanup, sends the close report, and exits clean', async () => {
    const loop = serve();
    loop.parent.send({ type: 'stop' });
    await vi.waitFor(() => expect(loop.received.some((m) => m.type === 'closed')).toBe(true));
    const closed = loop.received.find((m) => m.type === 'closed') as {
      report: { outcome: string; failures: string[] };
    };
    expect(closed.report.outcome).toBe('complete');
    expect(closed.report.failures).toEqual([]);
    expect(loop.plane.close.calls).toBe(1);
    expect(await loop.exitCode).toBe(EXIT_OK);
  });

  it('a message outside the wire union is a terminal protocol crash — cleanup first, forced exit code', async () => {
    const loop = serve();
    loop.parent.send({ type: 'spawn-server', port: 9999 });
    await vi.waitFor(() => expect(loop.received.some((m) => m.type === 'closed')).toBe(true));
    expect(loop.plane.close.calls).toBe(1); // cleanup ran before the exit
    expect(await loop.exitCode).toBe(EXIT_PROTOCOL);
  });

  it('a channel disconnect fences the worker: terminal stop, no sends down the dead channel, outcome exit', async () => {
    const plane = fakePlane();
    const pair = channelPair();
    const worker = createProjectWorker({ plane: plane.plane, invalidationDebounceMs: 0 });
    let exitCode: number | null = null;
    serveProjectWorker({
      channel: pair.child,
      worker,
      exitProcess: (code) => {
        exitCode = code;
      },
    });
    const received: unknown[] = [];
    pair.parent.on('message', (message: unknown) => received.push(message));

    pair.disconnect();
    await vi.waitFor(() => expect(exitCode).not.toBeNull());
    expect(plane.close.calls).toBe(1);
    expect(exitCode).toBe(EXIT_OK);
    expect(received).toEqual([]); // nothing is sent down a dead channel
  });
});
