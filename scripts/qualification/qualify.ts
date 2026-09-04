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
  const skipStages = async (
    names: Parameters<EvidenceRecorder['skipStages']>[0],
    reason: string,
  ) => {
    await recorder.skipStages(names, reason);
    log(`qualification: skipped ${names.join(', ')} — ${reason}`);
  };

  try {
    await recorder.recordHostFacts(await captureHostFacts());
    const stagingRoot = await mkdtemp(join(tmpdir(), 'astroix-qualification-'));
    await recorder.patchArtifactFacts({ stagingRoot });
    try {
      // ——— intake: checksum, structural integrity, extraction + shape ———
      const checksum = await checksumArtifact(args.artifact, args.expectedSha256);
      await recorder.patchArtifactFacts({
        zipBytes: checksum.bytes,
        zipSha256Actual: checksum.sha256,
        sha256Match: checksum.ok,
      });
      const checksumOk = await stage({
        name: 'artifact-checksum',
        status: checksum.ok ? 'passed' : 'failed',
        summary: checksum.ok
          ? `sha256 ${String(checksum.sha256).slice(0, 16)}… matches the expected checksum (${String(checksum.bytes)} bytes)`
          : `rejected ${String(checksum.rejection?.code)}`,
        detail: checksum.rejection ?? null,
      });
      if (!checksumOk) {
        await skipStages(
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
          : await stage({
              name: 'zip-integrity',
              status: integrity.ok ? 'passed' : 'failed',
              summary: integrity.ok
                ? 'the archive CRCs hold (zip -T)'
                : `rejected ${String(integrity.rejection?.code)}`,
              detail: integrity.rejection ?? null,
            });
      if (checksumOk && !integrityOk) {
        await skipStages(
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
          zipStructuralTest: integrity.ok ? 'passed' : 'failed',
        });
      }
      if (extraction?.facts !== undefined) {
        await recorder.patchArtifactFacts({ extractedAppPath: extraction.facts.extractedAppPath });
      }
      const extractionOk =
        extraction === null
          ? false
          : await stage({
              name: 'extraction',
              status: extraction.ok ? 'passed' : 'failed',
              summary: extraction.ok
                ? `extracted to exactly one ${PRODUCT_NAME}.app with its executable`
                : `rejected ${String(extraction.rejection?.code)}`,
              detail: extraction.rejection ?? null,
            });
      if (!extractionOk) {
        await skipStages(
          [
            'verification-battery',
            'bundled-node-identity',
            'launch',
            'termination',
            'residual-owned-processes',
          ],
          'intake rejected the artifact',
        );
      } else {
        const appPath = extraction?.facts?.extractedAppPath as string;

        // ——— the verification battery + bundled-Node identity ———
        const battery = options.seams?.battery ?? runVerificationBattery;
        const outcome = await battery(appPath);
        await recorder.writeVerificationReport(`${outcome.lines.join('\n')}\n`);
        await recorder.patchArtifactFacts({
          bundledNode: {
            declaredPin: outcome.nodeIdentity.declaredPin,
            executedVersion: outcome.nodeIdentity.executedVersion,
            executedAbi: outcome.nodeIdentity.executedAbi,
          },
        });
        const batteryOk = await stage({
          name: 'verification-battery',
          status: outcome.verification.ok ? 'passed' : 'failed',
          summary: outcome.verification.ok
            ? 'codesign (strict, adhoc) + resources + fuses + identity + arch all hold'
            : 'the packaged-app verification rejected the artifact',
          detail: {
            codesignOk: outcome.verification.codesign.ok,
            assetsOk: outcome.verification.assets.ok,
            fusesOk: outcome.verification.fuses.ok,
            plistOk: outcome.verification.plist.ok,
            archOk: outcome.verification.arch.ok,
            assetsDetail: outcome.verification.assets.detail,
            fusesDetail: outcome.verification.fuses.detail,
          },
        });
        const nodeOk = await stage({
          name: 'bundled-node-identity',
          status: outcome.nodeIdentity.ok ? 'passed' : 'failed',
          summary: outcome.nodeIdentity.ok
            ? `the bundled Node reports ${String(outcome.nodeIdentity.executedVersion)} (ABI ${String(outcome.nodeIdentity.executedAbi)}) — the declared and pinned identity`
            : `rejected ${String(outcome.nodeIdentity.failure)} (declared ${String(outcome.nodeIdentity.declaredPin)}, executed ${String(outcome.nodeIdentity.executedVersion)}, pin ${outcome.expectedNodePin})`,
          detail: outcome.nodeIdentity,
        });
        if (!batteryOk || !nodeOk) {
          await skipStages(
            ['launch', 'termination', 'residual-owned-processes'],
            'the verification battery rejected the artifact',
          );
        } else {
          // ——— launch, terminate, audit ———
          const launcher = options.seams?.launcher ?? launchTerminateAndAudit;
          const verdicts = await launcher({
            appPath,
            executableName: PRODUCT_NAME,
            bundleId: PRODUCT_BUNDLE_ID,
            stagingRoot,
            settleMs: args.settleMs,
            quitTimeoutMs: args.quitTimeoutMs,
            quitMode: options.quitMode ?? 'apple-event',
          });
          await recorder.writeProcessAudit(verdicts.record);
          await stage({
            name: 'launch',
            status: verdicts.launchOk ? 'passed' : 'failed',
            summary: verdicts.launchOk
              ? `pid ${String(verdicts.record.pid)} stayed alive through ${String(args.settleMs)} ms; ${verdicts.record.treeAtSettle.length} owned process(es) observed`
              : `the app did not stay up (${String(verdicts.record.spawnError ?? 'exited during settle')})`,
            detail: {
              settle: verdicts.record.settle,
              treeAtSettle: verdicts.record.treeAtSettle,
              listeningSockets: verdicts.record.listeningSockets,
              earlyStderr: verdicts.record.stderrTail.slice(-10),
            },
          });
          await stage({
            name: 'termination',
            status: verdicts.terminationOk ? 'passed' : 'failed',
            summary: `${verdicts.record.termination.outcome} (exit ${String(verdicts.record.termination.exitCode)}, signal ${String(verdicts.record.termination.signal)})`,
            detail: verdicts.record.termination,
          });
          await stage({
            name: 'residual-owned-processes',
            status: verdicts.residualOk ? 'passed' : 'failed',
            summary: verdicts.residualOk
              ? 'no owned process survived termination'
              : `${verdicts.record.residualAudit.residuals.length} owned process(es) survived; the harness killed ${verdicts.record.residualAudit.harnessKilled.join(', ') || 'none'}`,
            detail: verdicts.record.residualAudit,
          });
        }
      }
    } finally {
      // ——— staging cleanup: owed on every path ———
      const removed = await rm(stagingRoot, { recursive: true, force: true })
        .then(() => true)
        .catch(() => false);
      await stage({
        name: 'staging-cleanup',
        status: removed ? 'passed' : 'failed',
        summary: removed
          ? `staging root ${stagingRoot} removed`
          : `staging root ${stagingRoot} could not be removed`,
      });
    }
  } catch (error) {
    // an unexpected harness error is a failed run, never a crash that
    // leaves no record — everything below still writes the evidence
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`harness-error: ${message}`);
    log(`qualification: harness error — ${message}`);
    await recorder.log(`qualification: harness error — ${message}`).catch(() => undefined);
  }

  // ——— the evidence completeness check: the last word, fail-closed ———
  await recorder.ensureFiles();
  await recorder.finish(failures.length === 0, failures);
  const completeness = await checkEvidenceCompleteness(args.evidenceDir);
  await recorder.recordStage({
    name: 'evidence-completeness',
    status: completeness.ok ? 'passed' : 'failed',
    summary: completeness.ok
      ? 'every evidence file present and non-empty; every stage recorded'
      : completeness.problems.join('; '),
    detail: completeness.problems,
  });
  const finalFailures = completeness.ok ? failures : [...failures, ...completeness.problems];
  await recorder.finish(finalFailures.length === 0, finalFailures);
  log(
    `qualification: verdict ${finalFailures.length === 0 ? 'PASSED' : 'FAILED'} — evidence at ${args.evidenceDir}`,
  );
  await recorder
    .log(`qualification: verdict ${finalFailures.length === 0 ? 'PASSED' : 'FAILED'}`)
    .catch(() => undefined);
  return { ok: finalFailures.length === 0, failures: finalFailures, evidenceDir: args.evidenceDir };
}
