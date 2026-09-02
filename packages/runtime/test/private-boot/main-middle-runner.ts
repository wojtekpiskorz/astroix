import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BootCapability } from '../../private-boot/control-plane-boot.ts';

/**
 * The abrupt-main-death middle (#222 focused tests): stands in for
 * Electron main — spawns the exact control-plane child, mints and
 * confers the one-use capability over its private channel, relays the
 * held report upward, then parks. Its SIGKILL is the abrupt main death;
 * the child must observe the channel close and terminate itself.
 */

const CHILD = fileURLToPath(new URL('./control-plane-child-runner.ts', import.meta.url));

const config = JSON.parse(process.argv[2] ?? '{}') as { privateStateDirectory: string };

const child = fork(CHILD, [
  JSON.stringify({
    privateStateDirectory: config.privateStateDirectory,
    heldMarkerPath: `${config.privateStateDirectory}/middle-held.marker`,
    releaseMarkerPath: `${config.privateStateDirectory}/middle-release.marker`,
  }),
]);

child.on('message', (message) => {
  process.send?.(message);
});
child.on('exit', () => {
  process.send?.({ type: 'child-exit' });
});

process.send?.({ type: 'pid', pid: child.pid });
child.send(BootCapability.mint().toWireMessage());
