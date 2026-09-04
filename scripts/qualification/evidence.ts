import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostFacts } from './host-facts.ts';

/**
 * The evidence law of the packaged-qualification harness (#258, L1):
 * every qualification run writes a COMPLETE, self-describing evidence
 * record — and fails closed when it cannot. Translated from the early
 * packaged smoke's write-once record idioms (#248, H6): the evidence
 * directory is supplied explicitly, must be absent or empty (a recorded
 * run is never silently discarded), the record is rewritten
 * incrementally so a mid-run crash still leaves an honest partial
 * record, and the final completeness check re-reads what was written
 * from disk — missing or empty evidence files fail the run even when
 * every artifact check passed.
 *
 * Evidence stays outside tracked source: the harness never chooses the
 * directory (the caller passes it explicitly) and never rewrites the
 * supplied artifact.
 */

/** Every stage a complete qualification run records, in run order. */
export const QUALIFICATION_STAGES = [
  'artifact-checksum',
  'zip-integrity',
  'extraction',
  'verification-battery',
  'bundled-node-identity',
  'launch',
  'termination',
  'residual-owned-processes',
  'staging-cleanup',
  'evidence-completeness',
] as const;

export type QualificationStageName = (typeof QUALIFICATION_STAGES)[number];

/** One stage's recorded verdict. */
export interface QualificationStageRecord {
  readonly name: QualificationStageName;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly summary: string;
  readonly detail?: unknown;
}

/** The artifact facts, filled progressively as stages examine the ZIP. */
export interface ArtifactFacts {
  readonly zipPath: string;
  readonly zipBytes: number | null;
  readonly zipSha256Actual: string | null;
  readonly zipSha256Expected: string;
  readonly sha256Match: boolean | null;
  readonly zipStructuralTest: 'passed' | 'failed' | null;
  readonly extractedAppPath: string | null;
  readonly stagingRoot: string | null;
  readonly bundledNode: {
    readonly declaredPin: string | null;
    readonly executedVersion: string | null;
    readonly executedAbi: string | null;
  } | null;
}

/** The whole-run evidence record — `evidence.json`'s shape. */
export interface QualificationEvidence {
  readonly schema: 1;
  readonly harness: 'astroix-packaged-qualification';
  readonly lane: 'L1 packaged qualification (#258)';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly arguments: {
    readonly artifact: string;
    readonly expectedSha256: string;
    readonly evidenceDir: string;
    readonly settleMs: number;
    readonly quitTimeoutMs: number;
  };
  readonly host: HostFacts | null;
  readonly artifact: ArtifactFacts;
  readonly stages: QualificationStageRecord[];
  readonly verdict: { readonly ok: boolean; readonly failures: readonly string[] } | null;
}

/** The files a complete evidence directory holds. */
export const EVIDENCE_FILES = [
  'evidence.json',
  'verification.txt',
  'process-audit.json',
  'run.log',
] as const;

/**
 * Raised for evidence-directory misuse (a non-empty supplied directory):
 * a usage error, the CLI's exit-2 class (review round 1 on #373 — it
 * must surface as the documented usage exit, never an unhandled
 * rejection).
 */
export class EvidenceDirRefusedError extends Error {}

/** Prepares the evidence directory: absent or empty, then created. Rejects anything else. */
export async function prepareEvidenceDir(dir: string): Promise<void> {
  if (existsSync(dir)) {
    const entries = await readdir(dir);
    if (entries.length > 0) {
      throw new EvidenceDirRefusedError(
        `qualification: the evidence directory ${dir} is not empty — a recorded run is never silently discarded (pass a fresh directory)`,
      );
    }
    return;
  }
  await mkdir(dir, { recursive: true });
}

/**
 * The incremental evidence writer. Every mutation rewrites
 * `evidence.json` (small, deterministic key order) and appends to
 * `run.log`, so an interrupted run still leaves the record it earned.
 */
export class EvidenceRecorder {
  private readonly dir: string;
  private readonly record: QualificationEvidence;
  private readonly runLog: string[] = [];

  constructor(dir: string, args: QualificationEvidence['arguments']) {
    this.dir = dir;
    this.record = {
      schema: 1,
      harness: 'astroix-packaged-qualification',
      lane: 'L1 packaged qualification (#258)',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      arguments: args,
      host: null,
      artifact: {
        zipPath: args.artifact,
        zipBytes: null,
        zipSha256Actual: null,
        zipSha256Expected: args.expectedSha256,
        sha256Match: null,
        zipStructuralTest: null,
        extractedAppPath: null,
        stagingRoot: null,
        bundledNode: null,
      },
      stages: [],
      verdict: null,
    };
  }

  /** One run-log line (also echoed by the CLI's stdout). */
  async log(line: string): Promise<void> {
    this.runLog.push(line);
    await writeFile(join(this.dir, 'run.log'), `${this.runLog.join('\n')}\n`);
  }

  /** Records the host facts section. */
  async recordHostFacts(host: HostFacts): Promise<void> {
    (this.record as { host: HostFacts | null }).host = host;
    await this.flush();
  }

  /** Patches artifact facts (a shallow merge over the recorded ones). */
  async patchArtifactFacts(patch: Partial<ArtifactFacts>): Promise<void> {
    const merged = { ...this.record.artifact, ...patch };
    (this.record as { artifact: ArtifactFacts }).artifact = merged;
    await this.flush();
  }

  /** Records one stage verdict. */
  async recordStage(record: QualificationStageRecord): Promise<void> {
    const existing = this.record.stages.filter((stage) => stage.name !== record.name);
    existing.push(record);
    existing.sort(
      (a, b) =>
        QUALIFICATION_STAGES.indexOf(a.name) - QUALIFICATION_STAGES.indexOf(b.name) ||
        (a.name < b.name ? -1 : 1),
    );
    (this.record as { stages: QualificationStageRecord[] }).stages = existing;
    await this.flush();
  }

  /** Writes the verification battery's report text (if absent, the skip note fills the file). */
  async writeVerificationReport(text: string): Promise<void> {
    await writeFile(join(this.dir, 'verification.txt'), text);
  }

  /** Writes the process stage's audit record. */
  async writeProcessAudit(record: unknown): Promise<void> {
    await writeFile(join(this.dir, 'process-audit.json'), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Fills any evidence file a run's early failure left unwritten with an
   * honest skip note — completeness is judged over FILES, and a skipped
   * stage still owes its file (a missing report is a missing evidence
   * file, never a silent gap).
   */
  async ensureFiles(): Promise<void> {
    const verification = join(this.dir, 'verification.txt');
    if (!existsSync(verification)) {
      const skipped = this.record.stages
        .filter((stage) => stage.status === 'skipped')
        .map((stage) => `${stage.name}: ${stage.summary}`);
      await writeFile(
        verification,
        `verification battery not run — no extracted artifact to verify\n${skipped.join('\n')}\n`,
      );
    }
    const processAudit = join(this.dir, 'process-audit.json');
    if (!existsSync(processAudit)) {
      await writeFile(processAudit, `${JSON.stringify({ run: false }, null, 2)}\n`);
    }
    if (this.runLog.length === 0) {
      await writeFile(join(this.dir, 'run.log'), '(no stage output)\n');
    }
  }

  /** Marks stages that never ran (a failed stage's dependents). */
  async skipStages(names: readonly QualificationStageName[], reason: string): Promise<void> {
    for (const name of names) {
      if (this.record.stages.some((stage) => stage.name === name)) continue;
      await this.recordStage({ name, status: 'skipped', summary: reason });
    }
  }

  /** Seals the record with the final verdict. */
  async finish(ok: boolean, failures: readonly string[]): Promise<void> {
    (this.record as { finishedAt: string | null }).finishedAt = new Date().toISOString();
    (this.record as { verdict: QualificationEvidence['verdict'] }).verdict = { ok, failures };
    await this.flush();
  }

  /** The current record (a deep-frozen snapshot is unnecessary — the writer is single-owner). */
  get current(): QualificationEvidence {
    return this.record;
  }

  get directory(): string {
    return this.dir;
  }

  private async flush(): Promise<void> {
    await writeFile(join(this.dir, 'evidence.json'), `${JSON.stringify(this.record, null, 2)}\n`);
  }
}

/** The completeness verdict — every problem named, never a bare boolean. */
export interface EvidenceCompleteness {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The fail-closed evidence check (#258 AC: "fails closed on missing
 * evidence"): re-reads the evidence directory FROM DISK — every
 * expected file present and non-empty, `evidence.json` parsing as this
 * schema with a record for every stage and a sealed verdict. What the
 * harness wrote, not what it remembers writing.
 */
export async function checkEvidenceCompleteness(dir: string): Promise<EvidenceCompleteness> {
  const problems: string[] = [];
  for (const name of EVIDENCE_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`missing evidence file ${name}`);
      continue;
    }
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength === 0) problems.push(`empty evidence file ${name}`);
    } catch {
      problems.push(`unreadable evidence file ${name}`);
    }
  }
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'evidence.json'), 'utf8')) as {
      schema?: unknown;
      stages?: unknown;
      verdict?: unknown;
    };
    if (parsed.schema !== 1) problems.push('evidence.json is not schema 1');
    const stages = Array.isArray(parsed.stages) ? (parsed.stages as { name?: unknown }[]) : [];
    const recorded = new Set(stages.map((stage) => stage.name));
    for (const stage of QUALIFICATION_STAGES) {
      // the self-stage's record IS its verdict over the files — it is
      // written after they are final, so requiring it here would be a
      // self-reference with no honest order
      if (stage === 'evidence-completeness') continue;
      if (!recorded.has(stage)) problems.push(`evidence.json carries no record for stage ${stage}`);
    }
    if (parsed.verdict === null || parsed.verdict === undefined) {
      problems.push('evidence.json carries no sealed verdict');
    }
  } catch {
    problems.push('evidence.json does not parse');
  }
  return { ok: problems.length === 0, problems };
}
