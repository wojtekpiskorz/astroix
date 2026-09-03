import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  NODE_EXECUTABLE_RESOURCE_PATH,
  PACKAGED_ELECTRON_PIN,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { type AppVerification, strictVerifyApp } from './codesign.ts';
import { PRODUCT_ARCH, PRODUCT_BUNDLE_ID, PRODUCT_MINIMUM_MACOS } from './product.ts';
import {
  expectedReleaseFuseStates,
  type FuseReadRejection,
  type FuseViolationActual,
  fuseStateViolations,
  readFuseStates,
  type VerifiedFuseState,
} from './release-fuses.ts';

/**
 * The packaged-app verification pass (#245, H3; ADR-0008): everything a
 * packaged `.app` must prove — run BEFORE the ZIP (on the packaged app)
 * and AGAIN after extraction, through this one module so both passes
 * are the same law:
 *
 * 1. **strict code-signature verification** — `codesign --verify
 *    --strict` on every nested code target and the outer app, every
 *    signature displayed as `adhoc` (the sealed identity; Developer ID
 *    and notarization are explicit non-goals).
 * 2. **resource verification** — the SAME internal packaged-asset
 *    adapter the app boots with (pins, layout, containment, symlink
 *    policy, every SHA-256) over `Contents/Resources`.
 * 3. **fuse-state inspection** — the fuses READ off the real Electron
 *    Framework binary and compared against the release law.
 * 4. **identity facts** — `Info.plist` bundle id, minimum-OS metadata,
 *    and the embedded ASAR-integrity hash; single-arch `arm64`
 *    executables (no universal slices).
 *
 * Accepted residual (the #245 carry-note): this verification proves the
 * bytes at check time — the window between it and any later spawn is a
 * TOCTOU accepted under ADR-0008's threat model, revisited only by a
 * future signed-bundle lane.
 */

const execFileAsync = promisify(execFile);

/** The verdict of one verification facet. */
export interface FacetVerdict<Detail> {
  readonly ok: boolean;
  readonly detail: Detail;
}

/** The Info.plist facts the identity facet reads and rules on. */
export interface PlistFacts {
  readonly bundleId: string | null;
  readonly minimumSystemVersion: string | null;
  readonly executable: string | null;
  readonly asarIntegrityHash: string | null;
}

/** The whole-app verification report — `ok` is the conjunction of all facets. */
export interface PackageVerificationReport {
  readonly appPath: string;
  readonly ok: boolean;
  readonly codesign: AppVerification;
  readonly assets: FacetVerdict<unknown>;
  readonly fuses: FacetVerdict<{
    readonly states: Readonly<Record<string, VerifiedFuseState>> | null;
    readonly violations: ReadonlyArray<{
      fuse: string;
      actual: FuseViolationActual;
      expected: VerifiedFuseState;
    }>;
    readonly rejection: FuseReadRejection | null;
  }>;
  readonly plist: FacetVerdict<{ readonly facts: PlistFacts; readonly diffs: readonly string[] }>;
  readonly arch: FacetVerdict<{ readonly findings: readonly string[] }>;
}

/**
 * The non-signature facets — the facts pass the PRE-SIGN stage runs
 * (fuses and resources final before anything is signed) and the full
 * pass COMPOSES: one facet list, never two to keep in step.
 */
export async function verifyPackagedAppFacts(
  appPath: string,
): Promise<Pick<PackageVerificationReport, 'assets' | 'fuses' | 'plist' | 'arch'>> {
  const [assets, fuses, plist, arch] = await Promise.all([
    verifyAssets(appPath),
    verifyFuses(appPath),
    verifyIdentity(appPath),
    verifyArchitectures(appPath),
  ]);
  return { assets, fuses, plist, arch };
}

/**
 * Runs every facet against the packaged app at `appPath`, the facts
 * pass COMPOSED with the signature pass — "both passes are the same
 * law" is the call graph, not a comment. Facets are independent — one
 * failing does not mask another; the report carries all verdicts and
 * `ok` is false when any facet failed.
 */
export async function verifyPackagedApp(appPath: string): Promise<PackageVerificationReport> {
  const [codesign, facts] = await Promise.all([
    strictVerifyApp(appPath),
    verifyPackagedAppFacts(appPath),
  ]);
  return {
    appPath,
    ok: codesign.ok && facts.assets.ok && facts.fuses.ok && facts.plist.ok && facts.arch.ok,
    codesign,
    assets: facts.assets,
    fuses: facts.fuses,
    plist: facts.plist,
    arch: facts.arch,
  };
}

/** The report as the packaging lane prints it — one line per facet, failures expanded. */
export function describePackageVerification(report: PackageVerificationReport): string[] {
  const lines = [
    `package-verification: ${report.ok ? 'PASSED' : 'FAILED'} — ${report.appPath}`,
    `  codesign: ${report.codesign.ok ? 'strict verification + adhoc signature on all targets' : 'FAILED'}`,
  ];
  for (const target of report.codesign.targets.filter(
    (t) => !t.verified || (!t.adhocOptional && t.signature !== 'adhoc'),
  )) {
    lines.push(
      `    target ${target.target}: verified=${target.verified} signature=${String(target.signature)}`,
    );
  }
  lines.push(
    `  assets: ${report.assets.ok ? 'verified through the packaged-asset adapter' : `REJECTED ${JSON.stringify(report.assets.detail)}`}`,
  );
  lines.push(
    `  fuses: ${
      report.fuses.ok
        ? 'wire matches the release law'
        : `VIOLATIONS ${JSON.stringify(report.fuses.detail.violations)} rejection=${JSON.stringify(report.fuses.detail.rejection)}`
    }`,
  );
  lines.push(
    `  identity: ${report.plist.ok ? `bundle id + min-OS ${PRODUCT_MINIMUM_MACOS} + asar integrity hash` : `DIFFS ${JSON.stringify(report.plist.detail.diffs)}`}`,
  );
  lines.push(
    `  arch: ${report.arch.ok ? `single-arch ${PRODUCT_ARCH} executables` : `FINDINGS ${JSON.stringify(report.arch.detail.findings)}`}`,
  );
  return lines;
}

async function verifyAssets(appPath: string): Promise<FacetVerdict<unknown>> {
  const verified = await verifyPackagedAssets({
    resourcesRoot: join(appPath, 'Contents', 'Resources'),
    architecture: PRODUCT_ARCH,
    electronVersion: PACKAGED_ELECTRON_PIN,
  });
  return 'code' in verified ? { ok: false, detail: verified } : { ok: true, detail: null };
}

async function verifyFuses(appPath: string): Promise<PackageVerificationReport['fuses']> {
  const read = await readFuseStates(appPath);
  if ('code' in read) {
    // VerifiedFuseStates never carries a `code` key, so this branch is
    // the rejection arm — the index-signature type just cannot prove it.
    return {
      ok: false,
      detail: { states: null, violations: [], rejection: read as FuseReadRejection },
    };
  }
  const violations = fuseStateViolations(read, expectedReleaseFuseStates());
  return { ok: violations.length === 0, detail: { states: read, violations, rejection: null } };
}

async function verifyIdentity(
  appPath: string,
): Promise<FacetVerdict<{ facts: PlistFacts; diffs: readonly string[] }>> {
  const plist = await readInfoPlist(appPath);
  const integrity = plist.ElectronAsarIntegrity as Record<string, { hash?: string }> | undefined;
  // the packager records the asar hash under the platform-relative path
  // key (Electron 44's plist spells it "Resources/app.asar") — key the
  // check on the asar entry, not on one spelling of the path
  const asarEntry = Object.entries(integrity ?? {}).find(([key]) => key.endsWith('/app.asar'));
  const facts: PlistFacts = {
    bundleId: typeof plist.CFBundleIdentifier === 'string' ? plist.CFBundleIdentifier : null,
    minimumSystemVersion:
      typeof plist.LSMinimumSystemVersion === 'string' ? plist.LSMinimumSystemVersion : null,
    executable: typeof plist.CFBundleExecutable === 'string' ? plist.CFBundleExecutable : null,
    asarIntegrityHash: asarEntry?.[1]?.hash ?? null,
  };
  const diffs: string[] = [];
  if (facts.bundleId !== PRODUCT_BUNDLE_ID)
    diffs.push(`CFBundleIdentifier=${String(facts.bundleId)}`);
  if (facts.minimumSystemVersion !== PRODUCT_MINIMUM_MACOS) {
    diffs.push(`LSMinimumSystemVersion=${String(facts.minimumSystemVersion)}`);
  }
  if (facts.executable === null) diffs.push('CFBundleExecutable missing');
  if (facts.asarIntegrityHash === null)
    diffs.push('ElectronAsarIntegrity[resources/app.asar].hash missing');
  return { ok: diffs.length === 0, detail: { facts, diffs } };
}

async function verifyArchitectures(
  appPath: string,
): Promise<FacetVerdict<{ findings: readonly string[] }>> {
  const findings: string[] = [];
  const plist = await readInfoPlist(appPath);
  const executable = typeof plist.CFBundleExecutable === 'string' ? plist.CFBundleExecutable : null;
  if (executable === null) {
    return { ok: false, detail: { findings: ['CFBundleExecutable missing'] } };
  }
  const targets = [
    join('Contents', 'MacOS', executable),
    join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    join('Contents', 'Resources', ...NODE_EXECUTABLE_RESOURCE_PATH.split('/')),
  ];
  for (const target of targets) {
    const archs = (
      await execFileAsync('lipo', ['-archs', join(appPath, ...target.split('/'))], {
        timeout: 60_000,
      }).catch(() => null)
    )?.stdout.trim();
    if (archs !== PRODUCT_ARCH) {
      findings.push(`${target}: ${String(archs)}`);
    }
  }
  return { ok: findings.length === 0, detail: { findings } };
}

async function readInfoPlist(appPath: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    'plutil',
    ['-convert', 'json', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
    {
      timeout: 60_000,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}
