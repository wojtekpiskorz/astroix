import { type Serializable, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The middle parent for the live-orphan test (#222 focused tests): forks
 * the real lease holder and relays its messages upward, then parks — its
 * IPC reference keeps it alive until the test SIGKILLs it while the
 * holder (its orphaned child) still holds the lease.
 */

const config = JSON.parse(process.argv[2] ?? '{}') as { holderArgs: string[] };

const holder = fork(fileURLToPath(new URL('./lease-holder-runner.ts', import.meta.url)), [
  ...config.holderArgs,
]);

holder.on('message', (message) => {
  process.send?.(message);
});
holder.on('exit', (code, signal) => {
  process.send?.({ type: 'holder-exit', code, signal });
});
process.on('message', (message) => {
  holder.send(message as Serializable);
});
