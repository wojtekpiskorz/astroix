import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createKernelLeaseModule } from './kernel-lease.mjs';

const config = JSON.parse(process.argv[2] ?? '{}');
process.umask(0o077);

let qualification;
let sqliteError;
const leases = createKernelLeaseModule({
  privateStateDirectory: config.privateStateDirectory,
  onContention(snapshot) {
    sqliteError = snapshot;
    if (config.throwOnContention) throw new Error('proof contention observer failed');
    if (config.rejectOnContention) {
      return Promise.reject(new Error('proof contention observer rejected'));
    }
  },
  onQualified(snapshot) {
    qualification = snapshot;
    if (config.throwOnQualified) throw new Error('proof qualification observer failed');
    if (config.rejectOnQualified) {
      return Promise.reject(new Error('proof qualification observer rejected'));
    }
  },
});

function send(message) {
  if (process.connected) process.send(message);
}

send({
  type: 'ready',
  role: config.role,
  runtimeVersion: process.version,
  executablePath: process.execPath,
});

process.on('message', (message) => {
  if (message?.type === 'start') {
    const acquisitionStartedAt = performance.now();
    try {
      if (config.role === 'registry-writer') leases.holdRegistryWriter();
      else if (config.role === 'edit-writer') leases.holdEditWriter();
      else throw new TypeError('role must be registry-writer or edit-writer');
      if (typeof config.exitMarkerPath === 'string') {
        process.once('exit', () =>
          writeFileSync(config.exitMarkerPath, 'exited\n', { mode: 0o600 }),
        );
      }
      if (Number.isInteger(config.exitBlockMs) && config.exitBlockMs > 0) {
        process.once('exit', () => {
          writeFileSync(config.exitBlockMarkerPath, 'blocking\n', { mode: 0o600 });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.exitBlockMs);
        });
      }
      send({
        type: 'acquired',
        role: config.role,
        elapsedMs: performance.now() - acquisitionStartedAt,
        ...qualification,
      });
      if (Number.isInteger(config.orphanHoldMs) && config.orphanHoldMs > 0) {
        setTimeout(() => process.exit(0), config.orphanHoldMs);
      }
    } catch (error) {
      send({
        type: 'denied',
        role: config.role,
        elapsedMs: performance.now() - acquisitionStartedAt,
        sqliteError,
        error: {
          code: error?.code ?? 'ASTROIX_KERNEL_LEASE_FAILED',
          message: error?.message ?? 'Kernel lease acquisition failed.',
          retryable: error?.retryable ?? false,
        },
      });
      process.exitCode = error?.code === 'ASTROIX_KERNEL_LEASE_UNAVAILABLE' ? 73 : 74;
      process.disconnect();
    }
  }

  if (message?.type === 'shutdown') {
    process.exit(0);
  }
});
