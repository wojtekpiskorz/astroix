import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  describePackageVerification,
  type PackageVerificationReport,
  verifyPackagedApp,
} from '../../apps/desktop/src/forge/package-verification.ts';
import { PACKAGED_NODE_PIN } from '../../packages/runtime/src/internal/packaged-assets.ts';

/**
 * The verification battery of the qualification harness (#258, L1):
 * the artifact's own proof, read black-box off the extracted bytes.
 *
 * Migration policy (#258): the reusable H6 verification commands are
 * TRANSLATED here as parameterized black-box checks without weakening
 * H6 — by REUSING the very law they run: `verifyPackagedApp` is the
 * one module H3/H6 run both before the ZIP and after extraction
 * (strict nested+outer ad-hoc codesign, the packaged-asset adapter
 * over `Contents/Resources` — every pin, layout fact, symlink policy,
 * and SHA-256 — the fuse states off the real Electron Framework
 * binary, the Info.plist identity facts, and single-arch executables),
 * imported here so the pipeline's pass and the qualification pass are
 * the same law and cannot drift.
 *
 * The battery adds the one check H6's battery proves through the boot
 * itself: the BUNDLED RUNTIME IDENTITY, observed by executing the
 * bundled Node binary — the declared build-manifest pin, the executed
 * `--version`, and the executed ABI must all agree with the pin table.
 * A self-consistently rebuilt manifest cannot fake this: the binary
 * speaks for itself, under a minimal non-inherited environment so no
 * ambient `NODE_OPTIONS` preload can speak for it.
 */

const execFileAsync = promisify(execFile);

/**
 * The ABI (`process.versions.modules`) the pinned bundled Node reports:
 * Node 24's modules ABI is 137, and the pin table's Node is
 * v24.20.0 (`PACKAGED_NODE_PIN`, ADR-0008) — the executed ABI is
 * COMPARED, not merely recorded, so ABI drift between two builds of
 * the same version string fails closed (review round 1 on #373). A
 * Node-pin change requalifies the artifact (ADR-0008) and moves this
 * constant in the same PR.
 */
export const EXPECTED_BUNDLED_NODE_ABI = '137';

/** The verdict of the bundled-Node identity facet. */
export interface NodeIdentityOutcome {
  readonly ok: boolean;
  /** The build manifest's declared Node pin (`manifest.node`). */
  readonly declaredPin: string | null;
  /** What the bundled binary itself printed for `process.version`. */
  readonly executedVersion: string | null;
  /** What the bundled binary itself printed for `process.versions.modules`. */
  readonly executedAbi: string | null;
  readonly failure:
    | null
    | 'manifest-missing'
    | 'manifest-unreadable'
    | 'node-execution-failed'
    | 'identity-mismatch';
}

/** The whole battery: H3's packaged-app verification plus the bundled-Node identity. */
export interface BatteryOutcome {
  readonly ok: boolean;
  readonly appPath: string;
  /** The exact pin the harness's own pin table carries (ADR-0008; one law with the adapter). */
  readonly expectedNodePin: string;
  readonly nodeIdentity: NodeIdentityOutcome;
  /** `describePackageVerification`'s report — one line per facet, failures expanded. */
  readonly lines: readonly string[];
  /** The full facet report (codesign/assets/fuses/plist/arch), JSON-serializable. */
  readonly verification: PackageVerificationReport;
}

/** Runs the verification battery over the extracted app. */
export async function runVerificationBattery(appPath: string): Promise<BatteryOutcome> {
  const [verification, nodeIdentity] = await Promise.all([
    verifyPackagedApp(appPath),
    verifyBundledNodeIdentity(appPath),
  ]);
  return {
    ok: verification.ok && nodeIdentity.ok,
    appPath,
    expectedNodePin: PACKAGED_NODE_PIN,
    nodeIdentity,
    lines: describePackageVerification(verification),
    verification,
  };
}

/** The bundled runtime's resource paths inside the extracted app (ADR-0008 layout). */
const BUILD_MANIFEST_RELATIVE = join(
  'Contents',
  'Resources',
  'astroix-runtime',
  'build-manifest.json',
);
const BUNDLED_NODE_RELATIVE = join('Contents', 'Resources', 'node', 'bin', 'node');

/**
 * The bundled-Node identity law: the manifest's declared pin, the
 * executed binary's own version report, and the pin table must all
 * agree. Executing the supplied binary is read-only observation of the
 * artifact's own bytes — the harness never rewrites it.
 */
export async function verifyBundledNodeIdentity(appPath: string): Promise<NodeIdentityOutcome> {
  let declaredPin: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(join(appPath, BUILD_MANIFEST_RELATIVE), 'utf8')) as {
      node?: unknown;
    };
    declaredPin = typeof manifest.node === 'string' ? manifest.node : null;
  } catch {
    return {
      ok: false,
      declaredPin: null,
      executedVersion: null,
      executedAbi: null,
      failure: 'manifest-missing',
    };
  }
  if (declaredPin === null) {
    return {
      ok: false,
      declaredPin: null,
      executedVersion: null,
      executedAbi: null,
      failure: 'manifest-unreadable',
    };
  }
  let executedVersion: string | null = null;
  let executedAbi: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      join(appPath, BUNDLED_NODE_RELATIVE),
      ['-p', 'JSON.stringify({ version: process.version, abi: process.versions.modules })'],
      { timeout: 60_000, env: identityExecEnv() },
    );
    const reported = JSON.parse(stdout.trim()) as { version?: unknown; abi?: unknown };
    executedVersion = typeof reported.version === 'string' ? reported.version : null;
    executedAbi =
      typeof reported.abi === 'string' || typeof reported.abi === 'number'
        ? String(reported.abi)
        : null;
  } catch {
    return {
      ok: false,
      declaredPin,
      executedVersion: null,
      executedAbi: null,
      failure: 'node-execution-failed',
    };
  }
  const ok =
    executedVersion === declaredPin &&
    declaredPin === PACKAGED_NODE_PIN &&
    executedAbi === EXPECTED_BUNDLED_NODE_ABI;
  return {
    ok,
    declaredPin,
    executedVersion,
    executedAbi,
    failure: ok ? null : 'identity-mismatch',
  };
}

/**
 * Keys the bundled-Node identity exec may carry from the harness host —
 * everything else is dropped, never inherited (the #231
 * `minimalChildEnv` species): an ambient `NODE_OPTIONS=--require=…`
 * preload must never coach the executed-binary proof — this facet's
 * whole point is defeating self-consistent forgeries, so the binary
 * speaks for itself or the identity fails (review round 1 on #373).
 */
const IDENTITY_EXEC_KEYS = ['PATH', 'TMPDIR'] as const;

function identityExecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of IDENTITY_EXEC_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}
