import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkEvidenceCompleteness,
  EVIDENCE_FILES,
  EvidenceRecorder,
  prepareEvidenceDir,
  QUALIFICATION_STAGES,
} from '../../scripts/qualification/evidence.ts';

/**
 * The evidence law of the qualification harness (#258, L1 focused
 * tests — the "missing evidence" leg): the recorder fills an empty
 * supplied directory, and the completeness check judges the directory
 * FROM DISK — every expected file present and non-empty, every stage
 * recorded, the verdict sealed. A pre-existing non-empty evidence
 * directory is refused (a recorded run is never silently discarded).
 */

const ARGS = {
  artifact: '/tmp/candidate.zip',
  expectedSha256: 'c'.repeat(64),
  evidenceDir: '',
  settleMs: 1000,
  quitTimeoutMs: 1000,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'astroix-qualification-evidence-'));
  ARGS.evidenceDir = dir;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function recordCompleteRun(recorder: EvidenceRecorder): Promise<void> {
  for (const name of QUALIFICATION_STAGES) {
    if (name === 'evidence-completeness') continue; // written after the check, by design
    await recorder.recordStage({ name, status: 'passed', summary: 'ok' });
  }
  await recorder.writeVerificationReport('verification: PASSED\n');
  await recorder.writeProcessAudit({ run: true });
  await recorder.ensureFiles();
  await recorder.finish(true, []);
}

describe('the evidence recorder (#258)', () => {
  it('accepts an absent or empty directory and refuses a non-empty one', async () => {
    await prepareEvidenceDir(dir); // exists, empty — fine
    await writeFile(join(dir, 'stale.txt'), 'x');
    await expect(prepareEvidenceDir(dir)).rejects.toThrow(/not empty/);
    const fresh = join(dir, 'nested', 'fresh');
    await prepareEvidenceDir(fresh); // absent — created
  });

  it('writes every expected file and parses back as schema 1', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    await recordCompleteRun(recorder);
    const parsed = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8')) as {
      schema: number;
      stages: { name: string; status: string }[];
      verdict: { ok: boolean };
    };
    expect(parsed.schema).toBe(1);
    expect(parsed.verdict.ok).toBe(true);
    for (const name of QUALIFICATION_STAGES) {
      if (name === 'evidence-completeness') continue;
      expect(parsed.stages.some((stage) => stage.name === name)).toBe(true);
    }
  });

  it('fills skipped-stage files honestly — no silent gaps', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    await recorder.recordStage({
      name: 'artifact-checksum',
      status: 'failed',
      summary: 'sha256-mismatch',
    });
    await recorder.skipStages(
      QUALIFICATION_STAGES.filter(
        (name) => name !== 'artifact-checksum' && name !== 'evidence-completeness',
      ),
      'intake rejected the artifact',
    );
    await recorder.ensureFiles();
    await recorder.finish(false, ['artifact-checksum: sha256-mismatch']);
    const verification = await readFile(join(dir, 'verification.txt'), 'utf8');
    expect(verification).toContain('verification battery not run');
    const audit = JSON.parse(await readFile(join(dir, 'process-audit.json'), 'utf8')) as {
      run: boolean;
    };
    expect(audit.run).toBe(false);
  });
});

describe('the evidence completeness check fails closed on missing evidence (#258)', () => {
  it('passes a complete directory', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    await recordCompleteRun(recorder);
    expect(await checkEvidenceCompleteness(dir)).toEqual({ ok: true, problems: [] });
  });

  it('names every missing file', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    await recordCompleteRun(recorder);
    await rm(join(dir, 'verification.txt'));
    await rm(join(dir, 'run.log'));
    const verdict = await checkEvidenceCompleteness(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('missing evidence file verification.txt');
    expect(verdict.problems).toContain('missing evidence file run.log');
  });

  it('names an empty file — an empty report is a missing report', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    await recordCompleteRun(recorder);
    await writeFile(join(dir, 'process-audit.json'), '');
    const verdict = await checkEvidenceCompleteness(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('empty evidence file process-audit.json');
  });

  it('names a missing stage record and an unsealed verdict', async () => {
    const recorder = new EvidenceRecorder(dir, ARGS);
    // a run that recorded everything except the launch stage and never sealed
    for (const name of QUALIFICATION_STAGES) {
      if (name === 'evidence-completeness' || name === 'launch') continue;
      await recorder.recordStage({ name, status: 'passed', summary: 'ok' });
    }
    await recorder.writeVerificationReport('x\n');
    await recorder.writeProcessAudit({ run: true });
    await recorder.ensureFiles();
    const verdict = await checkEvidenceCompleteness(dir);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('stage launch');
    expect(verdict.problems.join('\n')).toContain('verdict');
  });

  it('expects exactly the four evidence files, no more no fewer', () => {
    expect([...EVIDENCE_FILES].sort()).toEqual(
      ['evidence.json', 'process-audit.json', 'run.log', 'verification.txt'].sort(),
    );
  });
});
