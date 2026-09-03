import { sessionFailureSchema } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  type WriteOutcome,
  writeFailure,
  writeRejection,
} from '../../edit-authority/executor/write-outcomes.ts';
import { sha256Hex } from '../../edit-authority/grants/canonical-bounds.ts';
import {
  classifyWriteOutcome,
  failedDrainFailure,
  timedOutDrainFailure,
} from '../../session-supervisor/fence/drain-report.ts';
import { FAILURE_MESSAGES } from '../../session-supervisor/staging/activation-attempt.ts';

/**
 * The #237 focused tests, part 2 — the drain vocabulary as data: the
 * complete classification table over the executor's closed outcome
 * surface (every rejection code, every IO failure, committed, unknown),
 * the two `SessionFailure` builders (schema-valid, staging's fixed
 * templates), and the fail-closed default a new executor code falls
 * into. A row moving here moves deliberately — the enumeration is the
 * contract.
 */

/** The full rejection-code enumeration — pinned so a new D5 code lands in a classified place. */
const REJECTION_CODES = [
  'cross-session',
  'wrong-root',
  'operation-not-allowed',
  'operation-target-mismatch',
  'target-moved',
  'target-absent',
  'parent-absent',
  'parent-not-directory',
  'not-a-file',
  'hard-linked-target',
  'changed-baseline',
  'target-exists',
  'range-outside-baseline',
  'fenced',
  'malformed-plan',
] as const;

const FAILURE_CODES = ['read-failed', 'write-failed', 'replace-failed', 'create-failed'] as const;

describe('classifyWriteOutcome — the complete drain table', () => {
  it('a committed write is success', () => {
    const committed: WriteOutcome = {
      type: 'committed',
      revision: sha256Hex(new TextEncoder().encode('landed')),
    };
    expect(classifyWriteOutcome(committed)).toBe('success');
  });

  it('exactly the revision-contract pair is conflict — expected SHA-256 and expected-absent', () => {
    expect(classifyWriteOutcome(writeRejection('changed-baseline'))).toBe('conflict');
    expect(classifyWriteOutcome(writeRejection('target-exists'))).toBe('conflict');
  });

  it('every other rejection code reads failure — the fail-closed default for codes not yet ruled', () => {
    for (const code of REJECTION_CODES) {
      if (code === 'changed-baseline' || code === 'target-exists') continue;
      expect(classifyWriteOutcome(writeRejection(code))).toBe('failure');
    }
  });

  it('every IO failure code reads failure', () => {
    for (const code of FAILURE_CODES) {
      expect(classifyWriteOutcome(writeFailure(code))).toBe('failure');
    }
  });

  it('the honest unknown of a forced exit reads failure — it can never prove a clean drain', () => {
    expect(classifyWriteOutcome({ type: 'unknown' })).toBe('failure');
  });
});

describe('the drain failure builders — protocol-valid, staging-templated', () => {
  it('a failed drain records category drain-conflict with staging’s fixed template', () => {
    const failure = failedDrainFailure();
    expect(failure).toEqual({
      category: 'drain-conflict',
      message: FAILURE_MESSAGES['drain-conflict'],
    });
    expect(sessionFailureSchema.parse(failure)).toEqual(failure);
  });

  it('a timed-out drain records category drain-timeout with staging’s fixed template', () => {
    const failure = timedOutDrainFailure();
    expect(failure).toEqual({
      category: 'drain-timeout',
      message: FAILURE_MESSAGES['drain-timeout'],
    });
    expect(sessionFailureSchema.parse(failure)).toEqual(failure);
  });
});
