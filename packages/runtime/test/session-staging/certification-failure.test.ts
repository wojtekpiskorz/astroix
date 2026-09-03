import {
  type SessionFailure,
  sanitizedTextSchema,
  sessionLabel,
  sessionSnapshotSchema,
  withinByteLimit,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type CertificationFacts,
  ProjectRunBootError,
  type ProjectRunBootErrorCode,
} from '../../project-runtime/project-runtime.ts';
import {
  type ActivationAttempt,
  ActivationFailedError,
  createSessionSupervisor,
  FAILURE_MESSAGES,
  type SessionSupervisor,
} from '../../session-supervisor/staging/session-supervisor.ts';
import {
  type CandidateRuntimeControl,
  candidateRuntime,
  PROJECT_A,
  rejectionOf,
} from './staging-harness.ts';

/**
 * The #319 focused tests — the certification failure category: the boot
 * vocabulary addition that made the protocol's `certification` category
 * reachable (previously an uncertified Astro/Vite pair folded into
 * `startup`/crash readings while ADR-0005's compatibility contract
 * requires reporting the detected pair, the certified pairs, and the
 * rejected contract). These legs drive the category through the staged
 * activation's readiness failure: the enriched message, every other
 * boot code's unchanged mapping, and the protocol-law belts that bound
 * the enrichment.
 */

/** One drift pair no release ever certified. */
const DRIFT = { astro: '7.3.0', vite: '8.3.0' } as const;
/** ADR-0005's rejected contract, the adapter's own wording. */
const CONTRACT = 'exact Astro/Vite pair certification must pass before project config executes';

interface Fixture {
  readonly supervisor: SessionSupervisor;
  readonly control: CandidateRuntimeControl;
}

function fixture(): Fixture {
  const control = candidateRuntime();
  const supervisor = createSessionSupervisor({
    startCandidate: control.startCandidate,
    runtimeEpoch: 'epoch-319',
  });
  return { supervisor, control };
}

/** The begun attempt, or a thrown expectation when it was refused. */
function begunOf(result: ReturnType<SessionSupervisor['begin']>): ActivationAttempt {
  if (result.kind !== 'begun')
    throw new Error(`expected the attempt to be admitted: ${result.reason}`);
  return result.attempt;
}

/** The run the nth launch (1-based generation) handed back. */
function runOf(control: CandidateRuntimeControl, generation: number) {
  const run = control.runs[generation - 1];
  if (run === undefined) throw new Error(`no fake run for generation ${generation}`);
  return run;
}

describe('the certification failure category — reachable, enriched, bounded (#319)', () => {
  function driftFacts(): CertificationFacts {
    return {
      detected: { astro: DRIFT.astro, vite: DRIFT.vite },
      certified: [{ astro: '7.2.10', vite: '8.2.2' }],
      rejectedContract: CONTRACT,
    };
  }

  it("an uncertified pair reports the certification category with the detected pair, certified pairs, and rejected contract (ADR-0005's report requirement)", async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReadyUncertifiedPair(driftFacts());

    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    // The certification category — not startup, not crash, not unknown:
    // the previously unreachable category is the one this path reports.
    expect(error.failure.category).toBe('certification');
    expect(error.failure.category).not.toBe('startup');
    expect(error.failure.category).not.toBe('crash');
    // ADR-0005's three facts ride the message.
    expect(error.message).toContain(
      'the managed project did not carry a certified Astro and Vite pair',
    );
    expect(error.message).toContain('detected astro@7.3.0 + vite@8.3.0');
    expect(error.message).toContain('certified pairs: astro@7.2.10 + vite@8.2.2');
    expect(error.message).toContain(`rejected contract: ${CONTRACT}`);
    // The protocol's own laws pin the enriched message: a lawful public
    // text within the lifecycle byte budget the snapshot rides in.
    expect(sanitizedTextSchema.safeParse(error.failure.message).success).toBe(true);
    expect(withinByteLimit(error.failure.message, 'lifecycleJsonBytes')).toBe(true);

    await attempt.closed;
    const snapshot = supervisor.snapshot();
    expect(snapshot.lastFailure).toEqual({ category: 'certification', message: error.message });
    expect(sessionSnapshotSchema.parse(snapshot)).toBeTruthy();
    expect(sessionLabel(snapshot)).toBe('failed');
  });

  it('every other boot code still maps unchanged — the existing categories keep their readings', async () => {
    const { supervisor, control } = fixture();
    const expectations: ReadonlyArray<
      [Exclude<ProjectRunBootErrorCode, 'uncertified-pair'>, SessionFailure['category']]
    > = [
      ['cancelled', 'startup'],
      ['startup-timeout', 'startup-timeout'],
      ['worker-crash', 'crash'],
      ['managed-astro-crash', 'crash'],
      ['proxy-health', 'startup'],
      ['launch-failed', 'startup'],
    ];
    let generation = 0;
    for (const [code, category] of expectations) {
      generation += 1;
      const attempt = begunOf(supervisor.begin(PROJECT_A));
      runOf(control, generation).failReady(code);
      await rejectionOf(attempt.ready);
      await attempt.closed;
      const snapshot = supervisor.snapshot();
      expect(snapshot.lastFailure?.category, `the ${code} boot code`).toBe(category);
      expect(snapshot.lastFailure?.message, `the ${code} boot code`).toBe(
        FAILURE_MESSAGES[category],
      );
    }
  });

  it('the enrichment is bounded: an over-budget fact keeps the bare template, never a truncated guess', async () => {
    const { supervisor, control } = fixture();
    // Far over the 64 KiB lifecycle budget the composed message must fit.
    const facts: CertificationFacts = {
      detected: { astro: '7.3.0-'.repeat(20_000), vite: DRIFT.vite },
      certified: [{ astro: '7.2.10', vite: '8.2.2' }],
      rejectedContract: CONTRACT,
    };
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReadyUncertifiedPair(facts);

    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    // The category is the fact; the enrichment that does not fit the
    // budget is dropped whole, never truncated into a guess.
    expect(error.failure.category).toBe('certification');
    expect(error.failure.message).toBe(FAILURE_MESSAGES.certification);
    expect(sanitizedTextSchema.safeParse(error.failure.message).success).toBe(true);
  });

  it('the belt behind the facade admission: a disclosure-shaped fact still reports certification with the bare template', async () => {
    const { supervisor, control } = fixture();
    const facts: CertificationFacts = {
      detected: { astro: '/Users/secret/root-319/astro', vite: DRIFT.vite },
      certified: [{ astro: '7.2.10', vite: '8.2.2' }],
      rejectedContract: CONTRACT,
    };
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    runOf(control, 1).failReadyUncertifiedPair(facts);

    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    expect(error.failure.category).toBe('certification');
    expect(error.failure.message).toBe(FAILURE_MESSAGES.certification);
    expect(error.failure.message).not.toContain('/Users');
  });

  it('the payload-less runtime belt: a certification code without its facts keeps the category and the bare template', async () => {
    const { supervisor, control } = fixture();
    const attempt = begunOf(supervisor.begin(PROJECT_A));
    // Types make a facts-free certification unconstructible (the
    // constructor overloads); the belt pins the runtime behavior for a
    // JS-level caller anyway — the category is code-derived and survives.
    runOf(control, 1).failReadyError(
      new ProjectRunBootError('uncertified-pair', undefined as unknown as CertificationFacts),
    );

    const error = await rejectionOf(attempt.ready);
    if (!(error instanceof ActivationFailedError)) {
      throw new Error('expected ActivationFailedError');
    }
    expect(error.failure.category).toBe('certification');
    expect(error.failure.message).toBe(FAILURE_MESSAGES.certification);
  });
});
