import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import type { ClientDocument } from '../clients/session-clients.ts';
import type { DrainReport } from '../fence/drain-report.ts';
import type { EditFence } from '../fence/edit-fence.ts';
import type { ProjectHostTarget, RoutesTarget } from '../revocation/authority-revocation.ts';

/**
 * The switch-preparation receipt (#238, F6; ADR-0006 §4 step 5 and §9
 * `PreparedReplacement`): the one-use, opaque proof that one
 * transition's preparation completed — minted only after a terminal
 * bounded drain (the normal variant) or a forced preparation proving
 * the exact write executor exited (the forced variant), never
 * manufacturable from request fields. Consuming it is the commit
 * linearization point; this module owns the currency's shape, the
 * bindings it freezes at issuance, and the one-use ledger that mints
 * and consumes it.
 *
 * **The bindings are the truth** (the ticket's migration policy): the
 * receipt freezes the exact old `SessionRef`, the candidate `SessionRef`
 * or the deactivation target, the authoritative client, the fence, the
 * preparation result, and the old-side revocation targets (the project
 * host scope and the origin lease). After
 * acceptance nothing re-reads "what is active" to decide what to
 * revoke — consumption drives exactly what was bound, and a binding
 * that no longer matches the presented candidate refuses without
 * linearizing.
 *
 * **One use**: a receipt is spent by consumption and never again — a
 * replay answers the sanitized structured rejection
 * `already-consumed`; an object this coordinator never minted answers
 * `unknown-receipt` (the brand below is unnameable outside this
 * module, so a forged structurally-identical object fails the ledger's
 * membership check — it cannot be manufactured, only minted). And one
 * transition holds at most one LIVE receipt: minting over the identity
 * an unconsumed receipt already binds refuses with
 * `transition-already-prepared`, so a second receipt can never exist
 * to re-linearize a transition the first already committed.
 *
 * Deterministic by construction: no IO, no timers — the minting
 * validations (the drain report, the fence state, the authoritative
 * client, the forced exit) live in `./switch-coordinator.ts`; this
 * module is the pure currency and ledger over them.
 */

/**
 * What a receipt transitions TO (ADR-0006 §4 step 5: "candidate
 * `SessionRef` or deactivation target"): a staged replacement's
 * candidate pair, or the shutdown transition that deactivates the old
 * session with no successor.
 */
export type SwitchTarget =
  | { readonly kind: 'replacement'; readonly candidate: SessionRef }
  | { readonly kind: 'deactivation' };

/**
 * The observed write-executor exit — D5's process-lane idiom: the exit
 * event's own `{ code, signal }` detail, the shape
 * `WriteExecutorHandle.exited` resolves with. Code and signal only —
 * never a PID (ADR-0006 §8 output hygiene).
 */
export interface ExecutorExitView {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * The preparation result a receipt certifies (ADR-0006 §4 step 5 "and
 * preparation outcome"): the sealed terminal drain report (normal), or
 * the observed exact write-executor exit (forced). The report is the
 * sealed verdict — a timed-out report is never rewritten by late
 * terminality, so it never appears here.
 */
export type PreparationResult =
  | { readonly kind: 'normal'; readonly report: DrainReport }
  | { readonly kind: 'forced'; readonly exit: ExecutorExitView };

/**
 * The authoritative editing client a receipt binds (ADR-0006 §4 step 5
 * "authoritative client"): its exact document, plus both truths of its
 * capability — the supervisor-side registry's (F4, validated at mint)
 * and the HTTP-side binding's (F2, revoked through `unbind` at
 * commit). Both are control-plane currency and never cross the wire.
 */
export interface AuthoritativeClient {
  readonly document: ClientDocument;
  /** The supervisor-side registry capability (F4's `bind` mint). */
  readonly capability: string;
  /** The HTTP-side binding capability (F2's `bind` mint). */
  readonly httpCapability: string;
}

/**
 * Everything a receipt freezes at issuance. The function-bearing
 * members (the fence, the lease, the stop seam) are bound by identity —
 * the receipt is control-plane-internal currency and never serializes.
 * Every member has a consumer: `oldSession`/`host`/`routes` drive the
 * revocation, `client.httpCapability` unbinds the HTTP-side binding,
 * `fence` and `preparation` gate consumption, `target` guards the
 * grant, `stopOldRun` is the deactivation tail; `client`'s document and
 * supervisor-side capability are the issuance-frozen identity of the
 * authoritative editor the AC binds — F7's completion reports them, and
 * nothing re-validates authority off a receipt (the mint validated it).
 * The drain HANDLE is deliberately not frozen: its sealed verdict rides
 * `preparation`, and no post-mint path consumes the handle.
 */
export interface ReceiptBindings {
  /** The exact outgoing pair — every session-scoped revocation's key. */
  readonly oldSession: SessionRef;
  /** The staged successor's pair, or the deactivation target. */
  readonly target: SwitchTarget;
  /** The one authoritative editing client the transition runs under. */
  readonly client: AuthoritativeClient;
  /** The fence the preparation drained — consumption re-checks it never left its certified state. */
  readonly fence: EditFence;
  /** The preparation proof the receipt carries. */
  readonly preparation: PreparationResult;
  /** The outgoing session's project host scope — capability and route revocations' target. */
  readonly host: ProjectHostTarget;
  /** The outgoing session's origin lease, bound at issuance — never re-read from active state. */
  readonly routes: RoutesTarget;
  /** Deactivation only: stops the outgoing run after revocation; `null` for replacements (the supervisor's commit owns that stop). */
  readonly stopOldRun: (() => void) | null;
}

/**
 * The module-private brand: outside this module the symbol cannot be
 * named, so no object literal can structurally satisfy the receipt —
 * a receipt is minted, never constructed (ADR-0006 §9 "cannot be
 * manufactured from request fields").
 */
const RECEIPT_BRAND: unique symbol = Symbol('astroix.switch-preparation-receipt');

/** The one-use receipt — opaque by brand, readable in its bindings, manufacturable only through the ledger's mint. */
export interface SwitchPreparationReceipt extends ReceiptBindings {
  readonly [RECEIPT_BRAND]: true;
}

/**
 * One ledger entry, held ONLY by the weak map keyed on its receipt: the
 * ledger itself keeps no strong reference, so the entry — and the
 * frozen machinery it names (the fence, the lease, the stop seam
 * closure) — collects as soon as the composition drops the last
 * reference to the receipt. A spent entry lives exactly as long as its
 * caller's own receipt reference, which is precisely how a replay
 * still answers `already-consumed`: the replay arrives HOLDING the
 * receipt.
 */
interface LedgerEntry {
  /** The transition identity this entry was minted under — the live map's deletion key at consume. */
  readonly key: string;
  readonly bindings: ReceiptBindings;
  consumed: boolean;
}

/**
 * Why a receipt was refused at consumption — sanitized vocabulary
 * only, never a value (the receipt's own bytes are never echoed).
 */
export type ReceiptLookup =
  | { readonly kind: 'valid'; readonly bindings: ReceiptBindings }
  | { readonly kind: 'unknown-receipt' }
  | { readonly kind: 'already-consumed' };

/** `mint`'s answer: one fresh receipt, or the duplicate-live refusal. */
export type MintResult =
  | { readonly kind: 'minted'; readonly receipt: SwitchPreparationReceipt }
  | { readonly kind: 'refused'; readonly reason: 'transition-already-prepared' };

/**
 * The one-use ledger: the single place a receipt is minted and spent.
 * Two invariants live here, both structural: a receipt is spent by one
 * consumption (the one-use flip), and **one transition holds at most
 * one live receipt** — an unconsumed receipt already binding the same
 * `(oldSession, target identity)` pair refuses the next mint over that
 * identity, so a second receipt can never exist to pass the binding
 * checks after the first linearized (the old fence's post-mortem
 * `drained` state would let it) and re-run revocation over already-
 * revoked surfaces. Consuming frees the identity for a fresh prepare —
 * LITERALLY: the identity's live-map entry is deleted at the consume
 * flip, and nothing else holds it; an abandoned live receipt pins its
 * identity until then (voiding an abandoned preparation is the cancel
 * lane's, not this currency's). And the ledger retains nothing per
 * spent transition: entries live in a weak map keyed by the receipt,
 * so a spent receipt and its frozen machinery collect with the
 * composition's own last reference to it.
 */
export interface ReceiptLedger {
  /**
   * Freezes validated bindings into one fresh, unconsumed receipt —
   * unless an unconsumed receipt already binds the same transition
   * identity (exact old pair + same target: the same candidate ref, or
   * both deactivations).
   */
  mint(bindings: ReceiptBindings): MintResult;
  /** Resolves the receipt's bindings without spending it — the pre-linearization checks read here. */
  lookup(receipt: SwitchPreparationReceipt): ReceiptLookup;
  /**
   * Spends the receipt — the one-use flip. Refuses (and leaves the
   * receipt unspent) when it is unknown or already consumed; the
   * caller performs every binding check BEFORE this call, so a
   * refused binding never spends the currency.
   */
  consume(receipt: SwitchPreparationReceipt): boolean;
}

/**
 * One transition's identity key — the exact old pair plus the target's
 * own identity (the candidate pair, or the deactivation marker).
 * `JSON.stringify` of a fixed-shape array: delimiter-free and
 * collision-proof whatever alphabet the epoch mints.
 */
function transitionKey(bindings: ReceiptBindings): string {
  const target = bindings.target;
  return JSON.stringify([
    bindings.oldSession.runtimeEpoch,
    bindings.oldSession.generation,
    target.kind,
    target.kind === 'replacement' ? target.candidate.runtimeEpoch : null,
    target.kind === 'replacement' ? target.candidate.generation : null,
  ]);
}

/**
 * Builds one ledger — the switch coordinator owns its lifetime; one
 * coordinator, one ledger. The two structures are the whole retention
 * story: `live` (strong) holds exactly one unconsumed receipt per
 * transition identity — its entry is DELETED at consume, which is the
 * documented "consuming frees the identity" law made literal — and
 * `entries` (weak, keyed by the receipt) holds every entry only as
 * long as some receipt reference exists. The duplicate-live refusal is
 * one `live` lookup, never a scan over history.
 */
export function createReceiptLedger(): ReceiptLedger {
  const live = new Map<string, SwitchPreparationReceipt>();
  const entries = new WeakMap<SwitchPreparationReceipt, LedgerEntry>();
  return {
    mint: (bindings) => {
      const key = transitionKey(bindings);
      // the invariant: `live` holds only unconsumed receipts (consume
      // deletes), so presence alone is the duplicate-live refusal
      if (live.has(key)) return { kind: 'refused', reason: 'transition-already-prepared' };
      const receipt: SwitchPreparationReceipt = { ...bindings, [RECEIPT_BRAND]: true };
      entries.set(receipt, { key, bindings, consumed: false });
      live.set(key, receipt);
      return { kind: 'minted', receipt };
    },
    lookup: (receipt) => {
      const entry = entries.get(receipt);
      if (entry === undefined) return { kind: 'unknown-receipt' };
      if (entry.consumed) return { kind: 'already-consumed' };
      return { kind: 'valid', bindings: entry.bindings };
    },
    consume: (receipt) => {
      const entry = entries.get(receipt);
      if (entry === undefined || entry.consumed) return false;
      entry.consumed = true;
      live.delete(entry.key); // consuming frees the identity — literally
      return true;
    },
  };
}
