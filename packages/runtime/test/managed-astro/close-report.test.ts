import { describe, expect, it } from 'vitest';
import {
  classifySupervisionClose,
  type SupervisionCloseFacts,
} from '../../project-plane/supervision/close-report.ts';

/**
 * The supervision close-report classifier (#231 focused tests): one
 * recursive report classifies complete or incomplete cleanup from the
 * observed facts — sanitized categories, stop-sequence order, and never
 * a PID (ADR-0006 §8).
 */

const CLEAN: SupervisionCloseFacts = {
  reason: 'stopped',
  workerReportExpected: true,
  workerReportReceived: true,
  workerCleanupComplete: true,
  workerReaped: true,
  managedAstroReaped: true,
  probesSettled: true,
  killEscalations: [],
};

function fact(overrides: Partial<SupervisionCloseFacts>): SupervisionCloseFacts {
  return { ...CLEAN, ...overrides };
}

describe('classifySupervisionClose', () => {
  it('a clean graceful stop is complete with no failures', () => {
    const report = classifySupervisionClose(fact({}));
    expect(report).toEqual({
      reason: 'stopped',
      outcome: 'complete',
      failures: [],
      accounting: {
        workerReportReceived: true,
        workerCleanupComplete: true,
        workerReaped: true,
        managedAstroReaped: true,
        probesSettled: true,
        killEscalations: [],
      },
    });
  });

  it('SIGKILL escalation with a successful reap is still complete — noted, never a failure', () => {
    const report = classifySupervisionClose(fact({ killEscalations: ['managed-astro', 'worker'] }));
    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
    expect(report.accounting.killEscalations).toEqual(['managed-astro', 'worker']);
  });

  it('a missing worker close report fails that category alone', () => {
    const report = classifySupervisionClose(fact({ workerReportReceived: false }));
    expect(report.outcome).toBe('incomplete');
    expect(report.failures).toEqual(['worker-close-report']);
    expect(report.accounting.workerReportReceived).toBe(false);
  });

  it("a crash never expects the worker's report — a dead worker cannot report", () => {
    const report = classifySupervisionClose(
      fact({ reason: 'worker-crash', workerReportExpected: false, workerReportReceived: false }),
    );
    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
  });

  it('a crash-killed worker survivor was never asked — the mirror tick reap expects no report (#402)', () => {
    // The #402 fact shape: the dev server crashed, the worker was
    // SIGKILLed in the terminal transition's own tick (no IPC stop, no
    // TERM rung), so no report can arrive and none is expected — the
    // supervisor denied the window, the worker did not fail inside it.
    // The escalation ledger says the worker died by SIGKILL; the reap
    // and the ledger together stay a complete close.
    const report = classifySupervisionClose(
      fact({
        reason: 'managed-astro-crash',
        workerReportExpected: false,
        workerReportReceived: false,
        killEscalations: ['worker'],
      }),
    );
    expect(report.outcome).toBe('complete');
    expect(report.failures).toEqual([]);
    expect(report.accounting.workerReportReceived).toBe(false);
    expect(report.accounting.killEscalations).toEqual(['worker']);
  });

  it("the worker's own incomplete cleanup is the plane's incomplete cleanup", () => {
    const report = classifySupervisionClose(fact({ workerCleanupComplete: false }));
    expect(report.failures).toEqual(['worker-cleanup-incomplete']);
    expect(report.outcome).toBe('incomplete');
  });

  it('an unreaped child fails its reap category — the honest orphan-recovery limit', () => {
    expect(classifySupervisionClose(fact({ workerReaped: false })).failures).toEqual([
      'worker-reap',
    ]);
    expect(classifySupervisionClose(fact({ managedAstroReaped: false })).failures).toEqual([
      'managed-astro-reap',
    ]);
  });

  it('an unsettled probe fails the sockets category', () => {
    expect(classifySupervisionClose(fact({ probesSettled: false })).failures).toEqual([
      'probe-abort',
    ]);
  });

  it('lists every fired category in stop-sequence order on the worst path', () => {
    const report = classifySupervisionClose(
      fact({
        workerReportReceived: false,
        workerReaped: false,
        managedAstroReaped: false,
        probesSettled: false,
      }),
    );
    expect(report.failures).toEqual([
      'worker-close-report',
      'worker-reap',
      'managed-astro-reap',
      'probe-abort',
    ]);
    expect(report.outcome).toBe('incomplete');
  });

  it('carries no PID anywhere in its serialized shape', () => {
    const report = classifySupervisionClose(
      fact({ workerReportReceived: false, managedAstroReaped: false }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('pid');
    expect(serialized).not.toContain('Pid');
  });

  it('never treats a received report as missing, however expected', () => {
    // Expected-but-missing and received-but-incomplete are exclusive: the
    // classifier reads the observation, not the expectation.
    const report = classifySupervisionClose(
      fact({ workerReportReceived: true, workerCleanupComplete: false }),
    );
    expect(report.failures).toEqual(['worker-cleanup-incomplete']);
  });
});
