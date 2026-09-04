import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { BootCapability } from '@wojciechpiskorz/astroix-runtime/private-boot';
import { describe, expect, it } from 'vitest';
import {
  bootedReport,
  parseDesktopChildReport,
  registerResultReport,
  transitionResultReport,
} from './child-protocol.ts';
import {
  type ControlPlaneClient,
  type ControlPlaneLossReason,
  connectControlPlaneChild,
  type SpawnedChildHandle,
} from './control-plane-client.ts';

/**
 * The main-side control-plane client's focused units (#243): the one-use
 * capability as the channel's FIRST message (fresh-minted, wire-shaped),
 * request correlation, and the two hard policies — terminal loss with
 * fail-closed calls (no restart path exists), and the ordered stop
 * (disconnect → bounded graceful exit → forced kill).
 */

const SESSION_REF: SessionRef = { runtimeEpoch: 'epoch-1', generation: 1 };
const BOOT_DEADLINE = 60_000;

type ExitListener = (code: number | null, signal: string | null) => void;

/** The fake spawned child — a manually-driven duplex the test plays as the child's other end. */
class FakeChild implements SpawnedChildHandle {
  readonly sent: unknown[] = [];
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];
  private readonly exitListeners: ExitListener[] = [];
  disconnected = false;
  killed = false;
  failSend = false;
  send(message: unknown): boolean | null {
    if (this.failSend || this.disconnected) return false;
    this.sent.push(message);
    return true;
  }
  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener();
  }
  kill(): void {
    this.killed = true;
    this.exit(1, 'SIGKILL');
  }
  onMessage(handler: (message: unknown) => void): void {
    this.messageListeners.push(handler);
  }
  onDisconnect(handler: () => void): void {
    this.disconnectListeners.push(handler);
  }
  onExit(handler: ExitListener): void {
    this.exitListeners.push(handler);
  }
  /** The child's reply path. */
  reply(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }
  /** The child's spontaneous exit path — models node: `exit` fires, the channel's `disconnect` arrives around it (the client is idempotent). */
  exit(code: number | null, signal: string | null): void {
    this.disconnected = true;
    for (const listener of this.exitListeners.splice(0)) listener(code, signal);
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

interface Connected {
  readonly client: ControlPlaneClient;
  readonly child: FakeChild;
  readonly losses: ControlPlaneLossReason[];
  readonly boots: number[];
  readonly sessionState: (SessionRef | null)[];
}

function connect(child: FakeChild, bootDeadlineMs: number = BOOT_DEADLINE): Connected {
  const losses: ControlPlaneLossReason[] = [];
  const boots: number[] = [];
  const sessionState: (SessionRef | null)[] = [];
  const client = connectControlPlaneChild({
    handle: child,
    bootDeadlineMs,
    host: {
      onBooted: (port) => boots.push(port),
      onLost: (reason) => losses.push(reason),
      onSessionState: (ref) => sessionState.push(ref),
      onHostObservationAsk: () => {},
      onDocumentCapability: () => {},
    },
  });
  return { client, child, losses, boots, sessionState };
}

function isCapabilityWire(message: unknown): boolean {
  const record = message as Record<string, unknown> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    record.astroix === 'astroix.private-boot-capability' &&
    typeof record.capability === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(record.capability)
  );
}

describe('connectControlPlaneChild — the boot conferral', () => {
  it('sends a freshly minted one-use capability as the channel FIRST message', () => {
    const { child } = connect(new FakeChild());
    expect(child.sent).toHaveLength(1);
    expect(isCapabilityWire(child.sent[0])).toBe(true);
    expect(BootCapability.mint().toWireMessage().astroix).toBe('astroix.private-boot-capability');
  });

  it('marks the client lost when the capability send cannot go through', () => {
    const child = new FakeChild();
    child.failSend = true;
    const { losses } = connect(child);
    expect(losses).toEqual(['channel-closed']);
  });
});

describe('connectControlPlaneChild — correlation', () => {
  it('resolves a register reply by its request id and ignores foreign ids', async () => {
    const { client, child } = connect(new FakeChild());
    const pending = client.registerRoot('/a/root');
    child.reply(
      registerResultReport(99, {
        ok: true,
        summary: { projectKey: 'x', displayName: 'x', availability: 'available' },
      }),
    );
    child.reply(registerResultReport(1, { ok: false, code: 'root-unavailable' }));
    await expect(pending).resolves.toEqual({ ok: false, code: 'root-unavailable' });
  });

  it('drops a kind-mismatched reply whole — the pending entry survives for the real reply', async () => {
    const { client, child } = connect(new FakeChild());
    const pending = client.registerRoot('/a/root');
    // a transition-result answering a register request: drifted correlation.
    // The entry must NOT be consumed — the real reply (or the loss policy)
    // settles the call, never silence.
    child.reply(transitionResultReport(1, { kind: 'refused', reason: 'stale-session' }));
    const settledEarly = await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      Promise.resolve(false),
    ]);
    expect(settledEarly).toBe(false);
    child.reply(
      registerResultReport(1, {
        ok: true,
        summary: { projectKey: 'x', displayName: 'x', availability: 'available' },
      }),
    );
    await expect(pending).resolves.toEqual({
      ok: true,
      summary: { projectKey: 'x', displayName: 'x', availability: 'available' },
    });
  });

  it('drops drifted channel messages without settling anything', async () => {
    const { client, child } = connect(new FakeChild());
    const pending = client.activate('key123');
    child.reply('garbage');
    child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'transition-result',
      requestId: 1,
      outcome: { kind: 'refused', reason: 'not-a-reason' },
    });
    child.reply(transitionResultReport(1, { kind: 'refused', reason: 'transition-failed' }));
    await expect(pending).resolves.toEqual({ kind: 'refused', reason: 'transition-failed' });
  });

  it('surfaces booted (with the composition port) and session-state reports', async () => {
    const { client, child, boots, sessionState } = connect(new FakeChild());
    child.reply(bootedReport(4426));
    await expect(client.booted).resolves.toBe(4426);
    expect(boots).toEqual([4426]);
    // A booted report without a port is drifted — the boot never settles
    // on it (the deadline policy owns the surface).
    expect(
      parseDesktopChildReport({ astroix: 'astroix.desktop-private-channel', kind: 'booted' }),
    ).toBeNull();
    child.reply({
      astroix: 'astroix.desktop-private-channel',
      kind: 'session-state',
      sessionRef: SESSION_REF,
    });
    expect(sessionState).toEqual([SESSION_REF]);
  });
});

describe('connectControlPlaneChild — the loss policy (fail closed, never restarted)', () => {
  it('fails every pending and later call closed when the channel closes', async () => {
    const { client, child, losses } = connect(new FakeChild());
    const register = client.registerRoot('/a/root');
    const activate = client.activate('key123');
    child.disconnect();
    await expect(register).resolves.toEqual({ ok: false, code: 'control-plane-unavailable' });
    await expect(activate).resolves.toEqual({
      kind: 'refused',
      reason: 'control-plane-unavailable',
    });
    await expect(client.deactivate(SESSION_REF)).resolves.toEqual({
      kind: 'refused',
      reason: 'control-plane-unavailable',
    });
    expect(client.connected).toBe(false);
    expect(losses).toEqual(['channel-closed']);
  });

  it("marks the child's spontaneous exit lost and fails later calls closed", async () => {
    const child = new FakeChild();
    const { client, losses } = connect(child);
    child.exit(73, null);
    await expect(client.deactivate(SESSION_REF)).resolves.toEqual({
      kind: 'refused',
      reason: 'control-plane-unavailable',
    });
    expect(losses).toEqual(['child-exit']);
  });

  it('resolves the boot promise false and marks lost when the boot deadline passes', async () => {
    const { losses, boots } = connect(new FakeChild(), 5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(losses).toEqual(['boot-timeout']);
    expect(boots).toEqual([]);
  });
});

describe('connectControlPlaneChild — the ordered stop', () => {
  it('disconnects, awaits the graceful exit, and answers graceful', async () => {
    const { client, child } = connect(new FakeChild());
    const stopped = client.stop(1000);
    await Promise.resolve();
    expect(child.disconnected).toBe(true);
    child.exit(0, null);
    await expect(stopped).resolves.toBe('graceful');
  });

  it('force-kills after the graceful bound and answers forced', async () => {
    const { client, child } = connect(new FakeChild());
    const stopped = client.stop(10);
    await expect(stopped).resolves.toBe('forced');
    expect(child.killed).toBe(true);
  });

  it('answers already-exited without touching the child', async () => {
    const child = new FakeChild();
    const { client } = connect(child);
    child.exit(0, null);
    await expect(client.stop(1000)).resolves.toBe('already-exited');
  });

  it('is idempotent — one stop run settles every call', async () => {
    const { client, child } = connect(new FakeChild());
    const first = client.stop(1000);
    child.exit(0, null);
    await expect(first).resolves.toBe('graceful');
    await expect(client.stop(1000)).resolves.toBe('graceful');
  });
});
