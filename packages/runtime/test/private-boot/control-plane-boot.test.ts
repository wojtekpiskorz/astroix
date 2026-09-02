import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { currentRuntimePin } from '../../kernel-lease/kernel-lease.ts';
import {
  BootCapability,
  BootCapabilityError,
  bootControlPlane,
  EXIT_BOOT_PROTOCOL,
  EXIT_FENCED,
  EXIT_LEASE_CONTENTION,
  EXIT_LEASE_FAILURE,
  type RegistryAuthority,
  receiveBootCapability,
} from '../../private-boot/control-plane-boot.ts';
import type { PrivateIpcChannel } from '../../private-boot/private-ipc.ts';

/**
 * The boot authority state machine (#222 focused tests) over a real
 * in-memory implementation of the PrivateIpcChannel transport and real
 * kernel-lease files: the one-use capability receive, the
 * capability→lease→held ordering, the disconnect fence ordering (fence →
 * listener release → exit), and the web-entry refusal (no channel, no
 * boot, no lease file). Exit is the injected transition here so the
 * ordering is observable; the real exit path runs in the process lane.
 */

const scratchDirs: string[] = [];

interface ChannelPair {
  main: EventEmitter;
  child: PrivateIpcChannel;
}

/** A real duplex pair implementing the channel interface — the parent end stays in the test. */
function channelPair(): ChannelPair {
  const main = new EventEmitter();
  const childEvents = new EventEmitter();
  let connected = true;
  const close = (): void => {
    if (!connected) return;
    connected = false;
    childEvents.emit('disconnect');
  };
  main.on('send', (message: unknown) => {
    if (connected) childEvents.emit('message', message);
  });
  main.on('disconnect', close);
  const child: PrivateIpcChannel = {
    get connected() {
      return connected;
    },
    send: (message) => {
      if (!connected) return false;
      main.emit('message', message);
      return true;
    },
    on: (event, listener) => childEvents.on(event, listener),
    removeListener: (event, listener) => childEvents.removeListener(event, listener),
  };
  return { main, child };
}

function sendCapability(main: EventEmitter, capability: BootCapability): void {
  main.emit('send', capability.toWireMessage());
}

interface BootRecord {
  exits: number[];
  held: RegistryAuthority[];
  authority: Promise<RegistryAuthority>;
}

function boot(pair: ChannelPair, privateStateDirectory: string): BootRecord {
  const exits: number[] = [];
  const held: RegistryAuthority[] = [];
  const authority = bootControlPlane({
    channel: pair.child,
    privateStateDirectory,
    qualifiedRuntime: currentRuntimePin(),
    onAuthorityHeld: (heldAuthority) => held.push(heldAuthority),
    exitProcess: (exitCode) => {
      exits.push(exitCode);
    },
  });
  return { exits, held, authority };
}

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'astroix-boot-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('BootCapability', () => {
  it('mints fresh one-use capabilities — never the same secret twice', () => {
    const first = BootCapability.mint().toWireMessage();
    const second = BootCapability.mint().toWireMessage();
    expect(first.astroix).toBe('astroix.private-boot-capability');
    expect(first.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.capability).not.toBe(second.capability);
  });

  it('rejects a first message that is not the capability', () => {
    expect(() => BootCapability.fromWireMessage({ type: 'hello' })).toThrow(BootCapabilityError);
    expect(() => BootCapability.fromWireMessage(null)).toThrow(BootCapabilityError);
    expect(() =>
      BootCapability.fromWireMessage({
        astroix: 'astroix.private-boot-capability',
        capability: 'short',
      }),
    ).toThrow(BootCapabilityError);
  });
});

describe('receiveBootCapability — the one-use gate', () => {
  it('consumes the channel boot exactly once — a second receive is a protocol violation', async () => {
    const pair = channelPair();
    const first = receiveBootCapability(pair.child);
    sendCapability(pair.main, BootCapability.mint());
    await expect(first).resolves.toBeInstanceOf(BootCapability);
    await expect(receiveBootCapability(pair.child)).rejects.toBeInstanceOf(BootCapabilityError);
  });

  it('rejects on a channel that closed before the capability', async () => {
    const pair = channelPair();
    pair.main.emit('disconnect');
    await expect(receiveBootCapability(pair.child)).rejects.toBeInstanceOf(BootCapabilityError);
  });
});

describe('bootControlPlane — capability gate', () => {
  it('holds the registry-writer lease and confers authority only after the capability', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    sendCapability(pair.main, BootCapability.mint());
    const authority = await record.authority;
    expect(record.held).toEqual([authority]);
    expect(authority.state).toBe('held');
    expect(authority.isHeld()).toBe(true);
    authority.assertHeld();
    expect(record.exits).toEqual([]);
  });

  it('refuses a malformed first message: no boot, no lease file, protocol exit', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    pair.main.emit('send', { type: 'not-a-capability' });
    await expect(record.authority).rejects.toBeInstanceOf(BootCapabilityError);
    expect(record.exits).toEqual([EXIT_BOOT_PROTOCOL]);
    expect(record.held).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a disconnected channel: the web-entry shape never touches the lease', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    pair.main.emit('disconnect');
    const record = boot(pair, dir);
    await expect(record.authority).rejects.toBeInstanceOf(BootCapabilityError);
    expect(record.exits).toEqual([EXIT_BOOT_PROTOCOL]);
    expect(record.held).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('disconnect mid-handshake terminates before acquisition', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    pair.main.emit('disconnect');
    await expect(record.authority).rejects.toBeInstanceOf(Error);
    expect(record.exits).toEqual([EXIT_BOOT_PROTOCOL]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a capability immediately followed by disconnect never acquires — the exit already fired', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    // Both events in one tick: the receive resolves, but the disconnect
    // terminated the boot first — the continuation must stop before the lease.
    sendCapability(pair.main, BootCapability.mint());
    pair.main.emit('disconnect');
    await expect(record.authority).rejects.toBeInstanceOf(Error);
    expect(record.exits).toEqual([EXIT_BOOT_PROTOCOL]);
    expect(record.held).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('bootControlPlane — lease outcomes', () => {
  it('exits with contention and never confers authority while a live holder owns the lease', async () => {
    const dir = await makeStateDir();
    const planted = new DatabaseSync(join(dir, 'registry-writer.sqlite'), { timeout: 0 });
    planted.exec('BEGIN IMMEDIATE');
    const pair = channelPair();
    const record = boot(pair, dir);
    sendCapability(pair.main, BootCapability.mint());
    await expect(record.authority).rejects.toMatchObject({
      code: 'ASTROIX_KERNEL_LEASE_UNAVAILABLE',
    });
    expect(record.exits).toEqual([EXIT_LEASE_CONTENTION]);
    expect(record.held).toEqual([]);
    planted.close();
  });

  it('exits with failure on a wrong runtime pin', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const exits: number[] = [];
    const authority = bootControlPlane({
      channel: pair.child,
      privateStateDirectory: dir,
      qualifiedRuntime: { ...currentRuntimePin(), nodeVersion: 'v0.0.0-astroix-wrong' },
      exitProcess: (exitCode) => {
        exits.push(exitCode);
      },
    });
    sendCapability(pair.main, BootCapability.mint());
    await expect(authority).rejects.toMatchObject({
      code: 'ASTROIX_KERNEL_LEASE_RUNTIME_UNQUALIFIED',
    });
    expect(exits).toEqual([EXIT_LEASE_FAILURE]);
  });

  it('maps a non-lease failure onto the failure exit too — fail closed for any error shape', async () => {
    const pair = channelPair();
    const exits: number[] = [];
    const authority = bootControlPlane({
      channel: pair.child,
      privateStateDirectory: '', // a composition bug: the lease module rejects it with a TypeError
      qualifiedRuntime: currentRuntimePin(),
      exitProcess: (exitCode) => {
        exits.push(exitCode);
      },
    });
    sendCapability(pair.main, BootCapability.mint());
    await expect(authority).rejects.toBeInstanceOf(TypeError);
    expect(exits).toEqual([EXIT_LEASE_FAILURE]);
  });
});

describe('bootControlPlane — disconnect fencing', () => {
  it('fences first, then releases listeners in order, then exits once', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    sendCapability(pair.main, BootCapability.mint());
    const authority = await record.authority;
    const releaseOrder: string[] = [];
    authority.releaseOnFence(() => {
      releaseOrder.push(authority.isHeld() ? 'listener-held' : 'listener-fenced');
      releaseOrder.push(`state:${authority.state}`);
    });
    authority.releaseOnFence(() => {
      releaseOrder.push('second');
    });
    pair.main.emit('disconnect');
    expect(releaseOrder).toEqual(['listener-fenced', 'state:fenced', 'second']);
    expect(authority.state).toBe('fenced');
    expect(() => authority.assertHeld()).toThrowError(
      expect.objectContaining({ name: 'RegistryFencedError' }),
    );
    expect(() => authority.releaseOnFence(() => {})).toThrowError(
      expect.objectContaining({ name: 'RegistryFencedError' }),
    );
    expect(record.exits).toEqual([EXIT_FENCED]);
  });

  it('keeps the fence idempotent across repeated disconnects', async () => {
    const dir = await makeStateDir();
    const pair = channelPair();
    const record = boot(pair, dir);
    sendCapability(pair.main, BootCapability.mint());
    const authority = await record.authority;
    let releases = 0;
    authority.releaseOnFence(() => {
      releases += 1;
    });
    pair.main.emit('disconnect');
    pair.main.emit('disconnect');
    expect(releases).toBe(1);
    expect(record.exits).toEqual([EXIT_FENCED]);
  });
});
