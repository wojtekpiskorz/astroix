import { describe, expect, it } from 'vitest';
import {
  BYPASS_SERVICE_WORKER_COMMAND,
  CDP_PROTOCOL_VERSION,
  createDebuggerGuard,
  type DebuggerGuardStep,
  type DebuggerSeam,
  NETWORK_ENABLE_COMMAND,
} from './debugger-guard.ts';

/**
 * The debugger guard's focused units (#247, H5): a scripted fake of the
 * structural seam (the real `webContents.debugger` satisfies it
 * unchanged) pinning the fail-closed state machine — the attach →
 * enable → bypass sequence, every failure kind's compromise, detach
 * retention, the deliberate-dispose expectation, and recovery. The
 * real-CDP truth is the `e2e/desktop` lane.
 */

/** One recorded CDP call, in order. */
interface RecordedCall {
  readonly kind: 'attach' | 'command';
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly protocolVersion?: string;
}

/** The scriptable fake: attach/commands may be set to fail; the detach and DevTools events are hand-fired. */
function fakeDebugger(): {
  seam: DebuggerSeam;
  calls(): readonly RecordedCall[];
  failAttach(error: Error): void;
  failCommand(method: string, error: Error): void;
  fireDetach(reason: string): void;
  fireDevtoolsOpened(): void;
  detachListeners(): number;
  devtoolsClosed(): boolean;
} {
  const calls: RecordedCall[] = [];
  const attachFailures: Error[] = [];
  const commandFailures = new Map<string, Error>();
  const detachHandlers: ((reason: string) => void)[] = [];
  const devtoolsHandlers: (() => void)[] = [];
  let devtoolsClosed = false;
  const seam: DebuggerSeam = {
    attach: (protocolVersion) => {
      const failure = attachFailures.shift();
      if (failure !== undefined) throw failure;
      calls.push({ kind: 'attach', protocolVersion });
    },
    sendCommand: (method, params) => {
      const failure = commandFailures.get(method);
      if (failure !== undefined) return Promise.reject(failure);
      calls.push({ kind: 'command', method, params });
      return Promise.resolve({});
    },
    // The self-detach echoes the real event the way Electron does.
    detach: () => {
      calls.push({ kind: 'command', method: '(self-detach)' });
      for (const handler of [...detachHandlers]) handler('The debugger is detached');
    },
    onDetach: (handler) => {
      detachHandlers.push(handler);
      return () => {
        const at = detachHandlers.indexOf(handler);
        if (at !== -1) detachHandlers.splice(at, 1);
      };
    },
    onDevtoolsOpened: (handler) => {
      devtoolsHandlers.push(handler);
      return () => {
        const at = devtoolsHandlers.indexOf(handler);
        if (at !== -1) devtoolsHandlers.splice(at, 1);
      };
    },
    closeDevtools: () => {
      devtoolsClosed = true;
    },
  };
  return {
    seam,
    calls: () => [...calls],
    failAttach: (error) => {
      attachFailures.push(error);
    },
    failCommand: (method, error) => {
      commandFailures.set(method, error);
    },
    fireDetach: (reason) => {
      for (const handler of [...detachHandlers]) handler(reason);
    },
    fireDevtoolsOpened: () => {
      for (const handler of [...devtoolsHandlers]) handler();
    },
    detachListeners: () => detachHandlers.length,
    devtoolsClosed: () => devtoolsClosed,
  };
}

describe('createDebuggerGuard — the fail-closed CDP bypass sequence', () => {
  it('attaches CDP 1.3, enables Network, then sets the bypass — in that order', async () => {
    const fake = fakeDebugger();
    const steps: DebuggerGuardStep[] = [];
    const guard = createDebuggerGuard({
      debugger: fake.seam,
      onStep: (step) => {
        steps.push(step);
      },
    });
    const result = await guard.activate();
    expect(result).toEqual({ ok: true });
    expect(guard.state()).toBe('bypassed');
    expect(guard.isBypassActive()).toBe(true);
    expect(fake.calls()).toEqual([
      { kind: 'attach', protocolVersion: CDP_PROTOCOL_VERSION },
      { kind: 'command', method: NETWORK_ENABLE_COMMAND },
      { kind: 'command', method: BYPASS_SERVICE_WORKER_COMMAND, params: { bypass: true } },
    ]);
    expect(steps).toEqual(['attached', 'network-enabled', 'bypass-set']);
    expect(CDP_PROTOCOL_VERSION).toBe('1.3');
    expect(BYPASS_SERVICE_WORKER_COMMAND).toBe('Network.setBypassServiceWorker');
  });

  it('is idempotent while bypassed and shares one concurrent activation', async () => {
    const fake = fakeDebugger();
    const guard = createDebuggerGuard({ debugger: fake.seam });
    const [first, second, third] = await Promise.all([
      guard.activate(),
      guard.activate(),
      guard.activate(),
    ]);
    expect([first, second, third]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    // One attach, one enable, one bypass — the concurrent calls joined one run.
    expect(fake.calls()).toHaveLength(3);
    const again = await guard.activate();
    expect(again).toEqual({ ok: true });
    expect(fake.calls()).toHaveLength(3);
  });

  it('compromises fail-closed when attach is refused (DevTools already holds the target)', async () => {
    const fake = fakeDebugger();
    fake.failAttach(new Error('Another debugger is already attached'));
    const failures: string[] = [];
    const guard = createDebuggerGuard({
      debugger: fake.seam,
      onCompromised: (failure) => {
        failures.push(failure.kind);
      },
    });
    const result = await guard.activate();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('attach-failed');
    expect(guard.state()).toBe('compromised');
    expect(guard.isBypassActive()).toBe(false);
    expect(guard.failure()?.kind).toBe('attach-failed');
    expect(failures).toEqual(['attach-failed']);
  });

  it('compromises when Network.enable or the bypass command rejects', async () => {
    const enableFake = fakeDebugger();
    enableFake.failCommand(NETWORK_ENABLE_COMMAND, new Error('enable refused'));
    const enableGuard = createDebuggerGuard({ debugger: enableFake.seam });
    const enableResult = await enableGuard.activate();
    expect(enableResult.ok).toBe(false);
    if (!enableResult.ok) expect(enableResult.failure.kind).toBe('network-enable-failed');
    expect(enableGuard.state()).toBe('compromised');

    const bypassFake = fakeDebugger();
    bypassFake.failCommand(BYPASS_SERVICE_WORKER_COMMAND, new Error('bypass refused'));
    const bypassGuard = createDebuggerGuard({ debugger: bypassFake.seam });
    const bypassResult = await bypassGuard.activate();
    expect(bypassResult.ok).toBe(false);
    if (!bypassResult.ok) expect(bypassResult.failure.kind).toBe('bypass-set-failed');
    expect(bypassGuard.state()).toBe('compromised');
    // The enable ran; the bypass never set — the sequence stopped at its failure.
    expect(bypassFake.calls()).toHaveLength(2);
  });

  it('treats a detach after activation as a retention failure (the DevTools law)', async () => {
    const fake = fakeDebugger();
    const failures: { kind: string; detail: string }[] = [];
    const guard = createDebuggerGuard({
      debugger: fake.seam,
      onCompromised: (failure) => {
        failures.push({ kind: failure.kind, detail: failure.detail });
      },
    });
    await guard.activate();
    fake.fireDetach('Target closed');
    expect(guard.state()).toBe('compromised');
    expect(guard.isBypassActive()).toBe(false);
    expect(guard.failure()).toEqual({ kind: 'debugger-detached', detail: 'Target closed' });
    expect(failures).toEqual([{ kind: 'debugger-detached', detail: 'Target closed' }]);
  });

  it('recovers by re-running the sequence after a compromise (the reloaded target)', async () => {
    const fake = fakeDebugger();
    const guard = createDebuggerGuard({ debugger: fake.seam });
    await guard.activate();
    fake.fireDetach('replaced with another debugger');
    expect(guard.isBypassActive()).toBe(false);
    const recovered = await guard.activate();
    expect(recovered).toEqual({ ok: true });
    expect(guard.isBypassActive()).toBe(true);
    // The second run is a full second sequence.
    expect(fake.calls()).toHaveLength(6);
    expect(fake.calls().filter((call) => call.kind === 'attach')).toHaveLength(2);
  });

  it('reports the racing detach once when it fires mid-activation', async () => {
    const detachHandlers: ((reason: string) => void)[] = [];
    let settleEnable: (() => void) | null = null;
    // Network.enable never settles on its own — the racing detach is the only exit.
    const seam: DebuggerSeam = {
      attach: () => {},
      sendCommand: (method) =>
        method === NETWORK_ENABLE_COMMAND
          ? new Promise((resolve) => {
              settleEnable = () => resolve({});
            })
          : Promise.resolve({}),
      detach: () => {},
      onDetach: (handler) => {
        detachHandlers.push(handler);
        return () => {
          const at = detachHandlers.indexOf(handler);
          if (at !== -1) detachHandlers.splice(at, 1);
        };
      },
      onDevtoolsOpened: () => () => {},
      closeDevtools: () => {},
    };
    const failures: string[] = [];
    const guard = createDebuggerGuard({
      debugger: seam,
      onCompromised: (failure) => {
        failures.push(failure.kind);
      },
    });
    const pending = guard.activate();
    for (const handler of [...detachHandlers]) handler('DevTools invoked');
    (settleEnable as (() => void) | null)?.();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('debugger-detached');
    expect(failures).toEqual(['debugger-detached']);
    expect(guard.state()).toBe('compromised');
  });

  it('shares the in-flight activation across retries — a mid-flight compromise never runs two sequences in parallel', async () => {
    // A controllable Network.enable: the step pends until the test
    // releases it, so the compromise can land mid-activation.
    const detachHandlers: ((reason: string) => void)[] = [];
    let releaseEnable: (() => void) | null = null;
    const calls: string[] = [];
    const seam: DebuggerSeam = {
      attach: () => {
        calls.push('attach');
      },
      sendCommand: (method) => {
        calls.push(method);
        if (method === NETWORK_ENABLE_COMMAND) {
          return new Promise((resolve) => {
            releaseEnable = () => resolve({});
          });
        }
        return Promise.resolve({});
      },
      detach: () => {},
      onDetach: (handler) => {
        detachHandlers.push(handler);
        return () => {
          const at = detachHandlers.indexOf(handler);
          if (at !== -1) detachHandlers.splice(at, 1);
        };
      },
      onDevtoolsOpened: () => () => {},
      closeDevtools: () => {},
    };
    const failures: string[] = [];
    const guard = createDebuggerGuard({
      debugger: seam,
      onCompromised: (failure) => {
        failures.push(failure.kind);
      },
    });

    // Two concurrent activations: the second MUST ride the first —
    // one attach, one pending enable, never a parallel sequence.
    const first = guard.activate();
    const second = guard.activate();
    expect(second).toBe(first);
    expect(calls).toEqual(['attach', NETWORK_ENABLE_COMMAND]);

    // The compromise lands mid-activation (the detach listener fires
    // while Network.enable pends); the pending step then settles.
    for (const handler of [...detachHandlers]) handler('replaced with another debugger');
    (releaseEnable as (() => void) | null)?.();
    const compromised = await first;
    expect(compromised.ok).toBe(false);
    if (!compromised.ok) expect(compromised.failure.kind).toBe('debugger-detached');
    // Exactly one compromise report — the settled shared run reported
    // the detach, and no parallel run existed to misreport it.
    expect(failures).toEqual(['debugger-detached']);
    expect(guard.state()).toBe('compromised');

    // The retry AFTER the settle is a clean, sequential second run —
    // the slot was cleared, so it re-runs the whole sequence alone
    // (including its OWN pending enable, released here).
    // The compromised first run sent no bypass command after the detach
    // was observed; the retry alone completes the second sequence.
    const retryPending = guard.activate();
    expect(calls).toEqual(['attach', NETWORK_ENABLE_COMMAND, 'attach', NETWORK_ENABLE_COMMAND]);
    (releaseEnable as (() => void) | null)?.();
    const retry = await retryPending;
    expect(retry).toEqual({ ok: true });
    expect(guard.isBypassActive()).toBe(true);
    expect(calls).toEqual([
      'attach',
      NETWORK_ENABLE_COMMAND,
      'attach',
      NETWORK_ENABLE_COMMAND,
      BYPASS_SERVICE_WORKER_COMMAND,
    ]);
    expect(failures).toEqual(['debugger-detached']);
  });

  it('compromises fail-closed when DevTools opens: kicked off, slot cleaned, one report, recovery after', async () => {
    const fake = fakeDebugger();
    const failures: string[] = [];
    const guard = createDebuggerGuard({
      debugger: fake.seam,
      onCompromised: (failure) => {
        failures.push(failure.kind);
      },
    });
    await guard.activate();
    // DevTools opens on the authoritative target: the guard observes
    // it, kicks DevTools off, cleans the debugger slot, and reports
    // exactly one compromise — the self-detach echo is swallowed.
    fake.fireDevtoolsOpened();
    expect(fake.devtoolsClosed()).toBe(true);
    expect(guard.state()).toBe('compromised');
    expect(guard.isBypassActive()).toBe(false);
    expect(guard.failure()?.kind).toBe('devtools-opened');
    expect(failures).toEqual(['devtools-opened']);
    // Recovery: the cleaned slot re-attaches into a full new sequence.
    const recovered = await guard.activate();
    expect(recovered).toEqual({ ok: true });
    expect(guard.isBypassActive()).toBe(true);
    // A DevTools opening after dispose is nothing at all.
    guard.dispose();
    fake.fireDevtoolsOpened();
    expect(failures).toEqual(['devtools-opened']);
  });

  it('treats the post-dispose detach as the expected unload echo, and never re-activates', async () => {
    const fake = fakeDebugger();
    const failures: string[] = [];
    const guard = createDebuggerGuard({
      debugger: fake.seam,
      onCompromised: (failure) => {
        failures.push(failure.kind);
      },
    });
    await guard.activate();
    guard.dispose();
    fake.fireDetach('webContents closed');
    expect(failures).toEqual([]);
    expect(guard.state()).toBe('closed');
    expect(guard.isBypassActive()).toBe(false);
    const afterClose = await guard.activate();
    expect(afterClose.ok).toBe(false);
    // Deliberate teardown is its own failure kind — never misattributed
    // to the attach-refused (DevTools-holds-target) class, and never a
    // compromise report.
    if (!afterClose.ok) expect(afterClose.failure.kind).toBe('disposed');
    expect(failures).toEqual([]);
    expect(fake.detachListeners()).toBe(0);
  });
});
