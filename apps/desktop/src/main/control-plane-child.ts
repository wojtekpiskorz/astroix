import {
  currentRuntimePin,
  type QualifiedRuntimePin,
} from '@wojciechpiskorz/astroix-runtime/kernel-lease';
import {
  bootControlPlane,
  type PrivateIpcChannel,
  processChannel,
} from '@wojciechpiskorz/astroix-runtime/private-boot';
import { bootDesktopComposition, type DesktopComposition } from './desktop-composition.ts';

/**
 * The control-plane child entry (#243, H1; #362, H7): boots through the
 * REAL private boot contract — the one-use capability as this process's
 * first IPC message, then the kernel `registry-writer` lease over the
 * private state directory, and only then (D3's `onAuthorityHeld` — the
 * only point where listeners may bind) the shared control-plane
 * composition (`apps/web/src/control-plane.ts`, the ONE seam both hosts
 * consume) over the production registry under the user-data registry
 * directory, and the private channel's service loop.
 *
 * Main never hosts this: the child is spawned by Electron main's dev
 * runtime adapter (an EXPLICIT node executable — no PATH discovery, no
 * shell, no system Node, no Electron-as-Node; the no-fallback law) with
 * its configuration as one JSON argv argument. The capability never
 * rides the environment or argv — only the channel (ADR-0007).
 *
 * The composed surface since H7 (#362): the registry that validates a
 * native directory grant (`register-root`, answered with the sanitized
 * wire summary — key, display name, availability — never a root), the
 * REAL origin listener with its launcher/project virtual hosts, the
 * reserved HTTP API and SSE surfaces, the staged-activation supervisor
 * over the project runtime, the switch coordinator, and the session
 * completion whose activation observation is the Electron host's own
 * window handshake (the `unavailable-composition` refusal is retired).
 *
 * Boot shape (the #230/#240 dev-checkout idiom): raw `node
 * --experimental-transform-types --import <register> <this file>
 * <config>` — the register supplies bundler-resolution semantics for the
 * repo's extensionless TypeScript; the packaged runtime's rebased entry
 * (H2) needs neither.
 */

interface ChildConfig {
  readonly privateStateDirectory: string;
  readonly registryDirectory: string;
  /**
   * The built client documents the composition's origin listener serves
   * (the packaged resources' client subtree, or the dev checkout's web
   * build output) — main names it; the child never searches.
   */
  readonly clientDist: string;
  /**
   * Dev-checkout lease pin declaration (the D3 law: dev/test compositions
   * DECLARE `currentRuntimePin()` — an explicit statement, never a
   * fallback): when true the child qualifies the lease against the
   * actually-running runtime; the product default stays the exact
   * production pin, which fails closed anywhere else.
   */
  readonly declareCurrentRuntimePin?: boolean;
}

function readConfig(argv: readonly string[]): ChildConfig {
  const parsed: unknown = JSON.parse(argv[2] ?? '{}');
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('astroix-desktop-child: the config argument is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const privateStateDirectory = record.privateStateDirectory;
  const registryDirectory = record.registryDirectory;
  const clientDist = record.clientDist;
  if (
    typeof privateStateDirectory !== 'string' ||
    typeof registryDirectory !== 'string' ||
    typeof clientDist !== 'string'
  ) {
    throw new Error('astroix-desktop-child: the config argument misses its directories');
  }
  return {
    privateStateDirectory,
    registryDirectory,
    clientDist,
    declareCurrentRuntimePin: record.declareCurrentRuntimePin === true,
  };
}

/** The dev-checkout pin declaration — explicit, never a fallback (the D3 law). */
function pinFor(config: ChildConfig): QualifiedRuntimePin | undefined {
  return config.declareCurrentRuntimePin === true ? currentRuntimePin() : undefined;
}

/** The booted composition — assigned inside `onAuthorityHeld`, read by the exit path. */
let composition: DesktopComposition | undefined;

function main(): void {
  const config = readConfig(process.argv);
  const channel = processChannel(process);
  bootControlPlane({
    channel,
    privateStateDirectory: config.privateStateDirectory,
    qualifiedRuntime: pinFor(config),
    // The ordered exit: D3's terminate runs the fence releases and then
    // exits — an async composition teardown started in a release would
    // die half-run. The injected exit awaits the composition's ordered
    // close (stop the active run inside main's 5 s graceful bound, close
    // the listener, fence the registry) and exits with the ORIGINAL
    // code: the exit code is D3's decision, the teardown is ours.
    exitProcess: (exitCode) => {
      const closing = composition?.close() ?? Promise.resolve();
      void closing.catch(() => {}).finally(() => process.exit(exitCode));
    },
    onAuthorityHeld: () => {
      void serve(channel, config);
    },
  }).catch(() => {
    // The boot already terminated this child through its exit codes; a
    // rejected promise here carries no additional authority decision
    // (the D3 child-runner idiom).
  });
  // The escalation path (main's SIGTERM after the graceful bound): a
  // default-kill would orphan the managed plane's children — run the
  // same ordered teardown, then let the exit stand.
  process.once('SIGTERM', () => {
    const closing = composition?.close() ?? Promise.resolve();
    void closing.catch(() => {}).finally(() => process.exit(0));
  });
}

/** The private channel's service loop — bound only while the boot authority is held. */
async function serve(channel: PrivateIpcChannel, config: ChildConfig): Promise<void> {
  composition = await bootDesktopComposition({
    channel,
    registryDirectory: config.registryDirectory,
    clientDist: config.clientDist,
  });
}

main();
