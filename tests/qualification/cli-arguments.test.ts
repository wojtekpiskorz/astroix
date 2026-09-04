import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The CLI argument legs (#258, L1 focused tests): implicit paths and
 * environment-derived candidate selection are REJECTED — proven live
 * by spawning the real CLI with planted decoy environment variables
 * that would select a candidate if the harness ever read them. These
 * legs run everywhere: every rejection here fires in the argument
 * parser, before any macOS tool is reached.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'scripts', 'qualification', 'cli.ts');
const NODE_FLAGS = [
  '--experimental-transform-types',
  '--import',
  './apps/desktop/raw-node-register.mjs',
];

const VALID_SHA = 'b'.repeat(64);

interface CliRun {
  readonly code: number;
  readonly stderr: string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stderr: Buffer.concat(stderr).toString('utf8') }),
    );
  });
}

describe('the qualification CLI rejects implicit and env-derived candidates (#258)', () => {
  it('exits 2 with the usage when any required flag is missing', async () => {
    const none = await runCli([]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('missing required flag --artifact');
    expect(none.stderr).toContain('usage:');

    const noChecksum = await runCli(['--artifact', '/tmp/a.zip', '--evidence', '/tmp/e']);
    expect(noChecksum.code).toBe(2);
    expect(noChecksum.stderr).toContain('--expected-sha256');
  }, 60_000);

  it('rejects a malformed checksum as a usage error before anything runs', async () => {
    const run = await runCli([
      '--artifact',
      '/tmp/a.zip',
      '--expected-sha256',
      'not-a-hash',
      '--evidence',
      '/tmp/e',
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('64 lower-case hex digits');
  }, 60_000);

  it('rejects env-derived candidate selection — planted decoy environments never substitute a flag', async () => {
    // Every plausible environment spelling a harness might be tempted
    // to read: none of them may select the artifact, the checksum, or
    // the evidence directory.
    const decoys: NodeJS.ProcessEnv = {
      ASTROIX_QUALIFICATION_ARTIFACT: '/tmp/decoy.zip',
      ASTROIX_QUALIFICATION_ZIP: '/tmp/decoy.zip',
      ASTROIX_QUALIFICATION_EXPECTED_SHA256: VALID_SHA,
      ASTROIX_QUALIFICATION_SHA256: VALID_SHA,
      ASTROIX_QUALIFICATION_EVIDENCE: '/tmp/decoy-evidence',
      ASTROIX_CANDIDATE_ZIP: '/tmp/decoy.zip',
      ASTROIX_EARLY_PACKAGE_ZIP: '/tmp/decoy.zip',
    };
    const withNoFlags = await runCli([], decoys);
    expect(withNoFlags.code).toBe(2);
    expect(withNoFlags.stderr).toContain('missing required flag');

    // Even with two of the three flags present, the missing one is not
    // filled from the environment — and the decoy artifact (which
    // exists only in the environment) is never examined.
    const withPartialFlags = await runCli(
      ['--artifact', '/tmp/a.zip', '--evidence', '/tmp/e'],
      decoys,
    );
    expect(withPartialFlags.code).toBe(2);
    expect(withPartialFlags.stderr).toContain('missing required flag --expected-sha256');
  }, 60_000);

  it('rejects unknown flags instead of ignoring them', async () => {
    const run = await runCli([
      '--artifact',
      '/tmp/a.zip',
      '--expected-sha256',
      VALID_SHA,
      '--evidence',
      '/tmp/e',
      '--label',
      'decoy',
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown flag --label');
  }, 60_000);

  // The evidence-directory refusal is environment misuse: the documented
  // exit-2 usage class, never an unhandled rejection (review round 1 on
  // #373). Darwin-only — the CLI's platform guard (also exit 2) fires
  // first everywhere else, and the stderr message is the distinguisher.
  it.skipIf(process.platform !== 'darwin')(
    'exits 2, not with an unhandled rejection, when the evidence directory is non-empty',
    async () => {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const evidenceDir = await mkdtemp(join(tmpdir(), 'astroix-qual-cli-refusal-'));
      await writeFile(join(evidenceDir, 'stale.txt'), 'x');
      const run = await runCli(
        ['--artifact', '/tmp/a.zip', '--expected-sha256', VALID_SHA, '--evidence', evidenceDir],
        {},
      );
      expect(run.code).toBe(2);
      expect(run.stderr).toContain('is not empty');
      expect(run.stderr).not.toContain('at async'); // no unhandled-rejection stack
    },
    60_000,
  );
});
