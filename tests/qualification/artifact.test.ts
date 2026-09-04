import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSyntheticZip, type SyntheticArtifact } from './synthetic-artifact.ts';

/**
 * The harness self-tests over synthetic candidate artifacts (#258, L1
 * focused tests): valid, corrupt, truncated, extra-file, symlinked,
 * hash-mismatched, and wrong-runtime ZIPs — each driven through the
 * REAL CLI subprocess, each rejected (or passed) at the stage that
 * owns the law, with the evidence record naming the exact rejection.
 * These legs use the macOS packaging tools (`zip -T`, `ditto`,
 * `codesign` through the battery) and self-skip elsewhere (the #339
 * pattern); the exact-H6-artifact qualification run is local-only.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'scripts', 'qualification', 'cli.ts');
const NODE_FLAGS = [
  '--experimental-transform-types',
  '--import',
  './apps/desktop/raw-node-register.mjs',
];

const DARWIN_ARM64 = process.platform === 'darwin' && process.arch === 'arm64';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'astroix-qualification-artifact-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

interface StageRecord {
  readonly name: string;
  readonly status: string;
  readonly summary: string;
  readonly detail?: unknown;
}

interface EvidenceRecord {
  readonly stages: readonly StageRecord[];
  readonly artifact: {
    readonly sha256Match: boolean | null;
    readonly bundledNode: { readonly executedVersion: string | null } | null;
  };
  readonly verdict: { readonly ok: boolean } | null;
}

interface CliRun {
  readonly code: number;
  readonly output: string;
  readonly evidence: EvidenceRecord;
}

/**
 * Runs the real CLI over one artifact — decoy environment variables
 * ride along on every run, keeping env-derived candidate selection
 * dead even when the explicit flags are valid.
 */
async function qualify(
  artifact: SyntheticArtifact,
  expectedSha = artifact.sha256,
): Promise<CliRun> {
  const evidenceDir = join(scratch, `evidence-${Math.random().toString(36).slice(2)}`);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...NODE_FLAGS,
        CLI,
        '--artifact',
        artifact.zipPath,
        '--expected-sha256',
        expectedSha,
        '--evidence',
        evidenceDir,
        '--settle-ms',
        '1500',
        '--quit-timeout-ms',
        '3000',
      ],
      {
        cwd: REPO,
        env: {
          ...process.env,
          ASTROIX_QUALIFICATION_ARTIFACT: '/tmp/decoy.zip',
          ASTROIX_QUALIFICATION_EVIDENCE: '/tmp/decoy-evidence',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(`${Buffer.concat(chunks).toString('utf8')}\n(exit ${String(code)})`);
    });
  });
  const evidence = JSON.parse(
    await readFile(join(evidenceDir, 'evidence.json'), 'utf8'),
  ) as EvidenceRecord;
  return { code: Number(/exit (-?\d+)/.exec(output)?.[1] ?? -1), output, evidence };
}

const stage = (run: CliRun, name: string): StageRecord | undefined =>
  run.evidence.stages.find((record) => record.name === name);

/** Rewrites one artifact's bytes and returns its new identity (path + true checksum). */
async function rewritten(
  source: SyntheticArtifact,
  mutate: (bytes: Buffer) => Buffer,
  name: string,
): Promise<SyntheticArtifact> {
  const bytes = mutate(await readFile(source.zipPath));
  const zipPath = join(scratch, name);
  await writeFile(zipPath, bytes);
  return { zipPath, sha256: createHash('sha256').update(bytes).digest('hex') };
}

describe.skipIf(!DARWIN_ARM64)(
  'the qualification harness self-tests over synthetic artifacts (#258)',
  () => {
    it('a hash-mismatched artifact fails closed at the checksum, honestly, with complete evidence', async () => {
      const artifact = await buildSyntheticZip(join(scratch, 'mismatch.zip'));
      const run = await qualify(artifact, '0'.repeat(64));
      expect(run.code).toBe(1);
      expect(stage(run, 'artifact-checksum')?.status).toBe('failed');
      expect(stage(run, 'artifact-checksum')?.summary).toContain('sha256-mismatch');
      expect(run.evidence.artifact.sha256Match).toBe(false);
      expect(stage(run, 'launch')?.status).toBe('skipped');
      expect(run.evidence.verdict?.ok).toBe(false);
      // fail-closed, not evidence-less: the completeness stage passed over the honest record
      expect(stage(run, 'evidence-completeness')?.status).toBe('passed');
    }, 120_000);

    it('a corrupted archive fails closed at structural integrity (the CRC law)', async () => {
      const source = await buildSyntheticZip(join(scratch, 'corrupt-src.zip'));
      // flip one byte mid-payload — the checksum is recomputed so the
      // corruption is a STRUCTURAL finding, not a checksum finding
      const at = (bytes: Buffer): number => Math.floor(bytes.byteLength * 0.6);
      const corrupted = await rewritten(
        source,
        (bytes) => {
          const copy = Buffer.from(bytes);
          copy[at(copy)] = copy[at(copy)] === 0xff ? 0xee : 0xff;
          return copy;
        },
        'corrupt.zip',
      );
      const run = await qualify(corrupted);
      expect(run.code).toBe(1);
      expect(stage(run, 'artifact-checksum')?.status).toBe('passed');
      expect(stage(run, 'zip-integrity')?.status).toBe('failed');
      expect(stage(run, 'zip-integrity')?.summary).toContain('zip-structurally-invalid');
    }, 120_000);

    it('a truncated archive fails closed at structural integrity', async () => {
      const source = await buildSyntheticZip(join(scratch, 'truncated-src.zip'));
      const truncated = await rewritten(
        source,
        (bytes) => bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength * 0.5))),
        'truncated.zip',
      );
      const run = await qualify(truncated);
      expect(run.code).toBe(1);
      expect(stage(run, 'zip-integrity')?.status).toBe('failed');
      expect(stage(run, 'extraction')?.status).toBe('skipped');
    }, 120_000);

    it('an unexpected file at the ZIP root fails closed at the extraction shape', async () => {
      const source = await buildSyntheticZip(join(scratch, 'extra-src.zip'));
      const readme = join(scratch, 'README.txt');
      await writeFile(readme, 'stray\n');
      // -j stores the file at the archive root: extraction yields more than the one app bundle
      await new Promise<void>((resolve, reject) => {
        const child = spawn('zip', ['-q', '-j', source.zipPath, readme]);
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`zip exited ${String(code)}`)),
        );
      });
      const withExtra = await rewritten(source, (bytes) => bytes, 'extra-root.zip');
      const run = await qualify(withExtra);
      expect(run.code).toBe(1);
      expect(stage(run, 'extraction')?.status).toBe('failed');
      expect(stage(run, 'extraction')?.summary).toContain('unexpected-zip-root');
    }, 120_000);

    it('a well-formed artifact passes every intake stage and fails honestly at the battery (unsigned)', async () => {
      const artifact = await buildSyntheticZip(join(scratch, 'wellformed.zip'));
      const run = await qualify(artifact);
      expect(run.code).toBe(1);
      expect(stage(run, 'artifact-checksum')?.status).toBe('passed');
      expect(stage(run, 'zip-integrity')?.status).toBe('passed');
      expect(stage(run, 'extraction')?.status).toBe('passed');
      expect(stage(run, 'verification-battery')?.status).toBe('failed'); // no real signature — fail closed
      expect(stage(run, 'launch')?.status).toBe('skipped');
    }, 120_000);

    it('a symlink substitution inside the resources is named by the battery (resource-symlink)', async () => {
      const artifact = await buildSyntheticZip(join(scratch, 'symlinked.zip'), {
        symlinkEntry: true,
      });
      const run = await qualify(artifact);
      expect(run.code).toBe(1);
      const battery = stage(run, 'verification-battery');
      expect(battery?.status).toBe('failed');
      const detail = battery?.detail as
        | { assetsDetail?: { code?: string; resource?: string } }
        | undefined;
      expect(detail?.assetsDetail).toMatchObject({
        code: 'resource-symlink',
        resource: 'astroix-runtime/control-plane/child.js',
      });
    }, 120_000);

    it('an unexpected file inside the resources is named by the battery (layout-unlisted)', async () => {
      const artifact = await buildSyntheticZip(join(scratch, 'extrafile.zip'), {
        extraResourceFile: true,
      });
      const run = await qualify(artifact);
      expect(run.code).toBe(1);
      const battery = stage(run, 'verification-battery');
      const detail = battery?.detail as
        | { assetsDetail?: { code?: string; resource?: string } }
        | undefined;
      expect(detail?.assetsDetail).toMatchObject({
        code: 'layout-unlisted',
        resource: 'astroix-runtime/dropped-in.js',
      });
    }, 120_000);

    it('a wrong-runtime artifact fails closed at the bundled-Node identity — the executed identity is the law', async () => {
      const artifact = await buildSyntheticZip(join(scratch, 'wrongruntime.zip'), {
        executedNodeVersion: 'v21.7.3',
      });
      const run = await qualify(artifact);
      expect(run.code).toBe(1);
      const identity = stage(run, 'bundled-node-identity');
      expect(identity?.status).toBe('failed');
      expect(identity?.summary).toContain('identity-mismatch');
      expect(run.evidence.artifact.bundledNode?.executedVersion).toBe('v21.7.3');
    }, 120_000);
  },
);
