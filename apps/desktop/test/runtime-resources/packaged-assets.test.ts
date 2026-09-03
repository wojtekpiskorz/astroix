import { chmod, cp, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUILD_MANIFEST_RESOURCE_PATH,
  buildManifest,
  CONTROL_PLANE_ENTRY_RESOURCE_PATH,
  type ManifestResourceFacts,
  NODE_EXECUTABLE_RESOURCE_PATH,
  PACKAGED_CERTIFIED_PAIR,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
  resourceAbsolutePath,
  serializeManifest,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { QUALIFIED_NODE_VERSION } from '@wojciechpiskorz/astroix-runtime/kernel-lease';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ARCHITECTURE,
  FIXTURE_SOURCE_COMMIT,
  newScratchRoot,
  replaceWithOutsideSymlink,
  rewriteManifest,
  verifyFixture,
  writePackagedFixture,
} from './fixtures.ts';

/**
 * The internal packaged-asset adapter (#244, H2): the ratified resource
 * layout vocabulary, the pin table, the build manifest's determinism,
 * and the immutable-resource verifier's whole rejection matrix — over
 * real temp fixture layouts with fake executables and real SHA-256s
 * (AC: exact pins, real-file verification, fail-closed on missing /
 * altered / symlinked / wrong-version / wrong-architecture resources).
 */
describe('the packaged-asset adapter (#244)', () => {
  // ——— the pin table: the exact ADR-0008 pins, single-sourced ———

  it('pins the exact stock Node 24.20.0 — the kernel lease qualified pin, one source of truth (#209)', () => {
    expect(PACKAGED_NODE_PIN).toBe('v24.20.0');
    expect(PACKAGED_NODE_PIN).toBe(QUALIFIED_NODE_VERSION);
  });

  it('pins Electron, Forge, and the certified Astro/Vite pair exactly (ADR-0008)', () => {
    expect(PACKAGED_ELECTRON_PIN).toBe('44.1.0');
    expect(PACKAGED_FORGE_PIN).toBe('7.11.2');
    expect(PACKAGED_CERTIFIED_PAIR).toEqual({ astro: '7.2.10', vite: '8.2.2' });
  });

  // ——— the layout vocabulary: containment is provable ———

  describe('resourceAbsolutePath', () => {
    it('resolves ratified resource ids under the root', () => {
      const root = '/Applications/Astroix.app/Contents/Resources';
      expect(resourceAbsolutePath(root, NODE_EXECUTABLE_RESOURCE_PATH)).toBe(
        join(root, 'node', 'bin', 'node'),
      );
      expect(resourceAbsolutePath(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH)).toBe(
        join(root, 'astroix-runtime', 'control-plane', 'child.js'),
      );
    });

    it('rejects every escaping or malformed id — null, never a guess', () => {
      const root = '/Applications/Astroix.app/Contents/Resources';
      for (const id of [
        '..',
        '../outside',
        'node/../bin/node',
        '/etc/passwd',
        'node//bin',
        'node/bin/',
        '',
        '.',
        'node/bin/.',
        'node\\bin',
        'node/bin/-x',
      ]) {
        expect(resourceAbsolutePath(root, id), id).toBeNull();
      }
    });
  });

  // ——— the build manifest: same facts in, same bytes out ———

  describe('the build manifest', () => {
    const nodeFacts: ManifestResourceFacts = {
      path: NODE_EXECUTABLE_RESOURCE_PATH,
      sha256: 'a'.repeat(64),
      bytes: 1000,
      executable: true,
    };
    const entryFacts: ManifestResourceFacts = {
      path: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      sha256: 'b'.repeat(64),
      bytes: 2000,
      executable: false,
    };
    const facts = [nodeFacts, entryFacts];

    it('sorts the inventory by resource id — identical inputs build identical manifests, in any input order', () => {
      const first = buildManifest({
        sourceCommit: FIXTURE_SOURCE_COMMIT,
        architecture: FIXTURE_ARCHITECTURE,
        resources: facts,
      });
      const second = buildManifest({
        sourceCommit: FIXTURE_SOURCE_COMMIT,
        architecture: FIXTURE_ARCHITECTURE,
        resources: [...facts].reverse(),
      });
      expect(second).toEqual(first);
      expect(serializeManifest(second)).toBe(serializeManifest(first));
      expect(first.resources.map((resource) => resource.path)).toEqual([
        CONTROL_PLANE_ENTRY_RESOURCE_PATH,
        NODE_EXECUTABLE_RESOURCE_PATH,
      ]);
    });

    it('serializes to the fixed byte form: alphabetical keys, one trailing newline, pinned shape', () => {
      const manifest = buildManifest({
        sourceCommit: FIXTURE_SOURCE_COMMIT,
        architecture: FIXTURE_ARCHITECTURE,
        resources: facts,
      });
      const serialized = serializeManifest(manifest);
      expect(serialized.endsWith('}\n')).toBe(true);
      expect(Object.keys(JSON.parse(serialized) as object)).toEqual([
        'architecture',
        'electron',
        'forge',
        'node',
        'pair',
        'resources',
        'schema',
        'sourceCommit',
      ]);
      expect(JSON.parse(serialized)).toEqual({
        schema: 1,
        sourceCommit: FIXTURE_SOURCE_COMMIT,
        architecture: FIXTURE_ARCHITECTURE,
        electron: PACKAGED_ELECTRON_PIN,
        forge: PACKAGED_FORGE_PIN,
        node: PACKAGED_NODE_PIN,
        pair: { astro: '7.2.10', vite: '8.2.2' },
        resources: [
          {
            path: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
            sha256: 'b'.repeat(64),
            bytes: 2000,
            executable: false,
          },
          {
            path: NODE_EXECUTABLE_RESOURCE_PATH,
            sha256: 'a'.repeat(64),
            bytes: 1000,
            executable: true,
          },
        ],
      });
    });

    it('records only the pin table — a manifest never carries an unpinned value', () => {
      const manifest = buildManifest({
        sourceCommit: FIXTURE_SOURCE_COMMIT,
        architecture: FIXTURE_ARCHITECTURE,
        resources: facts,
      });
      expect(manifest.node).toBe(PACKAGED_NODE_PIN);
      expect(manifest.electron).toBe(PACKAGED_ELECTRON_PIN);
      expect(manifest.forge).toBe(PACKAGED_FORGE_PIN);
      expect(manifest.pair).toEqual({ astro: '7.2.10', vite: '8.2.2' });
    });

    it('throws on assembly facts the schema would reject — the assembler is upstream of correctness', () => {
      const base = { sourceCommit: FIXTURE_SOURCE_COMMIT, architecture: FIXTURE_ARCHITECTURE };
      expect(() =>
        buildManifest({ ...base, resources: [{ ...nodeFacts, path: '../escape' }] }),
      ).toThrow();
      expect(() =>
        buildManifest({ ...base, resources: [{ ...nodeFacts, sha256: 'A'.repeat(64) }] }),
      ).toThrow();
      expect(() => buildManifest({ ...base, resources: [{ ...nodeFacts, bytes: -1 }] })).toThrow();
      expect(() => buildManifest({ ...base, resources: [] })).toThrow();
      expect(() =>
        buildManifest({ ...base, sourceCommit: 'not-a-commit', resources: facts }),
      ).toThrow();
    });
  });

  // ——— verification: the happy path and every sanitized rejection ———

  describe('verifyPackagedAssets', () => {
    it('verifies a complete layout and resolves the spawn ingredients under the root', async () => {
      const root = await newScratchRoot('astroix-assets-happy-');
      await writePackagedFixture(root);

      const verified = await verifyFixture(root);
      expect(verified).toEqual({
        nodeExecutable: join(root, NODE_EXECUTABLE_RESOURCE_PATH),
        controlPlaneEntry: join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH),
        execArgv: [],
      });
    });

    it('rejects a missing manifest (manifest-missing)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rm(join(root, 'astroix-runtime', 'build-manifest.json'));

      await expectRejected(root, {
        code: 'manifest-missing',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects an unparseable manifest (manifest-unreadable)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await writeFile(join(root, 'astroix-runtime', 'build-manifest.json'), 'not-json{');

      await expectRejected(root, {
        code: 'manifest-unreadable',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects a schema-violating manifest (manifest-invalid)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        (parsed as { resources: unknown[] }).resources = [];
      });

      await expectRejected(root, {
        code: 'manifest-invalid',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects an unknown manifest shape outright (manifest-invalid)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        parsed.extraField = 'no strict object tolerates this';
      });

      await expectRejected(root, {
        code: 'manifest-invalid',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects a directly symlinked manifest leaf — the trust anchor sits under the same symlink policy (resource-symlink)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      // real intermediate directories, byte-identical content — the leaf
      // hop alone is the attack; readFile would follow it silently
      const manifestPath = join(root, BUILD_MANIFEST_RESOURCE_PATH);
      const outside = join(root, 'evil-manifest-copy');
      await cp(manifestPath, outside);
      await rm(manifestPath);
      await symlink(outside, manifestPath);

      await expectRejected(root, {
        code: 'resource-symlink',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects a hard-linked manifest — nlink must be 1 even for the anchor (resource-type)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      // the second link lives outside the two ratified subtrees, so the
      // unlisted-file walk stays silent — the leaf policy alone must fire
      await link(join(root, BUILD_MANIFEST_RESOURCE_PATH), join(root, 'manifest-copy'));

      await expectRejected(root, {
        code: 'resource-type',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects a non-regular manifest (resource-type)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rm(join(root, BUILD_MANIFEST_RESOURCE_PATH));
      await mkdir(join(root, BUILD_MANIFEST_RESOURCE_PATH));

      await expectRejected(root, {
        code: 'resource-type',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects an unreadable manifest read as inaccessible — never a hunt for a lost file (resource-inaccessible)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      // mode 0o000 on the manifest leaf: the lstat above passes (nothing
      // reads the mode bits), the open fails EACCES — the diagnostic must
      // say inaccessible, not missing
      await chmod(join(root, BUILD_MANIFEST_RESOURCE_PATH), 0o000);

      await expectRejected(root, {
        code: 'resource-inaccessible',
        resource: BUILD_MANIFEST_RESOURCE_PATH,
      });
    });

    it('rejects a wrong Node pin — a wrong-version resource never spawns (pin-mismatch)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        parsed.node = 'v24.19.0';
      });

      await expectRejected(root, {
        code: 'pin-mismatch',
        detail: { field: 'node', declared: 'v24.19.0', expected: 'v24.20.0' },
      });
    });

    it('rejects a wrong Electron pin against the running host (pin-mismatch)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      const outcome = await verifyPackagedAssets({
        resourcesRoot: root,
        architecture: FIXTURE_ARCHITECTURE,
        electronVersion: '44.0.0',
      });
      expect(outcome).toEqual({
        code: 'pin-mismatch',
        detail: { field: 'electron-running', declared: '44.1.0', expected: '44.0.0' },
      });
    });

    it('rejects a wrong architecture — wrong-architecture resources never spawn (pin-mismatch)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      const outcome = await verifyPackagedAssets({
        resourcesRoot: root,
        architecture: 'x64',
        electronVersion: '44.1.0',
      });
      expect(outcome).toEqual({
        code: 'pin-mismatch',
        detail: { field: 'architecture', declared: 'arm64', expected: 'x64' },
      });
    });

    it('rejects a wrong Forge pin and an uncertified Astro/Vite pair (pin-mismatch)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        parsed.forge = '7.11.1';
      });
      await expectRejected(root, {
        code: 'pin-mismatch',
        detail: { field: 'forge', declared: '7.11.1', expected: '7.11.2' },
      });

      const second = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(second);
      await rewriteManifest(second, (parsed) => {
        (parsed as { pair: { astro: string } }).pair.astro = '7.2.11';
      });
      await expectRejected(second, {
        code: 'pin-mismatch',
        detail: { field: 'pair', declared: '7.2.11 + 8.2.2', expected: 'the certified pair' },
      });
    });

    it('rejects a manifest that does not inventory the Node executable or the entry (layout-missing)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        (parsed as { resources: Array<{ path: string }> }).resources = (
          parsed as { resources: Array<{ path: string }> }
        ).resources.filter((resource) => resource.path !== NODE_EXECUTABLE_RESOURCE_PATH);
      });
      await expectRejected(root, {
        code: 'layout-missing',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });

      const second = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(second);
      await rewriteManifest(second, (parsed) => {
        (parsed as { resources: Array<{ path: string }> }).resources = (
          parsed as { resources: Array<{ path: string }> }
        ).resources.filter((resource) => resource.path !== CONTROL_PLANE_ENTRY_RESOURCE_PATH);
      });
      await expectRejected(second, {
        code: 'layout-missing',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a manifest that omits the module-type marker — the ESM identity is a required layout fact, not an assembly nicety (layout-missing)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        (parsed as { resources: Array<{ path: string }> }).resources = (
          parsed as { resources: Array<{ path: string }> }
        ).resources.filter((resource) => resource.path !== 'astroix-runtime/package.json');
      });

      await expectRejected(root, {
        code: 'layout-missing',
        resource: 'astroix-runtime/package.json',
      });
    });

    it('rejects unlisted files under the ratified subtrees — the inventory is complete in both directions (layout-unlisted)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await writeFile(join(root, 'node', 'bin', 'node2'), 'a dropped sibling\n');
      await expectRejected(root, { code: 'layout-unlisted', resource: 'node/bin/node2' });

      const second = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(second);
      await writeFile(
        join(second, 'astroix-runtime', 'control-plane', 'evil.js'),
        'export const evil = true;\n',
      );
      await expectRejected(second, {
        code: 'layout-unlisted',
        resource: 'astroix-runtime/control-plane/evil.js',
      });

      const third = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(third);
      await mkdir(join(third, 'node', 'lib'));
      await writeFile(join(third, 'node', 'lib', 'extra.txt'), 'nested drift\n');
      await expectRejected(third, { code: 'layout-unlisted', resource: 'node/lib/extra.txt' });
    });

    it('rejects an unlisted symlink under a ratified subtree — the walk never follows what no manifest names (layout-unlisted)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await symlink('/bin/sh', join(root, 'astroix-runtime', 'control-plane', 'evil.js'));

      await expectRejected(root, {
        code: 'layout-unlisted',
        resource: 'astroix-runtime/control-plane/evil.js',
      });
    });

    it('rejects a directory the walk cannot even list — hidden contents never ride along silently (resource-inaccessible)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      // a dropped directory holding no inventoried resource: the
      // required facts never stat it, the per-resource loop never walks
      // it — only this walk can, and it cannot list it. Fail closed on
      // the directory itself, never pass because the contents are dark
      await mkdir(join(root, 'astroix-runtime', 'evil'));
      await writeFile(join(root, 'astroix-runtime', 'evil', 'payload.js'), 'hidden drift\n');
      await chmod(join(root, 'astroix-runtime', 'evil'), 0o000);

      await expectRejected(root, {
        code: 'resource-inaccessible',
        resource: 'astroix-runtime/evil',
      });
    });

    it('rejects a Node executable recorded without its exec bit claim (executable-not-executable)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rewriteManifest(root, (parsed) => {
        (
          (parsed as { resources: Array<{ path: string; executable: boolean }> }).resources.find(
            (resource) => resource.path === NODE_EXECUTABLE_RESOURCE_PATH,
          ) ?? { executable: false }
        ).executable = false;
      });

      await expectRejected(root, {
        code: 'executable-not-executable',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects a Node executable whose exec bit was stripped on disk (executable-not-executable)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await chmod(join(root, NODE_EXECUTABLE_RESOURCE_PATH), 0o644);

      await expectRejected(root, {
        code: 'executable-not-executable',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects a missing resource — file and intermediate directory both (resource-missing)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rm(join(root, NODE_EXECUTABLE_RESOURCE_PATH));
      await expectRejected(root, {
        code: 'resource-missing',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });

      const second = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(second);
      await rm(join(second, 'node'), { recursive: true });
      await expectRejected(second, {
        code: 'resource-missing',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects an unreadable resource (resource-inaccessible)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await chmod(join(root, 'node', 'bin'), 0o000);

      await expectRejected(root, {
        code: 'resource-inaccessible',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects a leaf that stats fine but cannot be opened for hashing — the EACCES repro, sanitized (resource-inaccessible)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      // mode 0o000 on a NON-executable leaf under a searchable directory:
      // lstat passes, the exec-bit check is skipped (not marked
      // executable), the size matches — the failure lands on the hash
      // read, which must reject as a coded failure, never a thrown path
      await chmod(join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH), 0o000);

      await expectRejected(root, {
        code: 'resource-inaccessible',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a symlinked leaf — the symlink policy, leaves included (resource-symlink)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await replaceWithOutsideSymlink(root, NODE_EXECUTABLE_RESOURCE_PATH, '/bin/sh');

      await expectRejected(root, {
        code: 'resource-symlink',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects a symlinked intermediate directory — the hop is how a regular-looking leaf escapes (resource-symlink)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);

      // the target carries a byte-identical subtree INCLUDING the manifest,
      // so the manifest reads fine — the hop itself is the rejection
      const outside = await newScratchRoot('astroix-assets-outside-');
      await cp(join(root, 'astroix-runtime'), join(outside, 'real-runtime'), { recursive: true });
      await rm(join(root, 'astroix-runtime'), { recursive: true });
      await symlink(join(outside, 'real-runtime'), join(root, 'astroix-runtime'));

      const outcome = await verifyFixture(root);
      expect(outcome).toEqual({
        code: 'resource-symlink',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a non-file resource (resource-type)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await rm(join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH));
      await mkdir(join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH));

      await expectRejected(root, {
        code: 'resource-type',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a hard-linked resource — nlink must be 1 (resource-type)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await link(join(root, NODE_EXECUTABLE_RESOURCE_PATH), join(root, 'node', 'bin', 'second'));

      await expectRejected(root, {
        code: 'resource-type',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });

    it('rejects an altered resource — size and hash both pinned (resource-tampered)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await writeFile(join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH), 'export const evil = true;\n');

      await expectRejected(root, {
        code: 'resource-tampered',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a same-length bit-flip — the hash, not the size, is the identity (resource-tampered)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      const entry = join(root, CONTROL_PLANE_ENTRY_RESOURCE_PATH);
      const bytes = await readFile(entry);
      bytes[0] = bytes[0] === 0x65 ? 0x66 : 0x65;
      await writeFile(entry, bytes);

      await expectRejected(root, {
        code: 'resource-tampered',
        resource: CONTROL_PLANE_ENTRY_RESOURCE_PATH,
      });
    });

    it('rejects a substituted Node binary wholesale — the wrong-Node case is byte-pinned (resource-tampered)', async () => {
      const root = await newScratchRoot('astroix-assets-');
      await writePackagedFixture(root);
      await writeFile(join(root, NODE_EXECUTABLE_RESOURCE_PATH), 'a-different-node-binary\n');
      await chmod(join(root, NODE_EXECUTABLE_RESOURCE_PATH), 0o755);

      await expectRejected(root, {
        code: 'resource-tampered',
        resource: NODE_EXECUTABLE_RESOURCE_PATH,
      });
    });
  });
});

/** Asserts one sanitized rejection, exactly — the full vocabulary shape the public surface may carry. */
async function expectRejected(
  root: string,
  failure: { code: string; resource?: string; detail?: Record<string, string> },
): Promise<void> {
  const outcome = await verifyFixture(root);
  expect(outcome).toEqual(failure);
}
