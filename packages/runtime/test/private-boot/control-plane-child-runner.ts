import { writeFileSync } from 'node:fs';
import { currentRuntimePin, type QualifiedRuntimePin } from '../../kernel-lease/kernel-lease.ts';
import {
  bootControlPlane,
  type ControlPlaneBootOptions,
} from '../../private-boot/control-plane-boot.ts';
import { processChannel } from '../../private-boot/private-ipc.ts';

/**
 * The control-plane child fixture for the private-boot process-lane tests
 * (#222 focused tests): a real forked child running the real boot over
 * its real private IPC channel, using the real `process.exit`. The
 * listener-bind marker proves the AC ordering — it appears only after the
 * registry-writer lease is held — and the release marker records whether
 * the fence preceded the listener release.
 */

interface ChildConfig {
  privateStateDirectory: string;
  qualifiedRuntime?: 'current' | 'wrong-node' | 'wrong-sqlite';
  heldMarkerPath?: string;
  releaseMarkerPath?: string;
}

function pinFor(kind: ChildConfig['qualifiedRuntime']): QualifiedRuntimePin {
  const current = currentRuntimePin();
  if (kind === 'wrong-node') return { ...current, nodeVersion: 'v0.0.0-astroix-wrong' };
  if (kind === 'wrong-sqlite') return { ...current, sqliteSourceId: 'drifted-source-id' };
  return current;
}

function writeMarker(path: string | undefined, contents: string): void {
  if (path === undefined) return;
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
}

const config: ChildConfig = JSON.parse(process.argv[2] ?? '{}');

const options: ControlPlaneBootOptions = {
  channel: processChannel(process),
  privateStateDirectory: config.privateStateDirectory,
  qualifiedRuntime: pinFor(config.qualifiedRuntime),
  onAuthorityHeld: (authority) => {
    writeMarker(config.heldMarkerPath, 'listeners-bound');
    authority.releaseOnFence(() => {
      writeMarker(
        config.releaseMarkerPath,
        authority.isHeld() ? 'released-while-held' : 'released-after-fence',
      );
    });
    process.send?.({ type: 'held' });
  },
};

bootControlPlane(options).catch(() => {
  // The boot already terminated this child through its exit codes; a
  // rejected promise here carries no additional authority decision.
});
