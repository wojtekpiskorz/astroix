import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createSupervisedWorkerWire } from '../../project-plane/supervision/worker-wire.ts';
import { WorkerRejectionError } from '../../project-plane/worker/worker-failure.ts';
import type { WorkerChannel } from '../../project-plane/worker/worker-ipc.ts';

/**
 * The supervised worker-wire facet (#308 focused tests), in-process: the
 * id reservation (the supervisor's probe id 0 and `stop` never cross,
 * consumer traffic starts at 1), correlated dispatch settle/exception
 * paths, event forwarding, the closing gate, and channel death (by
 * disconnect and by the supervisor's exit observation) — every death
 * settles in-flight dispatches with the structured shutdown failure.
 * The cross-process truth over the REAL supervisor and stand-in children
 * runs in `supervision.process.test.ts`.
 */

/** One scriptable supervised wire: the facet over an in-memory channel. */
interface FakeWire {
  readonly wire: ReturnType<typeof createSupervisedWorkerWire>;
  /** Every message the facet forwarded into the channel. */
  readonly sent: unknown[];
  /** Emits one outbound frame from the child into the facet. */
  emit(message: unknown): void;
  /** Fires the channel's disconnect — channel death before the exit observation. */
  disconnectChannel(): void;
  /** Resolves the supervisor's gone observation (the child's exit). */
  childGone(): void;
  setClosing(closing: boolean): void;
  setConnected(connected: boolean): void;
  /** Makes the channel report backpressure: send() → false while still connected. */
  backpressure(on: boolean): void;
  /** The next send refuses by THROWING while `connected` still reads true — the ERR_IPC_CHANNEL_CLOSED exit-race shape. */
  throwOnNextSend(): void;
  /** The next send dies racing itself: the channel closes as it refuses the message. */
  dieOnNextSend(): void;
}

function fakeSupervisedWire(): FakeWire {
  const childEnd = new EventEmitter();
  let connected = true;
  let backpressured = false;
  let dieOnNextSend = false;
  let throwOnNextSend = false;
  let closing = false;
  const sent: unknown[] = [];
  const channel: WorkerChannel = {
    get connected() {
      return connected;
    },
    send(message: unknown) {
      if (throwOnNextSend) {
        throwOnNextSend = false;
        throw new Error('simulated ERR_IPC_CHANNEL_CLOSED');
      }
      if (dieOnNextSend) {
        dieOnNextSend = false;
        connected = false;
        return false;
      }
      if (backpressured) return false;
      if (!connected) return false;
      sent.push(message);
      return true;
    },
    on(event, listener) {
      childEnd.on(event, listener);
    },
    removeListener(event, listener) {
      childEnd.removeListener(event, listener);
    },
  };
  let resolveGone: () => void = () => {};
  const gone = new Promise<void>((resolve) => {
    resolveGone = resolve;
  });
  return {
    wire: createSupervisedWorkerWire({ channel, gone, closing: () => closing }),
    sent,
    emit: (message) => {
      childEnd.emit('message', message);
    },
    disconnectChannel: () => {
      connected = false;
      childEnd.emit('disconnect');
    },
    childGone: () => {
      resolveGone();
    },
    setClosing: (value) => {
      closing = value;
    },
    setConnected: (value) => {
      connected = value;
    },
    backpressure: (on) => {
      backpressured = on;
    },
    dieOnNextSend: () => {
      dieOnNextSend = true;
    },
    throwOnNextSend: () => {
      throwOnNextSend = true;
    },
  };
}

const PROJECT_RESULT = { kind: 'project', revision: 7, payload: { certified: {} } };

/** The structured-failure assertion: the E6 rejection species carrying the code. */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerRejectionError);
    return (error as WorkerRejectionError).failure.code;
  }
  throw new Error('the dispatch settled unexpectedly');
}

describe('the id reservation - the supervisor traffic never crosses', () => {
  it('refuses the stop control, the probe id, and off-union junk: send reports false and nothing is forwarded', () => {
    const fake = fakeSupervisedWire();
    expect(fake.wire.send({ type: 'stop' })).toBe(false);
    expect(fake.wire.send({ type: 'inspect', id: 0, request: { kind: 'project' } })).toBe(false);
    expect(fake.wire.send({ type: 'restart' })).toBe(false);
    expect(fake.wire.send('stop')).toBe(false);
    expect(fake.sent).toEqual([]);
  });

  it('forwards a typed consumer inspection (id ≥ 1) and withholds the probe answer and the close report', () => {
    const fake = fakeSupervisedWire();
    const seen: unknown[] = [];
    fake.wire.on('message', (message) => seen.push(message));
    expect(fake.wire.send({ type: 'inspect', id: 1, request: { kind: 'project' } })).toBe(true);
    expect(fake.sent).toEqual([{ type: 'inspect', id: 1, request: { kind: 'project' } }]);

    fake.emit({ type: 'inspect-result', id: 0, ok: true, result: PROJECT_RESULT }); // the probe's
    fake.emit({ type: 'closed', report: { outcome: 'complete' } }); // the supervisor's
    expect(seen).toEqual([]);
  });
});

describe('correlated dispatch', () => {
  it('allocates consumer ids from 1 and settles the correlated result', async () => {
    const fake = fakeSupervisedWire();
    const first = fake.wire.dispatch({ kind: 'project' });
    const second = fake.wire.dispatch({ kind: 'project' });
    expect(fake.sent).toEqual([
      { type: 'inspect', id: 1, request: { kind: 'project' } },
      { type: 'inspect', id: 2, request: { kind: 'project' } },
    ]);
    fake.emit({
      type: 'inspect-result',
      id: 2,
      ok: true,
      result: { ...PROJECT_RESULT, revision: 2 },
    });
    fake.emit({ type: 'inspect-result', id: 1, ok: true, result: PROJECT_RESULT });
    expect(await second).toMatchObject({ kind: 'project', revision: 2 });
    expect(await first).toBe(PROJECT_RESULT);
  });

  it('settles a failed answer as the structured worker rejection', async () => {
    const fake = fakeSupervisedWire();
    const dispatch = fake.wire.dispatch({ kind: 'project' });
    fake.emit({
      type: 'inspect-result',
      id: 1,
      ok: false,
      failure: { code: 'inspection-failed', message: 'the project inspection failed unexpectedly' },
    });
    expect(await rejectionCode(dispatch)).toBe('inspection-failed');
  });

  it('fails a malformed answer closed — structured shutdown, never a raw error or a hang', async () => {
    const fake = fakeSupervisedWire();
    const missingResult = fake.wire.dispatch({ kind: 'project' });
    fake.emit({ type: 'inspect-result', id: 1, ok: true }); // no result: wire drift
    expect(await rejectionCode(missingResult)).toBe('shutdown');
    const missingFailure = fake.wire.dispatch({ kind: 'project' });
    fake.emit({ type: 'inspect-result', id: 2, ok: false }); // no failure: wire drift
    expect(await rejectionCode(missingFailure)).toBe('shutdown');
  });

  it('under backpressure (send false on a LIVE channel) the dispatch stays pending, then settles', async () => {
    const fake = fakeSupervisedWire();
    fake.backpressure(true);
    const dispatch = fake.wire.dispatch({ kind: 'project' });
    fake.emit({ type: 'inspect-result', id: 1, ok: true, result: PROJECT_RESULT });
    expect(await dispatch).toBe(PROJECT_RESULT);
  });

  it('a never-sent (false on a dead channel) rejects structured shutdown immediately', async () => {
    const fake = fakeSupervisedWire();
    fake.setConnected(false);
    expect(await rejectionCode(fake.wire.dispatch({ kind: 'project' }))).toBe('shutdown');
  });

  it('a send that dies racing itself (refused as the channel closes) rejects structured too', async () => {
    const fake = fakeSupervisedWire();
    fake.dieOnNextSend();
    expect(await rejectionCode(fake.wire.dispatch({ kind: 'project' }))).toBe('shutdown');
    expect(fake.sent).toEqual([]); // nothing left the process — never-sent, never pending
  });

  it('a send that refuses by THROWING (the exit race: connected still true) rejects structured', async () => {
    const fake = fakeSupervisedWire();
    fake.throwOnNextSend();
    // The empirically observed shape: send() THROWS ERR_IPC_CHANNEL_CLOSED
    // in the exit→disconnect window while `connected` still reads true.
    expect(fake.wire.connected).toBe(true);
    expect(await rejectionCode(fake.wire.dispatch({ kind: 'project' }))).toBe('shutdown');
    expect(fake.sent).toEqual([]); // the message never left — never-sent, never a raw error
  });
});

describe('the closing gate and channel death', () => {
  it('rejects dispatches as structured shutdown once any close path began', async () => {
    const fake = fakeSupervisedWire();
    fake.setClosing(true);
    expect(fake.sent).toEqual([]);
    expect(await rejectionCode(fake.wire.dispatch({ kind: 'project' }))).toBe('shutdown');
  });

  it('dies with the channel (disconnect): connected false, send false, in-flight settled structured', async () => {
    const fake = fakeSupervisedWire();
    const inFlight = fake.wire.dispatch({ kind: 'project' });
    const disconnected: boolean[] = [];
    fake.wire.on('disconnect', () => disconnected.push(true));
    fake.disconnectChannel();
    expect(fake.wire.connected).toBe(false);
    expect(fake.wire.send({ type: 'inspect', id: 9, request: { kind: 'project' } })).toBe(false);
    expect(await rejectionCode(inFlight)).toBe('shutdown');
    expect(disconnected).toEqual([true]);
    expect(await rejectionCode(fake.wire.dispatch({ kind: 'project' }))).toBe('shutdown');
  });

  it('dies with the child (the exit observation) even before the channel notices', async () => {
    const fake = fakeSupervisedWire();
    const inFlight = fake.wire.dispatch({ kind: 'project' });
    fake.childGone();
    expect(await rejectionCode(inFlight)).toBe('shutdown');
    expect(fake.wire.connected).toBe(false);
  });
});

describe('event frames and listener removal', () => {
  it('forwards event frames to subscribers, raw listeners, and unbinds both', () => {
    const fake = fakeSupervisedWire();
    const events: unknown[] = [];
    const raw: unknown[] = [];
    const unsubscribe = fake.wire.subscribe((event) => events.push(event));
    const onRaw = (message: unknown): void => {
      raw.push(message);
    };
    fake.wire.on('message', onRaw);
    const invalidation = { type: 'invalidation', families: ['styles'], revision: 4 };
    fake.emit({ type: 'event', event: invalidation });
    expect(events).toEqual([invalidation]);
    expect(raw).toEqual([{ type: 'event', event: invalidation }]);

    unsubscribe();
    fake.wire.removeListener('message', onRaw);
    const onDisconnect = (): void => {
      throw new Error('the removed disconnect listener fired');
    };
    fake.wire.on('disconnect', onDisconnect);
    fake.wire.removeListener('disconnect', onDisconnect);
    fake.emit({ type: 'event', event: invalidation });
    fake.disconnectChannel();
    expect(events).toEqual([invalidation]);
    expect(raw).toEqual([{ type: 'event', event: invalidation }]);
  });

  it('passes non-reserved frames it cannot correlate to raw listeners unchanged', () => {
    const fake = fakeSupervisedWire();
    const raw: unknown[] = [];
    fake.wire.on('message', (message) => raw.push(message));
    const uncorrelated = { type: 'inspect-result', id: 99, ok: true, result: PROJECT_RESULT };
    fake.emit(uncorrelated);
    expect(raw).toEqual([uncorrelated]);
  });
});
