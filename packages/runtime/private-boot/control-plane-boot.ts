import {
  createKernelLeaseModule,
  KernelLeaseError,
  type QualifiedRuntimePin,
} from '../kernel-lease/kernel-lease.ts';
import { BootCapabilityError, receiveBootCapability } from './boot-capability.ts';
import type { PrivateIpcChannel } from './private-ipc.ts';

/**
 * Control-plane boot authority (ADR-0006 §2, #222): the private seam that
 * decides who may boot the control plane with registry write authority.
 * The exact child Electron main spawned receives one private boot
 * capability over this channel, then — and only then — acquires and
 * lifetime-holds the kernel `registry-writer` lease. Listener binding and
 * project spawning belong after that acquisition; a child that cannot
 * acquire never reaches them.
 *
 * Closing the private IPC channel is terminal for registry authority
 * (ADR-0006 §2): the child immediately fences registry writes, releases
 * its listeners, and exits — the exit is the writer-lease release, the
 * only release the kernel lease has. A replacement main's child fails
 * closed (`ASTROIX_KERNEL_LEASE_UNAVAILABLE`) until the old child's
 * process exit has actually released the lease; the boot capability alone
 * is never a durable lock.
 *
 * Web entry points cannot acquire registry write authority: web mode has
 * no private IPC channel, and a boot over a channel that is not connected,
 * or whose first message is not the one-use capability, refuses before
 * the lease file is ever touched.
 */

export {
  BootCapability,
  BootCapabilityError,
  type BootCapabilityWireMessage,
  receiveBootCapability,
} from './boot-capability.ts';
export { type PrivateIpcChannel, processChannel } from './private-ipc.ts';

/** sysexits.h exits, matching the #209 proof's holder convention. */
/** Fenced shutdown after a held boot — authority ended normally with the channel. */
export const EXIT_FENCED = 0;
/** Lease contention (EX_CANTCREAT): another live process holds the lease. */
export const EXIT_LEASE_CONTENTION = 73;
/** Any other lease or runtime failure (EX_IOERR) — fail closed, never contention. */
export const EXIT_LEASE_FAILURE = 74;
/** Private boot protocol violation (EX_PROTOCOL): no capability, no channel, bad first message. */
export const EXIT_BOOT_PROTOCOL = 76;

const FENCED_MESSAGE =
  'registry authority is fenced: the private IPC channel to main closed and this child is exiting';

/** Raised by `assertHeld()` once the authority is fenced. */
export class RegistryFencedError extends Error {
  constructor() {
    super(FENCED_MESSAGE);
    this.name = 'RegistryFencedError';
  }
}

export type RegistryAuthorityState = 'held' | 'fenced';

/**
 * The boot-scoped registry write authority. `held` from the moment the
 * kernel lease is acquired; `fenced` — terminally — the instant the
 * private IPC channel disconnects. Registry mutations compose
 * `assertHeld()` as their write fence; listener-owned resources register
 * their release so the disconnect path closes them before the exit.
 */
export interface RegistryAuthority {
  readonly state: RegistryAuthorityState;
  isHeld(): boolean;
  /** The write fence: throws `RegistryFencedError` once fenced. */
  assertHeld(): void;
  /** Registers one listener release, run in registration order at fencing; refuses after fencing. */
  releaseOnFence(release: () => void): void;
}

export interface ControlPlaneBootOptions {
  /** The private IPC channel to the spawning main. */
  readonly channel: PrivateIpcChannel;
  /** Directory holding the fixed private kernel-lease files. */
  readonly privateStateDirectory: string;
  /**
   * The runtime pin this child was launched as; defaults to the qualified
   * production pin (#209) — anything else fails closed at lease creation.
   */
  readonly qualifiedRuntime?: QualifiedRuntimePin;
  /**
   * Called exactly once, only after the registry-writer lease is held —
   * the only point where the composition may bind listeners or spawn
   * project-plane work. A throwing callback is a control-plane bug: the
   * child dies with an unhandled rejection and the lease releases with
   * the process — fail-closed by death, never a half-held authority.
   */
  readonly onAuthorityHeld?: (authority: RegistryAuthority) => void;
  /**
   * The exit transition; defaults to `process.exit`. Injected only by
   * in-process tests of the state machine — real children use the real
   * exit, which is the lease release.
   */
  readonly exitProcess?: (exitCode: number) => void;
}

class HeldRegistryAuthority implements RegistryAuthority {
  private currentState: RegistryAuthorityState = 'held';
  private readonly releases: Array<() => void> = [];
  private ranReleases = false;

  get state(): RegistryAuthorityState {
    return this.currentState;
  }

  isHeld(): boolean {
    return this.currentState === 'held';
  }

  assertHeld(): void {
    if (this.currentState !== 'held') throw new RegistryFencedError();
  }

  releaseOnFence(release: () => void): void {
    this.assertHeld();
    this.releases.push(release);
  }

  /** The disconnect transition: fence first, then run releases in order, exactly once. */
  fenceAndRelease(): void {
    this.currentState = 'fenced';
    if (this.ranReleases) return;
    this.ranReleases = true;
    for (const release of this.releases) {
      release();
    }
  }
}

/**
 * Boots this control-plane child: capability → kernel registry-writer
 * lease → authority. Resolves with the held authority (after
 * `onAuthorityHeld`); every failure path terminates the child through
 * `exitProcess` with the exit codes above and rejects the boot promise
 * with the underlying error.
 */
export function bootControlPlane(options: ControlPlaneBootOptions): Promise<RegistryAuthority> {
  // The exit is single-shot by contract: terminate() is the only caller and
  // guards itself — after the first exit this child is dead.
  const exitProcess = options.exitProcess ?? ((exitCode: number) => process.exit(exitCode));
  return new Promise<RegistryAuthority>((resolve, reject) => {
    let authority: HeldRegistryAuthority | null = null;
    let terminated = false;
    const terminate = (exitCode: number, error: unknown): void => {
      if (terminated) return;
      terminated = true;
      reject(error instanceof Error ? error : new Error(String(error)));
      exitProcess(exitCode);
    };
    const onDisconnect = (): void => {
      if (authority !== null) {
        authority.fenceAndRelease();
        terminate(EXIT_FENCED, new Error(FENCED_MESSAGE));
        return;
      }
      terminate(EXIT_BOOT_PROTOCOL, new BootCapabilityError(FENCED_MESSAGE));
    };
    options.channel.on('disconnect', onDisconnect);
    if (!options.channel.connected) {
      onDisconnect();
      return;
    }
    void (async () => {
      try {
        await receiveBootCapability(options.channel);
        if (terminated) return; // the channel died mid-handshake; the exit already fired
        const leases = createKernelLeaseModule({
          privateStateDirectory: options.privateStateDirectory,
          qualifiedRuntime: options.qualifiedRuntime,
        });
        leases.holdRegistryWriter();
      } catch (error) {
        terminate(exitCodeFor(error), error);
        return;
      }
      authority = new HeldRegistryAuthority();
      resolve(authority);
      options.onAuthorityHeld?.(authority);
    })();
  });
}

function exitCodeFor(error: unknown): number {
  if (error instanceof BootCapabilityError) return EXIT_BOOT_PROTOCOL;
  if (error instanceof KernelLeaseError) {
    return error.code === 'ASTROIX_KERNEL_LEASE_UNAVAILABLE'
      ? EXIT_LEASE_CONTENTION
      : EXIT_LEASE_FAILURE;
  }
  return EXIT_LEASE_FAILURE;
}
