import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_BUNDLE_ID, PRODUCT_NAME } from '../../apps/desktop/src/forge/product.ts';
import type { QualificationArguments } from './args.ts';
import { checksumArtifact, extractAndShape, testZipIntegrity } from './artifact.ts';
import type { BatteryOutcome } from './battery.ts';
import { runVerificationBattery } from './battery.ts';
import {
  checkEvidenceCompleteness,
  EvidenceRecorder,
  prepareEvidenceDir,
  type QualificationStageName,
  type QualificationStageRecord,
} from './evidence.ts';
import { captureHostFacts } from './host-facts.ts';
import type { ProcessStageInput, ProcessStageVerdicts } from './process-stage.ts';
import { launchTerminateAndAudit } from './process-stage.ts';

/**
 * The qualification orchestrator (#258, L1): one fail-closed pass over
 * a SUPPLIED artifact — checksum, structural integrity, extraction and
 * shape, the H3 verification battery plus the bundled-Node identity,
 * launch/terminate with the owned-process audit, staging cleanup, and
 * the evidence completeness check. Every stage records its verdict
 * incrementally; a failed stage skips its dependents but never skips
 * the cleanup or the evidence — the run's exit is the conjunction of
 * every recorded verdict, and an unexpected harness error is recorded
 * and fails closed the same way.
 *
 * The battery and launcher seams follow the E8 declared-seam precedent:
 * the deterministic tests inject them (a synthetic artifact cannot
 * carry real signatures), while every real run — including the
 * exact-H6-artifact leg — uses the defaults.
 */

/** The seams the deterministic tests inject; real runs use the defaults. */
export interface QualificationSeams {
  readonly battery?: (appPath: string) => Promise<BatteryOutcome>;
  readonly launcher?: (input: ProcessStageInput) => Promise<ProcessStageVerdicts>;
}

export interface QualificationOptions {
  readonly args: QualificationArguments;
  /** `apple-event` (the default, for real packaged apps) or `signal-only` (stubs). */
  readonly quitMode?: 'apple-event' | 'signal-only';
  readonly seams?: QualificationSeams;
  /** Progress sink (the CLI echoes to stdout; tests capture). */
  readonly onLog?: (line: string) => void;
}

export interface QualificationResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly evidenceDir: string;
}

/**
 * The recording port the phase runners share: one stage-record call
 * (which ledgeres failures and echoes the log line) and one skip call
 * (which records the dependents a failed stage owed nothing to).
 */
interface StagePort {
  readonly stage: (record: QualificationStageRecord) => Promise<boolean>;
  readonly skip: (names: readonly QualificationStageName[], reason: string) => Promise<void>;
}

/** Runs one complete qualification pass. Artifact failures are recorded, never thrown. */
export async function runQualification(
  options: QualificationOptions,
): Promise<QualificationResult> {
  const { args } = options;
  const log = (line: string): void => {
    options.onLog?.(line);
  };
  await prepareEvidenceDir(args.evidenceDir);
  const recorder = new EvidenceRecorder(args.evidenceDir, {
    artifact: args.artifact,
    expectedSha256: args.expectedSha256,
    evidenceDir: args.evidenceDir,
    settleMs: args.settleMs,
    quitTimeoutMs: args.quitTimeoutMs,
  });
  const failures: string[] = [];

  const stage = async (record: QualificationStageRecord): Promise<boolean> => {
    await recorder.recordStage(record);
    log(`qualification: ${record.name} ${record.status.toUpperCase()} — ${record.summary}`);
    if (record.status === 'failed') failures.push(`${record.name}: ${record.summary}`);
    return record.status === 'passed';
  };
  const skip = async (names: readonly QualificationStageName[], reason: string) => {
    await recorder.skipStages(names, reason);
    log(`qualification: skipped ${names.join(', ')} — ${reason}`);
  };
  const port: StagePort = { stage, skip };

  try {
    await recorder.recordHostFacts(await captureHostFacts());
    const stagingRoot = await mkdtemp(join(tmpdir(), 'astroix-qualification-'));
    await recorder.patchArtifactFacts({ stagingRoot });
    try {
      // ——— intake, then the phases it earned ———
      const appPath = await runIntakeStages(port, recorder, args, stagingRoot);
      if (appPath !== null) {
        const battery = options.seams?.battery ?? runVerificationBattery;
        const launchReady = await runVerificationStages(port, recorder, appPath, battery);
        if (launchReady) {
          const launcher = options.seams?.launcher ?? launchTerminateAndAudit;
          await runProcessStages(
            port,
            recorder,
            args,
            launcher,
            appPath,
            stagingRoot,
            options.quitMode ?? 'apple-event',
          );
        } else {
          await skip(
            ['launch', 'termination', 'residual-owned-processes'],
            'the verification battery rejected the artifact',
          );
        }
      }
    } finally {
      // ——— staging cleanup: owed on every path ———
      await runStagingCleanup(port, stagingRoot);
    }
  } catch (error) {
    // an unexpected harness error is a failed run, never a crash that
    // leaves no record — everything below still writes the evidence
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`harness-error: ${message}`);
    log(`qualification: harness error — ${message}`);
    await recorder.log(`qualification: harness error — ${message}`).catch(() => undefined);
  }

  const finalFailures = await completeEvidence(recorder, args.evidenceDir, failures, log);
  return { ok: finalFailures.length === 0, failures: finalFailures, evidenceDir: args.evidenceDir };
}

// ——— the stage-record builders and phase runners ———

/** The pass/fail status word — the one verdict vocabulary every stage shares. */
function statusText(ok: boolean): 'passed' | 'failed' {
  return ok ? 'passed' : 'failed';
}

/**
 * One pass/fail stage record — the summary pair keyed by the verdict.
 * A `detail` that is `undefined` stays absent from the record, exactly
 * as the stage's own law states it.
 */
function passFailStage(
  name: QualificationStageName,
  ok: boolean,
  passedSummary: string,
  failedSummary: string,
  detail?: unknown,
): QualificationStageRecord {
  return {
    name,
    status: statusText(ok),
    summary: ok ? passedSummary : failedSummary,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * The intake phases: checksum, structural integrity, extraction — each
 * stage recorded, each failure skipping its dependents with its own
 * reason. Returns the extracted app path, or null when the artifact
 * never earned the verification phases.
 */
async function runIntakeStages(
  port: StagePort,
  recorder: EvidenceRecorder,
  args: QualificationArguments,
  stagingRoot: string,
): Promise<string | null> {
  // ——— intake: checksum, structural integrity, extraction + shape ———
  const checksum = await checksumArtifact(args.artifact, args.expectedSha256);
  await recorder.patchArtifactFacts({
    zipBytes: checksum.bytes,
    zipSha256Actual: checksum.sha256,
    sha256Match: checksum.ok,
  });
  const checksumOk = await port.stage(
    passFailStage(
      'artifact-checksum',
      checksum.ok,
      `sha256 ${String(checksum.sha256).slice(0, 16)}… matches the expected checksum (${String(checksum.bytes)} bytes)`,
      `rejected ${String(checksum.rejection?.code)}`,
      checksum.rejection ?? null,
    ),
  );
  if (!checksumOk) {
    await port.skip(
      [
        'zip-integrity',
        'extraction',
        'verification-battery',
        'bundled-node-identity',
        'launch',
        'termination',
        'residual-owned-processes',
      ],
      'intake rejected the artifact',
    );
  }
  const integrity = checksumOk ? await testZipIntegrity(args.artifact) : null;
  const integrityOk =
    integrity === null
      ? false
      : await port.stage(
          passFailStage(
            'zip-integrity',
            integrity.ok,
            'the archive CRCs hold (zip -T)',
            `rejected ${String(integrity.rejection?.code)}`,
            integrity.rejection ?? null,
          ),
        );
  if (checksumOk && !integrityOk) {
    await port.skip(
      [
        'extraction',
        'verification-battery',
        'bundled-node-identity',
        'launch',
        'termination',
        'residual-owned-processes',
      ],
      'the archive is structurally invalid',
    );
  }
  const extraction =
    integrityOk === true ? await extractAndShape(args.artifact, stagingRoot) : null;
  if (integrity !== null) {
    await recorder.patchArtifactFacts({
      zipStructuralTest: statusText(integrity.ok),
    });
  }
  if (extraction?.facts !== undefined) {
    await recorder.patchArtifactFacts({ extractedAppPath: extraction.facts.extractedAppPath });
  }
  const extractionOk =
    extraction === null
      ? false
      : await port.stage(
          passFailStage(
            'extraction',
            extraction.ok,
            `extracted to exactly one ${PRODUCT_NAME}.app with its executable`,
            `rejected ${String(extraction.rejection?.code)}`,
            extraction.rejection ?? null,
          ),
        );
  if (!extractionOk) {
    await port.skip(
      [
        'verification-battery',
        'bundled-node-identity',
        'launch',
        'termination',
        'residual-owned-processes',
      ],
      'intake rejected the artifact',
    );
    return null;
  }
  return extraction?.facts?.extractedAppPath as string;
}

/**
 * The verification phases: the packaged-app battery plus the
 * bundled-Node identity, both recorded off one battery outcome.
 * Returns whether the launch phases may run.
 */
async function runVerificationStages(
  port: StagePort,
  recorder: EvidenceRecorder,
  appPath: string,
  battery: (appPath: string) => Promise<BatteryOutcome>,
): Promise<boolean> {
  const outcome = await battery(appPath);
  await recorder.writeVerificationReport(`${outcome.lines.join('\n')}\n`);
  await recorder.patchArtifactFacts({
    bundledNode: {
      declaredPin: outcome.nodeIdentity.declaredPin,
      executedVersion: outcome.nodeIdentity.executedVersion,
      executedAbi: outcome.nodeIdentity.executedAbi,
    },
  });
  const batteryOk = await port.stage(
    passFailStage(
      'verification-battery',
      outcome.verification.ok,
      'codesign (strict, adhoc) + resources + fuses + identity + arch all hold',
      'the packaged-app verification rejected the artifact',
      {
        codesignOk: outcome.verification.codesign.ok,
        assetsOk: outcome.verification.assets.ok,
        fusesOk: outcome.verification.fuses.ok,
        plistOk: outcome.verification.plist.ok,
        archOk: outcome.verification.arch.ok,
        assetsDetail: outcome.verification.assets.detail,
        fusesDetail: outcome.verification.fuses.detail,
      },
    ),
  );
  const nodeOk = await port.stage(
    passFailStage(
      'bundled-node-identity',
      outcome.nodeIdentity.ok,
      `the bundled Node reports ${String(outcome.nodeIdentity.executedVersion)} (ABI ${String(outcome.nodeIdentity.executedAbi)}) — the declared and pinned identity`,
      `rejected ${String(outcome.nodeIdentity.failure)} (declared ${String(outcome.nodeIdentity.declaredPin)}, executed ${String(outcome.nodeIdentity.executedVersion)}, pin ${outcome.expectedNodePin})`,
      outcome.nodeIdentity,
    ),
  );
  return batteryOk && nodeOk;
}

/**
 * The launch phases: one launcher pass — launch, terminate, and the
 * owned-process audit — recorded as the three stage verdicts.
 */
async function runProcessStages(
  port: StagePort,
  recorder: EvidenceRecorder,
  args: QualificationArguments,
  launcher: (input: ProcessStageInput) => Promise<ProcessStageVerdicts>,
  appPath: string,
  stagingRoot: string,
  quitMode: 'apple-event' | 'signal-only',
): Promise<void> {
  const verdicts = await launcher({
    appPath,
    executableName: PRODUCT_NAME,
    bundleId: PRODUCT_BUNDLE_ID,
    stagingRoot,
    settleMs: args.settleMs,
    quitTimeoutMs: args.quitTimeoutMs,
    quitMode,
  });
  await recorder.writeProcessAudit(verdicts.record);
  await port.stage(
    passFailStage(
      'launch',
      verdicts.launchOk,
      `pid ${String(verdicts.record.pid)} stayed alive through ${String(args.settleMs)} ms; ${verdicts.record.treeAtSettle.length} owned process(es) observed`,
      `the app did not stay up (${String(verdicts.record.spawnError ?? 'exited during settle')})`,
      {
        settle: verdicts.record.settle,
        treeAtSettle: verdicts.record.treeAtSettle,
        listeningSockets: verdicts.record.listeningSockets,
        earlyStderr: verdicts.record.stderrTail.slice(-10),
      },
    ),
  );
  const terminationSummary = `${verdicts.record.termination.outcome} (exit ${String(verdicts.record.termination.exitCode)}, signal ${String(verdicts.record.termination.signal)})`;
  await port.stage(
    passFailStage(
      'termination',
      verdicts.terminationOk,
      terminationSummary,
      terminationSummary,
      verdicts.record.termination,
    ),
  );
  await port.stage(
    passFailStage(
      'residual-owned-processes',
      verdicts.residualOk,
      'no owned process survived termination',
      `${verdicts.record.residualAudit.residuals.length} owned process(es) survived; the harness killed ${verdicts.record.residualAudit.harnessKilled.join(', ') || 'none'}`,
      verdicts.record.residualAudit,
    ),
  );
}

/** The always-owed staging cleanup — recorded on every path, never skipped. */
async function runStagingCleanup(port: StagePort, stagingRoot: string): Promise<void> {
  const removed = await rm(stagingRoot, { recursive: true, force: true })
    .then(() => true)
    .catch(() => false);
  await port.stage(
    passFailStage(
      'staging-cleanup',
      removed,
      `staging root ${stagingRoot} removed`,
      `staging root ${stagingRoot} could not be removed`,
    ),
  );
}

/**
 * The evidence completeness check — the last word, fail-closed: the
 * record is sealed, re-read from disk, self-verdicted, and re-sealed
 * over the final failure list. Returns that list.
 */
async function completeEvidence(
  recorder: EvidenceRecorder,
  evidenceDir: string,
  failures: readonly string[],
  log: (line: string) => void,
): Promise<readonly string[]> {
  await recorder.ensureFiles();
  await recorder.finish(failures.length === 0, failures);
  const completeness = await checkEvidenceCompleteness(evidenceDir);
  await recorder.recordStage(
    passFailStage(
      'evidence-completeness',
      completeness.ok,
      'every evidence file present and non-empty; every stage recorded',
      completeness.problems.join('; '),
      completeness.problems,
    ),
  );
  const finalFailures = completeness.ok ? failures : [...failures, ...completeness.problems];
  await recorder.finish(finalFailures.length === 0, finalFailures);
  log(
    `qualification: verdict ${finalFailures.length === 0 ? 'PASSED' : 'FAILED'} — evidence at ${evidenceDir}`,
  );
  await recorder
    .log(`qualification: verdict ${finalFailures.length === 0 ? 'PASSED' : 'FAILED'}`)
    .catch(() => undefined);
  return finalFailures;
}
