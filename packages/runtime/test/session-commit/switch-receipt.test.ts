import { describe, expect, it } from 'vitest';
import {
  createReceiptLedger,
  type ReceiptBindings,
  type SwitchPreparationReceipt,
} from '../../session-supervisor/commit/switch-receipt.ts';
import { EDITOR_DOC, EPOCH, fakeLease } from './commit-harness.ts';

/**
 * The #238 focused tests, part 1 — the receipt currency itself
 * (ADR-0006 §4 step 5 and §9 `PreparedReplacement`): the one-use
 * ledger's mint, its frozen bindings, the single-use flip, and the two
 * sanitized rejections — replay (`already-consumed`) and the never-minted
 * (`unknown-receipt`, the brand's contribution: a structurally identical
 * forged object is not currency).
 */

/** Builds the smallest honest binding set — every field the receipt freezes. */
function bindings(overrides: Partial<ReceiptBindings> = {}): ReceiptBindings {
  const fence = {
    state: 'drained' as const,
    submit: () => ({ kind: 'refused' as const }),
    fence: () => ({ kind: 'refused' as const, reason: 'not-open' as const }),
  };
  const drain = {
    outcome: Promise.resolve({ kind: 'drained' as const, settled: 0 }),
    settled: Promise.resolve(),
    resume: () => ({ kind: 'refused' as const, reason: 'not-fenced' as const }),
  };
  return {
    oldSession: { runtimeEpoch: EPOCH, generation: 1 },
    target: { kind: 'replacement', candidate: { runtimeEpoch: EPOCH, generation: 2 } },
    client: { document: EDITOR_DOC, capability: 'client-a', httpCapability: 'http-a' },
    fence,
    drain,
    preparation: { kind: 'normal', report: { kind: 'drained', settled: 0 } },
    host: { host: 'project', projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    routes: fakeLease([], ''),
    stopOldRun: null,
    ...overrides,
  };
}

describe('the switch-preparation receipt ledger', () => {
  it('freezes every binding at mint — the receipt reads back exactly what issuance bound', () => {
    const ledger = createReceiptLedger();
    const bound = bindings();
    const receipt = ledger.mint(bound);
    expect(receipt.oldSession).toEqual({ runtimeEpoch: EPOCH, generation: 1 });
    expect(receipt.target).toEqual({
      kind: 'replacement',
      candidate: { runtimeEpoch: EPOCH, generation: 2 },
    });
    expect(receipt.client).toEqual({
      document: EDITOR_DOC,
      capability: 'client-a',
      httpCapability: 'http-a',
    });
    expect(receipt.fence).toBe(bound.fence); // identity-bound, not copied
    expect(receipt.drain).toBe(bound.drain);
    expect(receipt.preparation).toEqual({
      kind: 'normal',
      report: { kind: 'drained', settled: 0 },
    });
    expect(receipt.host).toEqual({ host: 'project', projectKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(receipt.routes).toBe(bound.routes); // the lease bound at issuance, never re-read
    expect(receipt.stopOldRun).toBeNull();
  });

  it('is single-use: one consume spends it, the second refuses and the lookup reports it consumed', () => {
    const ledger = createReceiptLedger();
    const bound = bindings();
    const receipt = ledger.mint(bound);
    const lookup = ledger.lookup(receipt);
    expect(lookup.kind).toBe('valid');
    if (lookup.kind !== 'valid') throw new Error('unreachable');
    expect(lookup.bindings).toBe(bound); // the frozen issuance bindings, by identity
    expect(ledger.consume(receipt)).toBe(true);
    expect(ledger.consume(receipt)).toBe(false);
    expect(ledger.lookup(receipt)).toEqual({ kind: 'already-consumed' });
  });

  it('rejects a structurally identical forged object — the brand is unnameable outside the mint', () => {
    const ledger = createReceiptLedger();
    const receipt = ledger.mint(bindings());
    // The forge: every public field copied, the brand absent (it cannot
    // be named here). The ledger's membership check — not shape — is the
    // authority: manufactured request fields are never currency.
    const forged = {
      oldSession: receipt.oldSession,
      target: receipt.target,
      client: receipt.client,
      fence: receipt.fence,
      drain: receipt.drain,
      preparation: receipt.preparation,
      host: receipt.host,
      routes: receipt.routes,
      stopOldRun: receipt.stopOldRun,
    } as unknown as SwitchPreparationReceipt;
    expect(ledger.lookup(forged)).toEqual({ kind: 'unknown-receipt' });
    expect(ledger.consume(forged)).toBe(false);
    // the genuine receipt is unaffected by the forgery attempt
    expect(ledger.lookup(receipt).kind).toBe('valid');
  });

  it('never crosses ledgers: a receipt is currency only at the coordinator that minted it', () => {
    const mine = createReceiptLedger();
    const theirs = createReceiptLedger();
    const receipt = mine.mint(bindings());
    expect(theirs.lookup(receipt)).toEqual({ kind: 'unknown-receipt' });
    expect(theirs.consume(receipt)).toBe(false);
    expect(mine.consume(receipt)).toBe(true);
  });
});
