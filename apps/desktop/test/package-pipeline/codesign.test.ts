import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AD_HOC_IDENTITY,
  AD_HOC_SIGN_ARGS,
  isBundleDirName,
  isMachOFile,
  listBundleCode,
  planNestedCodeOrdering,
} from '../../src/forge/codesign.ts';

/**
 * The ad-hoc signing plan (#245, H3; ADR-0008): nested executable code
 * signed BEFORE the outer app, deepest targets first. These units pin
 * the detection and ordering laws over a synthetic `.app` tree with
 * REAL Mach-O magic bytes; the actual `codesign` invocations are the
 * local packaging lane's (real codesign on the real packaged app — the
 * certify:adapter precedent: no signing ever runs in `npm test`).
 */

const MACHO_MAGIC_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1]);
const FAT_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

let appFixture: string | undefined;

async function newSyntheticApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astroix-codesign-test-'));
  const app = join(root, 'Astroix.app');
  const files: Array<[string[], Buffer | string, number?]> = [
    // the outer app's main executable (loose Mach-O inside the outer bundle)
    [['Contents', 'MacOS', 'Astroix'], MACHO_MAGIC_64, 0o755],
    [['Contents', 'Info.plist'], '<?xml version="1.0"?><plist/>'],
    [['Contents', 'Resources', 'app.asar'], 'asar-bytes'],
    // the bundled stock Node executable (loose Mach-O under Resources)
    [['Contents', 'Resources', 'node', 'bin', 'node'], MACHO_MAGIC_64, 0o755],
    [['Contents', 'Resources', 'astroix-runtime', 'control-plane', 'child.js'], 'export {}'],
    // the Electron framework bundle (its binary lives INSIDE the bundle)
    [
      [
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Electron Framework',
      ],
      MACHO_MAGIC_64,
      0o755,
    ],
    // a helper app bundle, its binary inside it
    [
      ['Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper'],
      MACHO_MAGIC_64,
      0o755,
    ],
    // a loose dylib at the Frameworks root (loaded by the framework)
    [['Contents', 'Frameworks', 'libffmpeg.dylib'], FAT_MAGIC, 0o644],
  ];
  for (const [segments, bytes, mode] of files) {
    const path = join(app, ...segments);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    if (mode !== undefined) await chmod(path, mode);
  }
  return app;
}

describe('Mach-O and bundle detection (#245)', () => {
  it('recognizes bundle directory names', () => {
    expect(isBundleDirName('Electron Framework.framework')).toBe(true);
    expect(isBundleDirName('Electron Helper.app')).toBe(true);
    expect(isBundleDirName('com.astroix.xpc')).toBe(true);
    expect(isBundleDirName('libffmpeg.dylib')).toBe(false);
    expect(isBundleDirName('node')).toBe(false);
    expect(isBundleDirName('MacOS')).toBe(false);
  });

  it('detects Mach-O by magic bytes — 64-bit LE, FAT, and their swapped forms; text is not Mach-O', async () => {
    expect(await isMachOFile(await tempFile(MACHO_MAGIC_64))).toBe(true);
    expect(await isMachOFile(await tempFile(FAT_MAGIC))).toBe(true);
    expect(await isMachOFile(await tempFile(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])))).toBe(true);
    expect(await isMachOFile(await tempFile(Buffer.from('just text, not a binary')))).toBe(false);
    expect(await isMachOFile(join(tmpdir(), 'astroix-no-such-file'))).toBe(false);
  });
});

describe('the nested-first signing plan over a synthetic .app (#245)', () => {
  it('plans the bundled Node executable first (deepest), bundles and loose Mach-O after, and never the outer app', async () => {
    const app = await ensureSyntheticApp();
    const plan = planNestedCodeOrdering(await listBundleCode(app));
    expect(plan.map((target) => target.relPath)).toEqual([
      'Contents/Resources/node/bin/node',
      'Contents/Frameworks/Electron Framework.framework',
      'Contents/Frameworks/Electron Helper.app',
      'Contents/Frameworks/libffmpeg.dylib',
      'Contents/MacOS/Astroix',
    ]);
    expect(plan.map((target) => target.kind)).toEqual([
      'mach-o',
      'framework',
      'helper-app',
      'mach-o',
      'mach-o',
    ]);
    // the outer app is never in the nested plan — the signer signs it LAST itself
    expect(plan.some((target) => target.relPath === '')).toBe(false);
  });

  it('seals bundle INTERIORS through the bundle target only — no separate nested-binary targets', async () => {
    const app = await ensureSyntheticApp();
    const plan = planNestedCodeOrdering(await listBundleCode(app));
    const paths = plan.map((target) => target.relPath);
    expect(paths).not.toContain(
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    );
    expect(paths).not.toContain(
      'Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper',
    );
  });

  it('never targets non-executable payload files', async () => {
    const app = await ensureSyntheticApp();
    const paths = planNestedCodeOrdering(await listBundleCode(app)).map((target) => target.relPath);
    expect(paths).not.toContain('Contents/Info.plist');
    expect(paths).not.toContain('Contents/Resources/app.asar');
    expect(paths).not.toContain('Contents/Resources/astroix-runtime/control-plane/child.js');
  });

  it("signs every target with the ad-hoc identity literally '-'", () => {
    expect(AD_HOC_IDENTITY).toBe('-');
    expect(AD_HOC_SIGN_ARGS).toContain('--force');
    expect(AD_HOC_SIGN_ARGS.join(' ')).toContain('--sign -');
  });
});

it('cleans the synthetic-app scratch root', async () => {
  if (appFixture !== undefined) {
    // one level up is the mkdtemp scratch root — never further (the
    // system tmpdir is not ours to delete)
    await rm(join(appFixture, '..'), { recursive: true, force: true });
    appFixture = undefined;
  }
});

/** Lazily creates the synthetic app once and reuses it for every plan assertion. */
async function ensureSyntheticApp(): Promise<string> {
  if (appFixture === undefined) {
    appFixture = await newSyntheticApp();
  }
  return appFixture;
}

async function tempFile(bytes: Buffer): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'astroix-macho-')), 'probe');
  await writeFile(path, bytes);
  return path;
}
