import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The host disclosure of the restricted-candidate workflow (#259, L2):
 * the environment every verdict was produced in — the ACTUAL tested
 * macOS product version, build, and architecture (`sw_vers`,
 * `uname -m`), never a claimed one. `macOsClaim` is the ticket's
 * macOS-13.5 law as a pure function: the 13.5 minimum is verified as
 * PACKAGE METADATA unless the actual host IS an exact controlled 13.5
 * machine, and the disclosure always names the real tested facts.
 */

const execFileAsync = promisify(execFile);

export interface HostFacts {
  readonly platform: string;
  readonly arch: string;
  /** `sw_vers -productVersion` — e.g. `13.5`, `26.3.1`. */
  readonly swVersProduct: string;
  /** `sw_vers -buildVersion` — e.g. `22G74`. */
  readonly swVersBuild: string;
  /** `uname -m` — e.g. `arm64`. */
  readonly unameMachine: string;
  /** The harness process's own Node version. */
  readonly harnessNodeVersion: string;
}

export async function captureHostFacts(): Promise<HostFacts> {
  const [swVersProduct, swVersBuild, unameMachine] = await Promise.all([
    capture('sw_vers', ['-productVersion']),
    capture('sw_vers', ['-buildVersion']),
    capture('uname', ['-m']),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    swVersProduct,
    swVersBuild,
    unameMachine,
    harnessNodeVersion: process.version,
  };
}

async function capture(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

/** The macOS-13.5 verdict shape — the manifest's `minimumMacOS` section. */
export interface MacOsClaim {
  /** The artifact's own LSMinimumSystemVersion metadata (the charter's 13.5). */
  readonly metadata: string;
  /** `metadata-only` (the default) or `host` — 13.5 is only ever HOST-verified on an exact 13.5 machine. */
  readonly verifiedAs: 'metadata-only' | 'host';
  /** The actual environment the matrix ran in. */
  readonly testedOn: {
    readonly swVersProduct: string;
    readonly swVersBuild: string;
    readonly unameMachine: string;
  };
  /** True only when testedOn.swVersProduct is exactly the metadata minimum. */
  readonly controlledMinimumHost: boolean;
  /** The always-present disclosure sentence. */
  readonly disclosure: string;
}

/**
 * The pure macOS-13.5 law: metadata is verified as metadata; a host
 * claim exists ONLY when the actual tested product version equals the
 * metadata minimum. The disclosure always carries the real facts —
 * "Do not claim macOS 13.5 was tested from metadata or a newer hosted
 * runner" is the ticket's wording, and this function is its
 * enforcement point (validateManifest re-checks the claim's honesty
 * over the recorded facts).
 */
export function macOsClaim(host: HostFacts, metadataMinimum: string): MacOsClaim {
  const exactHost = host.swVersProduct === metadataMinimum && host.swVersProduct !== 'unknown';
  const disclosure = exactHost
    ? `the minimum macOS ${metadataMinimum} was verified on this host (sw_vers ${host.swVersProduct} build ${host.swVersBuild}, ${host.unameMachine}); the artifact's LSMinimumSystemVersion metadata is ${metadataMinimum}`
    : `the minimum macOS ${metadataMinimum} was verified as PACKAGE METADATA ONLY (the artifact's LSMinimumSystemVersion); the matrix actually ran on sw_vers ${host.swVersProduct} build ${host.swVersBuild}, ${host.unameMachine} — no claim is made about macOS ${metadataMinimum} itself`;
  return {
    metadata: metadataMinimum,
    verifiedAs: exactHost ? 'host' : 'metadata-only',
    testedOn: {
      swVersProduct: host.swVersProduct,
      swVersBuild: host.swVersBuild,
      unameMachine: host.unameMachine,
    },
    controlledMinimumHost: exactHost,
    disclosure,
  };
}
