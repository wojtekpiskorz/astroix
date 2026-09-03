import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCandidateManifest,
  buildPayloadInventory,
  type CandidateManifest,
  classifyPayload,
  compareCandidateManifests,
  type PayloadEntry,
  serializeCandidateManifest,
} from '../../src/forge/inventory.ts';

/**
 * The candidate-comparison law (#245, H3; ADR-0008 minimal
 * qualification): two clean builds compared by normalized payload
 * inventory and immutable hashes — and the byte-identity claim stops
 * exactly at the sealed (signature-embedding) files; ZIP bytes are
 * checksum data, never compared. These units pin the classification,
 * the walk, and the comparison over synthetic trees; the REAL
 * two-build comparison is the local packaging lane
 * (`npm run package -- --label a` twice + `npm run verify:package --
 * --compare`).
 */

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1]);

let scratch: string | undefined;

async function newSyntheticApp(): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), 'astroix-inventory-test-'));
  const app = join(scratch, 'a.app');
  await rm(app, { recursive: true, force: true }); // symlinks cannot be recreated over themselves
  const rows: Array<[string[], string | Buffer, number?]> = [
    [['Contents', 'Info.plist'], 'plist-bytes'],
    [['Contents', 'MacOS', 'Astroix'], MACHO, 0o755],
    [['Contents', 'Resources', 'app.asar'], 'asar-bytes'],
    [['Contents', 'Resources', 'node', 'bin', 'node'], MACHO, 0o755],
    [['Contents', '_CodeSignature', 'CodeResources'], 'seal-bytes'],
    [['Contents', 'Frameworks', 'S.framework', 'Versions', 'A', 'S'], MACHO, 0o755],
  ];
  for (const [segments, bytes, mode] of rows) {
    const path = join(app, ...segments);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
    if (mode !== undefined) await chmod(path, mode);
  }
  // the framework's Current pointer — the real layout's deterministic symlink
  await symlink('A', join(app, 'Contents', 'Frameworks', 'S.framework', 'Versions', 'Current'));
  return app;
}

function machOByPath(relPath: string): Promise<boolean> {
  return Promise.resolve(
    relPath === 'Contents/MacOS/Astroix' ||
      relPath === 'Contents/Resources/node/bin/node' ||
      relPath === 'Contents/Frameworks/S.framework/Versions/A/S',
  );
}

const MANIFEST_BASE = {
  product: 'Astroix',
  version: '0.1.0',
  sourceCommit: 'a'.repeat(40),
  electron: '44.1.0',
  forge: '7.11.2',
  node: 'v24.20.0',
  minimumSystemVersion: '13.5',
  fuseStates: { RunAsNode: 'disable', OnlyLoadAppFromAsar: 'enable' },
  zip: { file: 'Astroix-darwin-arm64-0.1.0.zip', bytes: 1000, sha256: '0'.repeat(64) },
};

describe('payload classification (#245)', () => {
  it('classifies Mach-O and _CodeSignature seals as sealed — outside the byte-identity claim', () => {
    expect(classifyPayload('Contents/MacOS/Astroix', true)).toBe('sealed');
    expect(classifyPayload('Contents/_CodeSignature/CodeResources', false)).toBe('sealed');
    expect(
      classifyPayload(
        'Contents/Frameworks/S.framework/Contents/_CodeSignature/CodeResources',
        false,
      ),
    ).toBe('sealed');
  });

  it("classifies the build's own content as immutable", () => {
    expect(classifyPayload('Contents/Info.plist', false)).toBe('immutable');
    expect(classifyPayload('Contents/Resources/app.asar', false)).toBe('immutable');
    expect(classifyPayload('Contents/Resources/node/bin/node', false)).toBe('immutable');
  });
});

describe('the payload walk (#245)', () => {
  it('inventories every file with path, size, executable bit, hash — sorted by path', async () => {
    const entries = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    expect(entries.map((entry) => entry.path)).toEqual([
      'Contents/Frameworks/S.framework/Versions/A/S',
      'Contents/Frameworks/S.framework/Versions/Current',
      'Contents/Info.plist',
      'Contents/MacOS/Astroix',
      'Contents/Resources/app.asar',
      'Contents/Resources/node/bin/node',
      'Contents/_CodeSignature/CodeResources',
    ]);
    const node = fileRow(entries, 'Contents/Resources/node/bin/node');
    expect(node.executable).toBe(true);
    expect(node.bytes).toBe(MACHO.length);
    const asar = fileRow(entries, 'Contents/Resources/app.asar');
    expect(asar.executable).toBe(false);
    expect(asar.class).toBe('immutable');
  });

  it('records symlink PRESENCE + TARGET — never a silent skip (#245 review finding)', async () => {
    const entries = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const current = entries.find(
      (entry) => entry.path === 'Contents/Frameworks/S.framework/Versions/Current',
    );
    expect(current).toBeDefined();
    expect(current && 'symlinkTarget' in current && current.symlinkTarget).toBe('A');
  });
});

describe('the candidate manifest (#245)', () => {
  it('normalizes its payload (sorted) and serializes deterministically', async () => {
    const payload = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const manifest = buildCandidateManifest({ ...MANIFEST_BASE, payload: [...payload].reverse() });
    expect(manifest.payload[0]?.path).toBe('Contents/Frameworks/S.framework/Versions/A/S');
    expect(serializeCandidateManifest(manifest)).toBe(serializeCandidateManifest(manifest));
    expect(JSON.parse(serializeCandidateManifest(manifest))).toMatchObject({
      schema: 1,
      arch: 'arm64',
      platform: 'darwin',
    });
  });
});

describe('the two-build comparison (#245)', () => {
  it('two identical clean builds: inventories and immutable hashes both match', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const b = buildCandidateManifest({
      ...MANIFEST_BASE,
      payload: payloadA.map((row) => ({ ...row })),
    });
    const comparison = compareCandidateManifests(a, b);
    expect(comparison.inventoriesMatch).toBe(true);
    expect(comparison.immutableHashesMatch).toBe(true);
    expect(comparison.identityMatches).toBe(true);
  });

  it('a mutated immutable file is named — its hash differs', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const mutated = payloadA.map((row) =>
      'symlinkTarget' in row
        ? row
        : row.path === 'Contents/Resources/app.asar'
          ? { ...row, sha256: 'f'.repeat(64) }
          : row,
    ) satisfies PayloadEntry[];
    const b = buildCandidateManifest({ ...MANIFEST_BASE, payload: mutated });
    const comparison = compareCandidateManifests(a, b);
    expect(comparison.immutableHashesMatch).toBe(false);
    expect(comparison.immutableHashDiffs).toEqual(['Contents/Resources/app.asar']);
  });

  it('sealed bytes may differ without failing the comparison — that is the no-byte-claim boundary', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const resealed = payloadA.map((row) =>
      'symlinkTarget' in row
        ? row
        : row.class === 'sealed'
          ? { ...row, sha256: 'e'.repeat(64) }
          : row,
    ) satisfies PayloadEntry[];
    const b = buildCandidateManifest({ ...MANIFEST_BASE, payload: resealed });
    const comparison = compareCandidateManifests(a, b);
    expect(comparison.immutableHashesMatch).toBe(true);
    expect(comparison.inventoriesMatch).toBe(true);
  });

  it('an inventory change (size or missing file) fails even when hashes are untouched', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const grown = payloadA.map((row) =>
      'symlinkTarget' in row
        ? row
        : row.path === 'Contents/Resources/app.asar'
          ? { ...row, bytes: row.bytes + 1 }
          : row,
    );
    const b = buildCandidateManifest({ ...MANIFEST_BASE, payload: grown });
    expect(compareCandidateManifests(a, b).inventoriesMatch).toBe(false);
    const missing = payloadA.filter((row) => row.path !== 'Contents/Resources/app.asar');
    const c = buildCandidateManifest({ ...MANIFEST_BASE, payload: missing });
    const missingComparison = compareCandidateManifests(a, c);
    expect(missingComparison.inventoriesMatch).toBe(false);
    expect(missingComparison.inventoryDiffs).toEqual(['Contents/Resources/app.asar: missing in B']);
    // the hash facet compares rows present in both builds — the missing
    // row already failed the inventory above; no double-counting here
    expect(missingComparison.immutableHashesMatch).toBe(true);
  });

  it('symlink TARGET drift is an inventory difference — drift cannot ride silently (#245 review finding)', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const drifted = payloadA.map((row) =>
      'symlinkTarget' in row ? { ...row, symlinkTarget: 'B' } : row,
    );
    const b = buildCandidateManifest({ ...MANIFEST_BASE, payload: drifted });
    const comparison = compareCandidateManifests(a, b);
    expect(comparison.inventoriesMatch).toBe(false);
    expect(comparison.inventoryDiffs).toEqual([
      'Contents/Frameworks/S.framework/Versions/Current: symlink A vs B',
    ]);
    // the target is the whole law — no hash claim either way
    expect(comparison.immutableHashesMatch).toBe(true);
  });

  it('a path flipping between symlink and file is an inventory difference', async () => {
    const payloadA = await buildPayloadInventory(await newSyntheticApp(), machOByPath);
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload: payloadA });
    const flipped = payloadA.map((row) =>
      row.path === 'Contents/Frameworks/S.framework/Versions/Current'
        ? {
            path: row.path,
            bytes: 1,
            executable: false,
            sha256: '1'.repeat(64),
            class: 'immutable' as const,
          }
        : row,
    );
    const b = buildCandidateManifest({ ...MANIFEST_BASE, payload: flipped });
    const comparison = compareCandidateManifests(a, b);
    expect(comparison.inventoriesMatch).toBe(false);
    expect(comparison.inventoryDiffs[0]).toContain('symlink A vs null');
  });

  it('identity drift (commit, pins, fuses) is named even when the payload matches', () => {
    const payload: PayloadEntry[] = [];
    const a = buildCandidateManifest({ ...MANIFEST_BASE, payload });
    const drifts: CandidateManifest[] = [
      buildCandidateManifest({ ...MANIFEST_BASE, sourceCommit: 'b'.repeat(40), payload }),
      buildCandidateManifest({ ...MANIFEST_BASE, forge: '7.12.0', payload }),
      buildCandidateManifest({
        ...MANIFEST_BASE,
        fuseStates: { RunAsNode: 'enable', OnlyLoadAppFromAsar: 'enable' },
        payload,
      }),
    ];
    for (const drifted of drifts) {
      expect(compareCandidateManifests(a, drifted).identityMatches).toBe(false);
    }
    // differing ZIP bytes alone are NEVER an identity or payload failure
    const otherZip = buildCandidateManifest({
      ...MANIFEST_BASE,
      zip: { file: 'other.zip', bytes: 2, sha256: 'a'.repeat(64) },
      payload,
    });
    expect(compareCandidateManifests(a, otherZip).identityMatches).toBe(true);
  });
});

/** Narrows a found row to its file shape — the walk test's fixture paths are all files except Versions/Current. */
function fileRow(
  entries: readonly PayloadEntry[],
  path: string,
): {
  bytes: number;
  executable: boolean;
  class: 'immutable' | 'sealed';
} {
  const row = entries.find((entry) => entry.path === path);
  if (row === undefined || 'symlinkTarget' in row) throw new Error(`file row missing: ${path}`);
  return row;
}

it('cleans the inventory scratch root', async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});
