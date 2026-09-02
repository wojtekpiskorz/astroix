import { existsSync, writeFileSync } from 'node:fs';
import {
  createKernelLeaseModule,
  currentRuntimePin,
  type QualifiedRuntimePin,
} from '../../kernel-lease/kernel-lease.ts';

/**
 * The lease-holder fixture for the kernel-lease process-lane tests
 * (#222 focused tests): a real child process holding a real kernel lease,
 * driven entirely by IPC messages — 'start' acquires, 'shutdown' exits —
 * so every assertion lands on exit events, never timing. Runs under
 * plain Node (type stripping); the module path is passed by the test.
 */

interface HolderConfig {
  role: 'registry-writer' | 'edit-writer';
  privateStateDirectory: string;
  qualifiedRuntime?: 'current' | 'wrong-node' | 'wrong-sqlite';
  /** A file whose appearance tells an orphaned holder to exit — parent-driven, no timers. */
  orphanGoFile?: string;
  /** Written at process exit with the exit code (clean-release evidence). */
  exitMarkerPath?: string;
}

/** Pin selectors: 'current' matches this host (the happy paths); the wrong ones must fail closed on any host. */
function pinFor(kind: HolderConfig['qualifiedRuntime']): QualifiedRuntimePin {
  const current = currentRuntimePin();
  if (kind === 'wrong-node') return { ...current, nodeVersion: 'v0.0.0-astroix-wrong' };
  if (kind === 'wrong-sqlite') return { ...current, sqliteSourceId: 'drifted-source-id' };
  return current;
}

/** Timed wait on the main thread without timers — deterministic, interruptible only by the deadline. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const config: HolderConfig = JSON.parse(process.argv[2] ?? '{}');

process.on('message', (message: unknown) => {
  const command = (message as { type?: string } | null)?.type;
  if (command === 'shutdown') {
    process.exit(0);
  }
  if (command !== 'start') return;
  try {
    const leases = createKernelLeaseModule({
      privateStateDirectory: config.privateStateDirectory,
      qualifiedRuntime: pinFor(config.qualifiedRuntime),
    });
    if (config.role === 'registry-writer') {
      leases.holdRegistryWriter();
    } else {
      leases.holdEditWriter();
    }
  } catch (error) {
    process.send?.({
      type: 'denied',
      code: (error as { code?: string } | null)?.code ?? 'unknown',
    });
    // The #209 proof's exit discipline: exitCode + disconnect lets the
    // denial message flush before the exit — never process.exit after send.
    process.exitCode =
      (error as { code?: string } | null)?.code === 'ASTROIX_KERNEL_LEASE_UNAVAILABLE' ? 73 : 74;
    process.disconnect?.();
    return;
  }
  process.send?.({ type: 'acquired', role: config.role });
  if (config.exitMarkerPath) {
    process.on('exit', (code) => {
      writeFileSync(config.exitMarkerPath as string, `exit:${code}\n`, { mode: 0o600 });
    });
  }
  if (config.orphanGoFile) {
    while (!existsSync(config.orphanGoFile)) {
      sleepSync(20);
    }
    process.exit(0);
  }
});

process.send?.({ type: 'ready', pid: process.pid });
