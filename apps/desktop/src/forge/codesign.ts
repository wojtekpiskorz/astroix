import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The packaged-artifact code-signing seam (#245, H3; ADR-0008 release
 * hardening): the explicit ad-hoc signing and strict verification the
 * pipeline applies to the packaged `.app` — `codesign` with identity `-`
 * (ad-hoc), NESTED executable code first, the outer app LAST, so the
 * outer bundle's resource seal (`_CodeSignature/CodeResources`) is
 * written only after every nested code object it covers is final.
 *
 * Why this is a scripted stage and not a packager option: the signing
 * must happen after ALL resources (asar, the bundled Node, the runtime
 * tree) and ALL fuses are final, with an ordering the pipeline can state
 * and the tests can inspect — Forge's FusesPlugin-internal `--deep`
 * re-sign would run mid-package with a stale seal, and the packager's
 * `osxSign` stays deliberately unset (see `forge.config.ts`). ADR-0008
 * names the artifact "ad-hoc sealed" — not Developer ID, not notarized;
 * Gatekeeper rejection is expected and `spctl` acceptance is NOT a gate.
 *
 * Accepted residual, recorded per the #245 readiness carry-note: the
 * verify-then-spawn window is a TOCTOU no local signature check closes —
 * strict verification proves the bytes at check time, and between that
 * check and the child spawn the filesystem could in principle change.
 * ADR-0008's threat model accepts this today; a future signed bundle
 * (Developer ID + notarization) is the lane that revisits it.
 */

/** The ad-hoc codesigning identity — literally `-`. */
export const AD_HOC_IDENTITY = '-';

/** One nested code object the verifier rules on — the signer seals every non-pinned one before the outer app. */
export interface NestedCodeTarget {
  /** The path relative to the `.app` bundle root, posix-separated. */
  readonly relPath: string;
  readonly kind: 'framework' | 'helper-app' | 'xpc' | 'mach-o';
  /**
   * True for executables under `Contents/Resources/` — the immutable
   * resources H2's build manifest pins by SHA-256 (`node/bin/node`).
   * Their bytes are manifest law: re-signing them would be
   * self-inflicted tampering (the packaged-asset adapter rejects the
   * changed hash), so the signer leaves them exactly as assembled —
   * they carry their upstream-valid signatures, and the outer app's
   * seal covers them like every other resource.
   */
  readonly manifestPinned: boolean;
}

/** One walked file-system fact the ordering plan is built from. */
export interface BundleListingEntry {
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly isBundleDir: boolean;
  readonly isMachO: boolean;
}

/** The codesign argument list each target is signed with (identity `-`). */
export const AD_HOC_SIGN_ARGS: readonly string[] = Object.freeze([
  '--force',
  '--sign',
  AD_HOC_IDENTITY,
  '--timestamp=none',
  // Keep the Electron distribution's own ad-hoc metadata where a
  // signature already exists (the framework's JIT entitlements and
  // flags) — the same preserve set @electron/fuses' reset uses.
  '--preserve-metadata=entitlements,requirements,flags,runtime',
]);

const BUNDLE_EXTENSIONS: ReadonlySet<string> = new Set(['.app', '.framework', '.xpc']);

const MACHO_MAGICS: ReadonlySet<string> = new Set([
  'cffaedfe', // MH_MAGIC_64 (little-endian)
  'feedfacf', // MH_MAGIC_64 (big-endian)
  'cafebabe', // FAT magic (big-endian)
  'bebafeca', // FAT magic (little-endian)
  'cefaedfe', // MH_MAGIC (little-endian)
  'feedface', // MH_MAGIC (big-endian)
]);

/** Whether a directory name is a code bundle the signer treats as one target. */
export function isBundleDirName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && BUNDLE_EXTENSIONS.has(name.slice(dot));
}

/** Whether a file's first four bytes are a Mach-O magic — the loose-executable detector. */
export async function isMachOFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null);
  if (handle === null) return false;
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGICS.has(buffer.toString('hex'));
  } finally {
    await handle.close();
  }
}

/**
 * Walks the packaged `.app` and lists every candidate the signer rules
 * on: bundle directories and loose Mach-O files. Inside a bundle
 * directory only deeper bundles are listed — a bundle's own files are
 * sealed by signing the bundle, never as separate targets.
 */
export async function listBundleCode(appPath: string): Promise<BundleListingEntry[]> {
  const entries: BundleListingEntry[] = [];
  await walk(appPath, '', false, entries);
  return entries;
}

/**
 * The signing order over a listing — the AC's law as a pure function:
 * deepest targets first (a nested bundle is sealed before any bundle
 * that contains it; the bundled Node executable under `Resources` is
 * sealed like every other loose executable), ties in lexicographic
 * order, and the outer app is signed by the caller AFTER this list is
 * exhausted.
 */
export function planNestedCodeOrdering(entries: readonly BundleListingEntry[]): NestedCodeTarget[] {
  const targets = entries
    .filter((entry) => (entry.isDirectory ? entry.isBundleDir : entry.isMachO))
    .filter((entry) => entry.relPath.length > 0);
  return targets
    .map((entry) => ({
      relPath: entry.relPath,
      kind: kindOf(entry),
      manifestPinned: isManifestPinnedRelPath(entry.relPath),
      depth: entry.relPath.split('/').length,
    }))
    .sort((a, b) => b.depth - a.depth || (a.relPath < b.relPath ? -1 : 1))
    .map(({ relPath, kind, manifestPinned }) => ({ relPath, kind, manifestPinned }));
}

/** The manifest-pinned subtree: every executable under Contents/Resources is H2's immutable-data law, not host code to re-sign. */
export function isManifestPinnedRelPath(relPath: string): boolean {
  return relPath === 'Contents/Resources' || relPath.startsWith('Contents/Resources/');
}

/**
 * Signs every nested HOST target (deepest first: frameworks, helpers,
 * loose dylibs, the main executable) and then the outer app, all with
 * identity `-`. Manifest-pinned executables (`Contents/Resources/`) are
 * skipped BY LAW — their bytes are pinned by H2's build manifest, and
 * re-signing them is self-inflicted tampering the packaged-asset
 * adapter rejects. The full plan (pinned included) is returned; the
 * caller verifies the pinned ones instead of signing them.
 */
export async function adHocSignApp(appPath: string): Promise<readonly NestedCodeTarget[]> {
  const listing = await listBundleCode(appPath);
  const plan = planNestedCodeOrdering(listing);
  for (const target of plan) {
    if (!target.manifestPinned) {
      await runCodesign(join(appPath, ...target.relPath.split('/')));
    }
  }
  await runCodesign(appPath);
  return plan;
}

/** One strict-verification verdict for one target. */
export interface TargetVerification {
  readonly target: string;
  readonly verified: boolean;
  readonly signature: string | null;
  /** True for manifest-pinned executables: any valid embedded signature passes (the adapter pins the bytes). */
  readonly adhocOptional: boolean;
  readonly output: string;
}

/** The whole-app strict-verification report: every nested target plus the outer app. */
export interface AppVerification {
  readonly appPath: string;
  readonly ok: boolean;
  readonly targets: readonly TargetVerification[];
}

/**
 * Strict verification of the packaged app: `codesign --verify --strict`
 * on EVERY nested code target and the outer app. Every HOST target
 * (frameworks, helpers, dylibs, the main executable, the outer app)
 * must additionally display `Signature=adhoc` — the artifact's sealed
 * identity (ADR-0008); manifest-pinned executables under
 * `Contents/Resources/` must verify against THEIR OWN embedded
 * signature (the upstream Node.js signature), because their bytes are
 * pinned by H2's build manifest — the packaged-asset adapter's SHA-256
 * check owns their content law.
 */
export async function strictVerifyApp(appPath: string): Promise<AppVerification> {
  const listing = await listBundleCode(appPath);
  const plan = planNestedCodeOrdering(listing);
  const targets: TargetVerification[] = [];
  for (const target of plan) {
    targets.push(
      await verifyTarget(
        join(appPath, ...target.relPath.split('/')),
        target.relPath,
        target.manifestPinned,
      ),
    );
  }
  targets.push(await verifyTarget(appPath, '<app>', false));
  return {
    appPath,
    ok: targets.every((t) => t.verified && (t.adhocOptional || t.signature === 'adhoc')),
    targets,
  };
}

const execFileAsync = promisify(execFile);

async function runCodesign(target: string): Promise<void> {
  await execFileAsync('codesign', [...AD_HOC_SIGN_ARGS, target], { timeout: 120_000 });
}

async function verifyTarget(
  absolute: string,
  label: string,
  adhocOptional: boolean,
): Promise<TargetVerification> {
  try {
    await execFileAsync('codesign', ['--verify', '--strict', '--verbose=2', absolute], {
      timeout: 120_000,
    });
  } catch (error) {
    return {
      target: label,
      verified: false,
      signature: null,
      adhocOptional,
      output: String(error),
    };
  }
  // codesign --display writes its report to stderr, not stdout
  const display = await execFileAsync('codesign', ['--display', '--verbose=2', absolute], {
    timeout: 120_000,
  });
  const match = /Signature=(?:"([^"]+)"|(\S+))/.exec(`${display.stdout}\n${display.stderr}`);
  const signature = match === null ? null : (match[1] ?? match[2] ?? null);
  return {
    target: label,
    verified: true,
    signature,
    adhocOptional,
    output: display.stderr.trim(),
  };
}

function kindOf(entry: BundleListingEntry): NestedCodeTarget['kind'] {
  if (!entry.isDirectory) return 'mach-o';
  if (entry.relPath.endsWith('.framework')) return 'framework';
  if (entry.relPath.endsWith('.xpc')) return 'xpc';
  return 'helper-app';
}

async function walk(
  root: string,
  relPath: string,
  insideBundle: boolean,
  entries: BundleListingEntry[],
): Promise<void> {
  const children = await readdir(join(root, ...relPath.split('/').filter(Boolean)), {
    withFileTypes: true,
  });
  for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childRel = relPath === '' ? child.name : `${relPath}/${child.name}`;
    const childIsBundle = child.isDirectory() && isBundleDirName(child.name);
    if (child.isDirectory()) {
      entries.push({
        relPath: childRel,
        isDirectory: true,
        isBundleDir: childIsBundle,
        isMachO: false,
      });
      if (childIsBundle || !insideBundle) {
        await walk(root, childRel, insideBundle || childIsBundle, entries);
      }
    } else if (!insideBundle) {
      entries.push({
        relPath: childRel,
        isDirectory: false,
        isBundleDir: false,
        isMachO: await isMachOFile(join(root, ...childRel.split('/'))),
      });
    }
  }
}
