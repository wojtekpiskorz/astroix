import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type CandidateManifest,
  findForbiddenArtifacts,
  sha256File,
} from '../../src/forge/inventory.ts';
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

/**
 * The real-package legs' per-test budgets (#446): every leg below runs
 * only where a local `npm run package` artifact exists, and its work is
 * real-artifact-class — whole-binary reads, strict codesign passes,
 * full-tree walks — which stalls past vitest's silent 5 s default under
 * machine load (the red observed during PR #444's gate runs). Each
 * budget is named and sized to its leg's actual work (the #444 real-GUI
 * idiom: generous but bounded, single-homed so a future resize is one
 * line); assertions and the self-skip guards are unchanged.
 */

/**
 * The fuse-read budget: one full read of the real Electron Framework
 * binary hunting the fuse sentinel — big-binary I/O, instant on a calm
 * box, stall-shaped under load.
 */
const FUSE_READ_BUDGET_MS = 60_000;

/**
 * The full-verification budget: strict codesign verify+display over
 * every nested target plus the outer app — well over the 5 s default
 * even on a calm box. The bound this leg has always carried, now named.
 */
const CODESIGN_VERIFY_BUDGET_MS = 180_000;

/**
 * The stat budget: one stat of the bundled Node executable — trivial
 * work, bounded anyway so no leg in this lane rides a silent default.
 */
const NODE_STAT_BUDGET_MS = 30_000;

/**
 * The forbidden-artifact budget: one recursive walk of the whole `out/`
 * tree — thousands of entries in a real package.
 */
const FORBIDDEN_SWEEP_BUDGET_MS = 60_000;

/**
 * The ZIP-and-manifest budget: the streamed SHA-256 over the full
 * candidate ZIP plus the manifest reads.
 */
const ZIP_HASH_BUDGET_MS = 60_000;

describe.skipIf(!packaged)(
  'the real packaged app (#245 — run `npm run package` to make this lane live)',
  () => {
    it(
      'carries the release fuse states on the real Electron Framework binary',
      async () => {
        const states = await readFuseStates(APP_PATH);
        expect(states).toEqual(expectedReleaseFuseStates());
      },
      FUSE_READ_BUDGET_MS,
    );

    it(
      'passes the full verification: strict nested+outer codesign (adhoc), resources, identity, arch',
      async () => {
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
      },
      CODESIGN_VERIFY_BUDGET_MS,
    );

    it(
      'bundles the Node executable as an executable real file outside the asar',
      async () => {
        const info = await stat(join(APP_PATH, 'Contents', 'Resources', 'node', 'bin', 'node'));
        expect(info.isFile()).toBe(true);
        expect((info.mode & 0o111) !== 0).toBe(true);
      },
      NODE_STAT_BUDGET_MS,
    );

    it(
      'produced NO forbidden output: no DMG, no auto-update manifest (ADR-0008 non-goals)',
      async () => {
        await expectNoForbiddenArtifacts(OUT_DIR);
      },
      FORBIDDEN_SWEEP_BUDGET_MS,
    );
  },
);

const zipExists = packaged && existsSync(ZIP_DIR);

describe.skipIf(!zipExists)('the candidate ZIP and manifest (#245)', () => {
  it(
    'exactly one ZIP in the maker output, with the manifest recording its true SHA-256',
    async () => {
      const zips = (await readdir(ZIP_DIR)).filter((name) => name.endsWith('.zip'));
      expect(zips).toHaveLength(1);
      const manifest = await newestCandidateManifest();
      const zipSha = await sha256File(join(ZIP_DIR, manifest.zip.file));
      expect(manifest.zip.sha256).toBe(zipSha);
      expect(manifest.schema).toBe(1);
      expect(manifest.arch).toBe('arm64');
    },
    ZIP_HASH_BUDGET_MS,
  );
});

/** The manifest of the most recent package run — by manifest mtime, never by label sort (labels are arbitrary). */
async function newestCandidateManifest(): Promise<CandidateManifest> {
  const candidatesDir = join(OUT_DIR, 'candidates');
  const labels = await readdir(candidatesDir);
  expect(labels.length).toBeGreaterThan(0);
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
  // the ONE forbidden-artifact law (inventory.ts), consumed — the
  // script's sweep and this leg can never drift apart
  expect(await findForbiddenArtifacts(dir), 'ADR-0008 non-goal artifacts produced').toEqual([]);
}
