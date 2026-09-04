import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QualificationArguments } from '../../scripts/qualification/args.ts';
import type { BatteryOutcome } from '../../scripts/qualification/battery.ts';
import { runQualification } from '../../scripts/qualification/qualify.ts';
import { buildSyntheticZip } from './synthetic-artifact.ts';

/**
 * The orchestration leg of the qualification harness tests (#258, L1):
 * the "valid artifact" self-test — a well-formed candidate driven
 * through EVERY real stage (real intake, real extraction, real launch
 * in signal-only mode over the stub executable, real residual audit,
 * real staging cleanup, real evidence completeness) with the ONE
 * declared seam the synthetic world cannot satisfy injected: the
 * verification battery, which demands real signatures. The real
 * valid-artifact leg — no seams at all — is the local exact-H6-artifact
 * run. Darwin-only: the real extraction stage is `ditto`.
 */

const DARWIN = process.platform === 'darwin';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'astroix-qualification-orchestration-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** The passing battery the seam injects — the shape of a green H3 report. */
function greenBattery(): BatteryOutcome {
  return {
    ok: true,
    appPath: '(seam)',
    expectedNodePin: 'v24.20.0',
    nodeIdentity: {
      ok: true,
      declaredPin: 'v24.20.0',
      executedVersion: 'v24.20.0',
      executedAbi: '137',
      failure: null,
    },
    lines: ['package-verification: PASSED — (seam)'],
    verification: {
      appPath: '(seam)',
      ok: true,
      codesign: { appPath: '(seam)', ok: true, targets: [] },
      assets: { ok: true, detail: null },
      fuses: { ok: true, detail: { states: null, violations: [], rejection: null } },
      plist: {
        ok: true,
        detail: {
          facts: {
            bundleId: null,
            minimumSystemVersion: null,
            executable: null,
            asarIntegrityHash: null,
          },
          diffs: [],
        },
      },
      arch: { ok: true, detail: { findings: [] } },
    },
  };
}

/** The failing battery the seam injects — the negative variant. */
function redBattery(): BatteryOutcome {
  return {
    ...greenBattery(),
    ok: false,
    verification: { ...greenBattery().verification, ok: false },
  };
}

function argumentsFor(
  artifact: { zipPath: string; sha256: string },
  evidenceDir: string,
): QualificationArguments {
  return {
    artifact: artifact.zipPath,
    expectedSha256: artifact.sha256,
    evidenceDir,
    settleMs: 1500,
    quitTimeoutMs: 3000,
  };
}

describe.skipIf(!DARWIN)('the qualification orchestration (#258)', () => {
  it('a valid artifact passes every stage end to end and writes complete evidence', async () => {
    const artifact = await buildSyntheticZip(join(scratch, 'valid.zip'));
    const evidenceDir = join(scratch, 'evidence-valid');
    const result = await runQualification({
      args: argumentsFor(artifact, evidenceDir),
      quitMode: 'signal-only',
      seams: { battery: async () => greenBattery() },
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    const evidence = JSON.parse(await readFile(join(evidenceDir, 'evidence.json'), 'utf8')) as {
      stages: { name: string; status: string }[];
      verdict: { ok: boolean };
      artifact: { stagingRoot: string | null };
    };
    expect(evidence.verdict.ok).toBe(true);
    for (const record of evidence.stages) {
      expect(record.status, `${record.name} passed`).toBe('passed');
    }
    // the staging root is really gone
    expect(evidence.artifact.stagingRoot).not.toBeNull();
    expect(existsSync(evidence.artifact.stagingRoot as string)).toBe(false);
    // every evidence file is present
    expect((await readdir(evidenceDir)).sort()).toEqual(
      ['evidence.json', 'process-audit.json', 'run.log', 'verification.txt'].sort(),
    );
    const audit = JSON.parse(await readFile(join(evidenceDir, 'process-audit.json'), 'utf8')) as {
      termination: { outcome: string; exitCode: number | null };
      settle: { aliveAtSettle: boolean };
    };
    expect(audit.settle.aliveAtSettle).toBe(true);
    expect(audit.termination.outcome).toBe('exited-after-signal');
    expect(audit.termination.exitCode).toBe(0);
  }, 120_000);

  it('a battery failure skips the launch stages, still cleans up, still completes evidence', async () => {
    const artifact = await buildSyntheticZip(join(scratch, 'battery-fail.zip'));
    const evidenceDir = join(scratch, 'evidence-battery-fail');
    const result = await runQualification({
      args: argumentsFor(artifact, evidenceDir),
      quitMode: 'signal-only',
      seams: { battery: async () => redBattery() },
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('verification-battery');
    const evidence = JSON.parse(await readFile(join(evidenceDir, 'evidence.json'), 'utf8')) as {
      stages: { name: string; status: string }[];
      artifact: { stagingRoot: string | null };
    };
    const byName = new Map(evidence.stages.map((record) => [record.name, record.status]));
    expect(byName.get('verification-battery')).toBe('failed');
    expect(byName.get('launch')).toBe('skipped');
    expect(byName.get('termination')).toBe('skipped');
    expect(byName.get('residual-owned-processes')).toBe('skipped');
    expect(byName.get('staging-cleanup')).toBe('passed');
    expect(byName.get('evidence-completeness')).toBe('passed');
    expect(existsSync(evidence.artifact.stagingRoot as string)).toBe(false);
  }, 120_000);

  it('refuses a non-empty evidence directory — a recorded run is never silently discarded', async () => {
    const artifact = await buildSyntheticZip(join(scratch, 'refuse.zip'));
    const evidenceDir = join(scratch, 'evidence-refuse');
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'stale.txt'), 'x');
    await expect(
      runQualification({
        args: argumentsFor(artifact, evidenceDir),
        quitMode: 'signal-only',
        seams: { battery: async () => greenBattery() },
      }),
    ).rejects.toThrow(/not empty/);
  }, 60_000);
});
