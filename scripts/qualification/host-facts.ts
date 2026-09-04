import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The host-facts record of the qualification harness (#258, L1): the
 * environment every recorded verdict was produced in — the macOS
 * product version and build, the uname machine architecture, and the
 * harness's own Node version and ABI. Translated from the early
 * packaged smoke's host capture (`run-early-package-smoke.mjs`,
 * #248/H6): one bounded capture per fact, `'unknown'` on failure — a
 * fact that cannot be read is recorded as unread, never guessed.
 */

const execFileAsync = promisify(execFile);

/** The environment record every qualification run carries. */
export interface HostFacts {
  readonly platform: string;
  readonly arch: string;
  /** `sw_vers -productVersion` (e.g. `15.4`). */
  readonly swVersProduct: string;
  /** `sw_vers -buildVersion` (e.g. `24E248`). */
  readonly swVersBuild: string;
  /** `uname -m` (e.g. `arm64`). */
  readonly unameMachine: string;
  /** The harness process's own Node version (`process.version`). */
  readonly harnessNodeVersion: string;
  /** The harness process's own Node ABI (`process.versions.modules`). */
  readonly harnessNodeAbi: string;
}

/** Captures the host facts — each fact bounded, failures recorded as `unknown`. */
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
    harnessNodeAbi: process.versions.modules ?? 'unknown',
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
