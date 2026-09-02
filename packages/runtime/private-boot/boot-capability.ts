import { randomBytes } from 'node:crypto';
import type { PrivateIpcChannel } from './private-ipc.ts';

/**
 * The one-use private boot capability (ADR-0006 §2): Electron main gives
 * one exact control-plane child the capability over private IPC, and that
 * child — and only it — may proceed to acquire the kernel registry-writer
 * lease. Web entry points cannot acquire registry write authority because
 * they cannot possess a private IPC channel: `receiveBootCapability` is
 * the only construction path of a received capability, the receive gate
 * accepts only the private first message, and the gate fires once per
 * channel (`one-use`: a replay or a second receive is a protocol
 * violation).
 *
 * Trust reasoning, stated honestly: the capability is conferral, not
 * exclusion. Its bearer-proof is the channel itself — a pipe whose other
 * end only the spawning main holds — so a capability that arrives here
 * arrived because main sent it to this exact child. Exclusion between
 * children (a second control plane, a replacement main's child) is the
 * kernel lease's job; the capability decides who may *try*, the lease
 * decides who *holds*. Main must mint one fresh capability per boot and
 * never reuse one across children; nothing here would dignify a replay
 * with a second acquisition.
 */

const BOOT_CAPABILITY_TAG = 'astroix.private-boot-capability';
/** 32 random bytes → 43 base64url characters; the exact shape a valid wire message carries. */
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The private wire message main sends down the channel exactly once. */
export interface BootCapabilityWireMessage {
  readonly astroix: typeof BOOT_CAPABILITY_TAG;
  readonly capability: string;
}

/** Raised when the private boot protocol is violated — the channel is dead to booting after this. */
export class BootCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootCapabilityError';
  }
}

/**
 * The opaque one-use capability. Only `mint` (the main side) and the
 * private channel receive path construct one; there is no public
 * constructor and no other way to fabricate a received capability.
 */
export class BootCapability {
  private readonly secret: string;

  private constructor(secret: string) {
    this.secret = secret;
  }

  /** Mints a fresh, never-before-used capability (main side, one per boot). */
  static mint(): BootCapability {
    return new BootCapability(randomBytes(32).toString('base64url'));
  }

  /** The wire form — the only form that crosses the channel. */
  toWireMessage(): BootCapabilityWireMessage {
    return { astroix: BOOT_CAPABILITY_TAG, capability: this.secret };
  }

  /** Validates a received first message and lifts it into a capability. */
  static fromWireMessage(message: unknown): BootCapability {
    if (
      typeof message !== 'object' ||
      message === null ||
      (message as Record<string, unknown>).astroix !== BOOT_CAPABILITY_TAG ||
      typeof (message as Record<string, unknown>).capability !== 'string' ||
      !CAPABILITY_PATTERN.test((message as Record<string, unknown>).capability as string)
    ) {
      throw new BootCapabilityError(
        'the first private IPC message was not the one-use boot capability',
      );
    }
    return new BootCapability((message as Record<string, unknown>).capability as string);
  }
}

/** Channels that already consumed their one boot receive — the one-use gate. */
const bootedChannels = new WeakSet<object>();

/**
 * Waits for the boot capability as the channel's first message and
 * consumes it. Resolves exactly once per channel; a channel whose receive
 * was already consumed, a channel that closed first, or a first message
 * that is not the capability rejects with `BootCapabilityError`.
 */
export function receiveBootCapability(channel: PrivateIpcChannel): Promise<BootCapability> {
  if (bootedChannels.has(channel)) {
    return Promise.reject(
      new BootCapabilityError('this private IPC channel already consumed its one-use boot'),
    );
  }
  bootedChannels.add(channel);
  return new Promise<BootCapability>((resolve, reject) => {
    if (!channel.connected) {
      reject(new BootCapabilityError('the private IPC channel closed before the boot capability'));
      return;
    }
    const detach = (): void => {
      // settle-once hygiene: without this the stale onMessage re-runs
      // fromWireMessage on every later IPC message for the process lifetime
      channel.removeListener('message', onMessage);
      channel.removeListener('disconnect', onDisconnect);
    };
    const onMessage = (message: unknown): void => {
      detach();
      try {
        resolve(BootCapability.fromWireMessage(message));
      } catch (error) {
        reject(error instanceof Error ? error : new BootCapabilityError('invalid boot message'));
      }
    };
    const onDisconnect = (): void => {
      detach();
      reject(new BootCapabilityError('the private IPC channel closed before the boot capability'));
    };
    channel.on('message', onMessage);
    channel.on('disconnect', onDisconnect);
  });
}
