import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CandidateManifest } from '../../src/forge/inventory.ts';
import { verifyPackagedApp } from '../../src/forge/package-verification.ts';
import { expectedReleaseFuseStates, readFuseStates } from '../../src/forge/release-fuses.ts';

/**
 * The real-packaged-app lane (#245, H3): every assertion here runs
 * against the REAL packaged artifact a local `npm run package` produced
 * — real `codesign --verify --strict` on the real nested code and outer
 * app, the fuses read off the real Electron Framework binary, the
 * packaged-asset adapter over the real bundled Node, and the candidate
 * manifest whose checksums the L1/L2 qualification lanes consume
 * (ADR-0008). Like H2's packaged-spawn lane, this self-skips without a
 * local package: `npm test` stays deterministic and network-free (the
 * certify:adapter precedent), and the full packaging run is checkpoint-
 * only by migration policy.
 *
 * Accepted residual, recorded here per the #245 readiness carry-note:
 * the verify-then-spawn window is a TOCTOU no local signature check
 * closes — strict verification proves the bytes at check time; between
 * that check and any later child spawn the filesystem could in
 * principle change. ADR-0008's threat model accepts it for the
 * unsigned artifact; a future Developer-ID-signed + notarized bundle is
 * the lane that revisits this note (it is also recorded in
 * forge.config.ts and verify-package.mjs).
 */

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(DESKTOP_ROOT, 'out');
const APP_PATH = join(OUT_DIR, 'Astroix-darwin-arm64', 'Astroix.app');
const ZIP_DIR = join(OUT_DIR, 'make', 'zip', 'darwin', 'arm64');

const packaged = existsSync(APP_PATH);

describe.skipIf(!packaged)(
  'the real packaged app (#245 — run `npm run package` to make this lane live)',
  () => {
    it('carries the release fuse states on the real Electron Framework binary', async () => {
      const states = await readFuseStates(APP_PATH);
      expect(states).toEqual(expectedReleaseFuseStates());
    });

    it('passes the full verification: strict nested+outer codesign (adhoc), resources, identity, arch', async () => {
      // real codesign verify+display over every nested target takes well
      // over the default 5s — this lane only lives where a real package does
      const report = await verifyPackagedApp(APP_PATH);
      for (const target of report.codesign.targets) {
        // host code must be adhoc-sealed; the manifest-pinned Node
        // executable keeps its upstream signature (its bytes are pinned
        // by H2's build manifest — re-signing would tamper the hash)
        expect(target.verified, `${target.target} strict verification`).toBe(true);
        if (!target.adhocOptional) {
          expect(target.signature, `${target.target} sealed identity`).toBe('adhoc');
        }
      }
      expect(report.assets.ok, JSON.stringify(report.assets.detail)).toBe(true);
      expect(report.plist.ok, JSON.stringify(report.plist.detail.diffs)).toBe(true);
      expect(report.arch.ok, JSON.stringify(report.arch.detail.findings)).toBe(true);
      expect(report.ok).toBe(true);
    }, 180_000);

    it('bundles the Node executable as an executable real file outside the asar', async () => {
      const { stat } = await import('node:fs/promises');
      const info = await stat(join(APP_PATH, 'Contents', 'Resources', 'node', 'bin', 'node'));
      expect(info.isFile()).toBe(true);
      expect((info.mode & 0o111) !== 0).toBe(true);
    });

    it('produced NO forbidden output: no DMG, no auto-update manifest (ADR-0008 non-goals)', async () => {
      await expectNoForbiddenArtifacts(OUT_DIR);
    });
  },
);

const zipExists = packaged && existsSync(ZIP_DIR);

describe.skipIf(!zipExists)('the candidate ZIP and manifest (#245)', () => {
  it('exactly one ZIP in the maker output, with the manifest recording its true SHA-256', async () => {
    const zips = (await readdir(ZIP_DIR)).filter((name) => name.endsWith('.zip'));
    expect(zips).toHaveLength(1);
    const manifest = await newestCandidateManifest();
    const zipSha = await sha256File(join(ZIP_DIR, manifest.zip.file));
    expect(manifest.zip.sha256).toBe(zipSha);
    expect(manifest.schema).toBe(1);
    expect(manifest.arch).toBe('arm64');
  });
});

/** The manifest of the most recent package run — by manifest mtime, never by label sort (labels are arbitrary). */
async function newestCandidateManifest(): Promise<CandidateManifest> {
  const candidatesDir = join(OUT_DIR, 'candidates');
  const labels = await readdir(candidatesDir);
  expect(labels.length).toBeGreaterThan(0);
  const { stat } = await import('node:fs/promises');
  const stamped = await Promise.all(
    labels
      .map((label) => join(candidatesDir, label, 'manifest.json'))
      .filter((path) => existsSync(path))
      .map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })),
  );
  expect(stamped.length).toBeGreaterThan(0);
  const newest = stamped.reduce((a, b) => (a.mtime >= b.mtime ? a : b));
  return JSON.parse(await readFile(newest.path, 'utf8')) as CandidateManifest;
}

async function expectNoForbiddenArtifacts(dir: string): Promise<void> {
  const forbidden: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (
        entry.name.endsWith('.dmg') ||
        entry.name.endsWith('.dmg.part') ||
        entry.name === 'RELEASES.json'
      ) {
        forbidden.push(relative(OUT_DIR, absolute));
      }
    }
  };
  await walk(dir);
  expect(forbidden, 'ADR-0008 non-goal artifacts produced').toEqual([]);
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
