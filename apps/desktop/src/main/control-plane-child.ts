import {
  currentRuntimePin,
  type QualifiedRuntimePin,
} from '@wojciechpiskorz/astroix-runtime/kernel-lease';
import {
  bootControlPlane,
  type PrivateIpcChannel,
  processChannel,
  type RegistryAuthority,
} from '@wojciechpiskorz/astroix-runtime/private-boot';
import {
  createProjectRegistry,
  type ProjectRegistry,
} from '@wojciechpiskorz/astroix-runtime/registry';
import {
  bootedReport,
  type DesktopChildRequest,
  parseDesktopChildRequest,
  type RegisterResult,
  registerResultReport,
  type TransitionOutcome,
  transitionResultReport,
} from './child-protocol.ts';

/**
 * The control-plane child entry (#243, H1): boots through the REAL
 * private boot contract — the one-use capability as this process's first
 * IPC message, then the kernel `registry-writer` lease over the private
 * state directory, and only then (D3's `onAuthorityHeld` — the only
 * point where listeners may bind) the production registry under the
 * user-data registry directory and the private channel's service loop.
 *
 * Main never hosts this: the child is spawned by Electron main's dev
 * runtime adapter (an EXPLICIT node executable — no PATH discovery, no
 * shell, no system Node, no Electron-as-Node; the no-fallback law) with
 * its configuration as one JSON argv argument. The capability never
 * rides the environment or argv — only the channel (ADR-0007).
 *
 * The composed surface for H1 is the native-selection half of the
 * contract: the registry that validates a native directory grant
 * (`register-root`), answered with the sanitized wire summary — key,
 * display name, availability — never a root. The activate/deactivate
 * delegation answers the honest typed refusal until the desktop
 * composition lane lands (the web host #240 is the behavioral host
 * meanwhile); the refusal vocabulary is the settled one, so the seam
 * does not drift when the composition arrives.
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
  if (typeof privateStateDirectory !== 'string' || typeof registryDirectory !== 'string') {
    throw new Error('astroix-desktop-child: the config argument misses its directories');
  }
  return {
    privateStateDirectory,
    registryDirectory,
    declareCurrentRuntimePin: record.declareCurrentRuntimePin === true,
  };
}

/** The dev-checkout pin declaration — explicit, never a fallback (the D3 law). */
function pinFor(config: ChildConfig): QualifiedRuntimePin | undefined {
  return config.declareCurrentRuntimePin === true ? currentRuntimePin() : undefined;
}

function main(): void {
  const config = readConfig(process.argv);
  bootControlPlane({
    channel: processChannel(process),
    privateStateDirectory: config.privateStateDirectory,
    qualifiedRuntime: pinFor(config),
    onAuthorityHeld: (authority) => {
      void serve(processChannel(process), authority, config);
    },
  }).catch(() => {
    // The boot already terminated this child through its exit codes; a
    // rejected promise here carries no additional authority decision
    // (the D3 child-runner idiom).
  });
}

/** The private channel's service loop — bound only while the boot authority is held. */
async function serve(
  channel: PrivateIpcChannel,
  authority: RegistryAuthority,
  config: ChildConfig,
): Promise<void> {
  const registry = await createProjectRegistry(config.registryDirectory);
  // The channel's close is terminal for registry authority (D3): fence,
  // then close the store on every fence path — process exit releases the
  // lease itself.
  authority.releaseOnFence(() => {
    void registry.close();
  });
  channel.send(bootedReport());
  channel.on('message', (message) => {
    const request = parseDesktopChildRequest(message);
    if (request === null) return; // a drifted or hostile message is dropped, never parsed
    void dispatch(channel, registry, request);
  });
}

async function dispatch(
  channel: PrivateIpcChannel,
  registry: ProjectRegistry,
  request: DesktopChildRequest,
): Promise<void> {
  if (request.kind === 'register-root') {
    channel.send(
      registerResultReport(request.requestId, await registerRoot(registry, request.root)),
    );
    return;
  }
  // activate/deactivate: the settled refusal until the desktop
  // composition lane lands — the vocabulary is the protocol's, so the
  // seam holds while the composition arrives.
  const outcome: TransitionOutcome = { kind: 'refused', reason: 'unavailable-composition' };
  channel.send(transitionResultReport(request.requestId, outcome));
}

/** One native directory grant → registry validation → the sanitized wire summary (never a root). */
async function registerRoot(registry: ProjectRegistry, root: string): Promise<RegisterResult> {
  const result = await registry.execute({ kind: 'register', root });
  // The register command's own success shape carries the record; any other
  // ok-shape would be a registry divergence — fail closed, never guess.
  if (!result.ok || result.kind !== 'registered') {
    const code = result.ok ? 'root-unavailable' : result.code;
    return { ok: false, code: code === 'quarantined' ? 'quarantined' : 'root-unavailable' };
  }
  // A freshly registered root was just realpath'd by the registry itself — it is available.
  return {
    ok: true,
    summary: {
      projectKey: result.record.projectKey,
      displayName: result.record.displayName,
      availability: 'available',
    },
  };
}

main();
