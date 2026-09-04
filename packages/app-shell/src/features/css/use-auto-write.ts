import type { EditResult, ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import { useEffect, useRef, useState } from 'react';
import { spliceText } from '../../../../core/src/splice-writer.ts';
import { useShell } from '../../app-shell/shell-context.ts';
import {
  createDebounceScheduler,
  type DebounceScheduler,
} from '../../editor/edit-drain/debounce-scheduler.ts';
import { createEditQueue, type EditQueue } from '../../editor/edit-drain/edit-queue.ts';
import { classifySettle, type WritePhase } from '../../editor/edit-drain/write-loop-state.ts';
import { roleCan } from '../../roles/capabilities.ts';
import { useEditSessionStore } from '../../state/edit-session-store.ts';
import { useCssAnchorStore } from './editing/anchors.ts';
import { type RecordIdentity, recordIdentityOf, resolveRecord } from './editing/resolve-record.ts';
import {
  invertSplice,
  planDeclarationSplice,
  planSelectorSplice,
  type SpliceWritePlan,
} from './editing/splice-plan.ts';
import { useCssWriteStore } from './editing/write-store.ts';
import type { BoundStyleRecord, BoundStylesPayload } from './inspection/bind-styles.ts';
import { type CssUndoEntry, useCssUndoStore } from './undo.ts';
import { type CssWriteStatus, cssWriteStatusOf } from './write-status.ts';

/**
 * The CSS vertical's auto-write loop (#250, I2): the feature's edit
 * gesture machine over the SHARED edit drain/fence seam (ADR-0002
 * amendment 5 — the seam's second consumer and chartered birth): the
 * seam's debounce scheduler (the settled ~300 ms persist-on-pause),
 * its ordering queue (one mutation in flight), and its write-loop
 * machine (the five reported states), with only the SPLICE PLANNING
 * domain-specific here.
 *
 * The loop's laws:
 *
 * - **Grant-bound only** — every write plan echoes the server-issued
 *   opaque css grant for the file (the served facts' freshest, or the
 *   last commit's follow-on while the refresh converges); no path is
 *   ever submitted or selected, and the server re-validates the full
 *   table at execution.
 * - **Byte-surgical by proof** — the planner re-derives the splice
 *   bounds from the live records and proves the raw slice; a changed
 *   source range, a drifted record, or a truncated raw is the same
 *   honest refusal, writing nothing.
 * - **Renewal** — a committed settle's follow-on grant becomes the
 *   file's anchor grant (with the pure splice oracle's raw), so
 *   editing may continue immediately; the served facts supersede it
 *   when the refresh lands.
 * - **Conflicts are stable** — a revision conflict keeps the machine
 *   in its conflict state (the disk-truth SHA surfaced), clears undo
 *   (the stack's baselines died), and reloads the served truth — the
 *   next edit is a new attempt over fresh facts, and "next edit"
 *   includes one already queued when the conflict landed: arriving
 *   work re-arms the refused machine at the fire gate exactly as a
 *   fresh schedule does (J3's retry-recovery law), so the queued
 *   intent converges honestly instead of stalling the quiet bound out
 *   against a phase only a reset can leave.
 * - **Undo is a write** — the popped inverse splice dispatches through
 *   this same loop (the current grant, the same proofs), never a
 *   client-side trick; it is generation-local and dies at the pair
 *   change, the revocation, and the conflict reload.
 */

/** The quiet-wait bound — the landing's own give-up plus margin (a safety net, never the law). */
const QUIET_BOUND_MS = 15_000;
/** The landing retry's cadence and bound — J3's discipline, identical law. */
const REFRESH_TICK_MS = 250;
const REFRESH_ATTEMPTS = 40;

/** One pending edit intent — semantic identity plus the edit itself. */
type CssEditIntent =
  | (RecordIdentity & {
      readonly kind: 'declaration';
      readonly property: string;
      readonly nextValue: string;
    })
  | (RecordIdentity & { readonly kind: 'selector'; readonly nextSelector: string });

/** Resolves when the machine is quiet again — bounded, never a spin. */
function waitForQuiet(boundMs: number): Promise<void> {
  return new Promise((resolve) => {
    const store = useCssWriteStore;
    if (store.getState().write.phase === 'idle') return resolve();
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, boundMs);
    const unsubscribe = store.subscribe((state) => {
      if (state.write.phase !== 'idle') return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/**
 * The landing gate's one predicate: the served payload moved off the
 * pre-write truth in BOTH observations — the converged revision AND the
 * written file's served raw. A revision-moved, raw-stale payload is
 * torn, never a reopen.
 */
function landingServed(
  payload: BoundStylesPayload,
  awaited: { readonly file: string; readonly raw: string; readonly revision: number },
): boolean {
  const servedRaw = payload.writeFacts.get(awaited.file)?.raw;
  return (
    payload.revision !== awaited.revision && servedRaw !== undefined && servedRaw !== awaited.raw
  );
}

/** The hook's controls — everything the editor surface renders, nothing it owns. */
export interface CssAutoWriteControls {
  readonly status: CssWriteStatus;
  readonly phase: WritePhase;
  readonly canUndo: boolean;
  scheduleDeclarationEdit(record: BoundStyleRecord, property: string, nextValue: string): void;
  scheduleSelectorEdit(record: BoundStyleRecord, nextSelector: string): void;
  undo(): void;
}

/**
 * The auto-write loop for one document's CSS editing — bound at the
 * shell's session, consuming the served styles payload (records plus
 * write facts) and dispatching through the one AppClient's
 * `applyEdit`.
 */
export function useCssAutoWrite(payload: BoundStylesPayload | null): CssAutoWriteControls {
  const { session, role, gate, queryClient } = useShell();
  const write = useCssWriteStore((state) => state.write);
  const nextSeq = useCssWriteStore((state) => state.nextSeq);
  const dispatchEvent = useCssWriteStore((state) => state.dispatch);
  const holdGrant = useEditSessionStore((state) => state.holdGrant);
  const pushUndoRecord = useEditSessionStore((state) => state.pushUndo);
  const canUndo = useCssUndoStore((state) => state.entries.length > 0);
  const [scheduledCount, setScheduledCount] = useState(0);

  // The mechanical pieces — one instance per document lifetime, cleared
  // at unmount (the document's death kills every pending pause).
  const schedulerRef = useRef<DebounceScheduler | null>(null);
  const queueRef = useRef<EditQueue | null>(null);
  const intentsRef = useRef(new Map<string, CssEditIntent>());
  if (schedulerRef.current === null) schedulerRef.current = createDebounceScheduler();
  if (queueRef.current === null) queueRef.current = createEditQueue();
  const scheduler = schedulerRef.current;
  const queue = queueRef.current;

  // The payload and gate as closure-stable refs — the async dispatches
  // read the LIVE truth, never a stale render's.
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // The feature stores bind at the exact pair; the unmount clears the
  // pauses (the reset-safe-by-document-replacement belt, J2/J3 idiom).
  useEffect(() => {
    useCssUndoStore.getState().bind(session.ref);
    useCssAnchorStore.getState().bind(session.ref);
  }, [session.ref]);
  useEffect(
    () => () => {
      scheduler.clear();
      intentsRef.current.clear();
    },
    [scheduler],
  );

  // The served facts note the anchors — the freshest inspection's
  // grants and raw truths, superseding every locally-derived anchor.
  useEffect(() => {
    const actor = sessionRef.current.ref;
    for (const [file, fact] of payload?.writeFacts ?? []) {
      useCssAnchorStore.getState().note(actor, file, { raw: fact.raw, grant: fact.grant });
    }
  }, [payload]);

  // The landing gate: a committed (or uncertain) write holds
  // refresh-required until BOTH the converged revision and the served
  // raw for the written file moved off the pre-write truth — a
  // revision-moved, raw-stale payload is torn, never a reopen.
  const awaitedRef = useRef<{ file: string; raw: string; revision: number } | null>(null);
  const [refreshAttempts, setRefreshAttempts] = useState(0);
  useEffect(() => {
    const awaited = awaitedRef.current;
    if (awaited === null || payload === null) return;
    if (landingServed(payload, awaited)) {
      awaitedRef.current = null;
      setRefreshAttempts(0);
      dispatchEvent({ type: 'refresh-landed', seq: write.seq });
    }
  }, [payload, write.seq, dispatchEvent]);

  // The bounded refresh retry — the same cadence and law as J3's.
  useEffect(() => {
    if (write.phase !== 'refresh-required') {
      if (refreshAttempts !== 0) setRefreshAttempts(0);
      return;
    }
    const awaited = awaitedRef.current;
    if (awaited === null || payload === null) return;
    if (landingServed(payload, awaited)) return;
    if (refreshAttempts >= REFRESH_ATTEMPTS) {
      // the honest give-up: quiet on the served truth as-is
      awaitedRef.current = null;
      dispatchEvent({ type: 'refresh-landed', seq: write.seq });
      return;
    }
    const timer = setTimeout(() => {
      setRefreshAttempts((attempt) => attempt + 1);
      void queryClient.refetchQueries(
        { queryKey: session.queryKey('styles') },
        { cancelRefetch: false },
      );
    }, REFRESH_TICK_MS);
    return () => clearTimeout(timer);
  }, [write.phase, write.seq, refreshAttempts, payload, queryClient, session, dispatchEvent]);

  /** The client-side admission check — the first refusal, or null when writable. */
  function refusal(): string | null {
    if (!roleCan(role, 'schedule-edit')) return 'role-forbidden';
    if (!gateRef.current.isCurrent()) return 'stale-generation';
    if (payloadRef.current === null) return 'no-inspection';
    return null;
  }

  /** One refusal's dispatch — submitted then rejected, the honest no-write. */
  function refuse(code: string): void {
    const seq = nextSeq();
    dispatchEvent({ type: 'submitted', seq });
    dispatchEvent({ type: 'rejected', seq, code });
  }

  /** Invalidates the styles family — the reload every stale-truth refusal converges through. */
  function reloadStyles(): void {
    void queryClient.invalidateQueries({ queryKey: sessionRef.current.queryKey('styles') });
  }

  /**
   * Submits one planned splice — the one wire gesture both the edit
   * intents and the undo inverse dispatch through. `undoEntry` is the
   * inverse a committed landing pushes (absent for the undo's own
   * dispatch — the popped inverse never re-pushes).
   */
  async function submitSplice(
    file: string,
    plan: SpliceWritePlan,
    undoEntry: CssUndoEntry | null,
  ): Promise<void> {
    const seq = nextSeq();
    dispatchEvent({ type: 'submitted', seq });
    const anchorRaw = useCssAnchorStore.getState().anchors.get(file)?.raw ?? null;
    const payloadNow = payloadRef.current;
    awaitedRef.current =
      anchorRaw !== null && payloadNow !== null
        ? { file, raw: anchorRaw, revision: payloadNow.revision }
        : null;
    let outcome: EditResult | Error;
    try {
      outcome = await sessionRef.current.applyEdit(plan);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error('unknown');
    }
    const settled = classifySettle(outcome);
    if (settled.kind === 'committed') {
      await continueCommitted(
        file,
        plan,
        anchorRaw,
        settled.nextGrant,
        undoEntry,
        seq,
        settled.revision,
      );
      return;
    }
    if (settled.kind === 'conflict') {
      dispatchEvent({ type: 'conflict', seq, currentSha256: settled.currentSha256 });
    } else if (settled.kind === 'rejected') {
      dispatchEvent({ type: 'rejected', seq, code: settled.code });
    } else {
      dispatchEvent({ type: 'uncertain', seq });
    }
    // The conflict and every grant death converge through the reload:
    // the stable refused state stands until fresh facts re-arm it, and
    // the undo stack's baselines died with the world they were
    // computed against.
    if (settled.kind !== 'uncertain') {
      useCssUndoStore.getState().clear();
      reloadStyles();
    } else {
      await refreshAfterSettle(seq, 'uncertain');
    }
  }

  /**
   * One committed settle's continuation: the machine's commit, the
   * renewed anchor (the pure splice oracle's raw plus the follow-on
   * grant — editing may continue while the refresh converges, the
   * served facts superseding when they land), the undo entry, and the
   * landing-gated refresh.
   */
  async function continueCommitted(
    file: string,
    plan: SpliceWritePlan,
    anchorRaw: string | null,
    nextGrant: ResourceGrant | null,
    undoEntry: CssUndoEntry | null,
    seq: number,
    revision: number,
  ): Promise<void> {
    dispatchEvent({ type: 'committed', seq, revision });
    if (anchorRaw !== null && nextGrant !== null) {
      const nextRaw = spliceText(anchorRaw, {
        start: plan.range.start,
        end: plan.range.end,
        replacement: plan.replacement,
      });
      useCssAnchorStore.getState().note(sessionRef.current.ref, file, {
        raw: nextRaw,
        grant: nextGrant,
      });
      holdGrant(sessionRef.current.ref, { token: nextGrant.token });
    }
    if (undoEntry !== null) {
      useCssUndoStore.getState().push(sessionRef.current.ref, undoEntry);
      pushUndoRecord(sessionRef.current.ref, { token: undoEntry.key });
    }
    await refreshAfterSettle(seq, 'committed');
  }

  /**
   * The post-settlement refresh — one macrotask ahead of the
   * invalidation so the settled phase renders first (J3's act
   * boundary), then the generation-scoped styles key invalidates. A
   * COMMITTED write holds refresh-required until the landing gate
   * observes both movements; an UNCERTAIN one is answered by the
   * refresh's own completion (the payload as served is the truth,
   * moved or not).
   */
  async function refreshAfterSettle(seq: number, kind: 'committed' | 'uncertain'): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    dispatchEvent({ type: 'refresh-begun', seq });
    await queryClient.invalidateQueries({ queryKey: sessionRef.current.queryKey('styles') });
    if (kind === 'uncertain') dispatchEvent({ type: 'refresh-landed', seq });
  }

  /** Runs one intent — the queued dispatch's body. */
  async function runIntent(intent: CssEditIntent): Promise<void> {
    const blocked = refusal();
    if (blocked !== null) return refuse(blocked);
    const payloadNow = payloadRef.current;
    const record = resolveRecord(payloadNow?.records ?? [], intent);
    const anchor = useCssAnchorStore.getState().anchors.get(intent.file);
    if (record === null || anchor === undefined) {
      refuse('source-drift');
      reloadStyles();
      return;
    }
    const planned =
      intent.kind === 'declaration'
        ? planDeclarationSplice({
            fact: { file: intent.file, grant: anchor.grant, raw: anchor.raw },
            record,
            property: intent.property,
            nextValue: intent.nextValue,
          })
        : planSelectorSplice({
            fact: { file: intent.file, grant: anchor.grant, raw: anchor.raw },
            record,
            nextSelector: intent.nextSelector,
          });
    if (!planned.ok) {
      refuse(planned.code);
      if (planned.code === 'source-drift' || planned.code === 'no-facts') reloadStyles();
      return;
    }
    const { plan, replaced } = planned.splice;
    const undoEntry: CssUndoEntry = {
      key: `${intent.file}#${plan.range.start}-${plan.range.end}`,
      file: intent.file,
      // the inverse splice — the planner's own inversion law, composed
      ...invertSplice({ range: plan.range, replacement: plan.replacement, replaced }),
    };
    await submitSplice(intent.file, plan, undoEntry);
  }

  /**
   * Re-derives the pending-pause count from the scheduler — its pending
   * keys ARE the accounting (a replaced debounce for one key is still
   * ONE pending pause), so the badge can never drift off a fire the
   * scheduler coalesced away.
   */
  function syncScheduledCount(): void {
    setScheduledCount(scheduler.pendingKeys().length);
  }

  /**
   * Re-arms a refused machine for arriving queued work — `schedule()`'s
   * own law for a new edit (J3's retry-recovery), held at the fire gate
   * too: a stable `rejected` is a settled refusal, not busyness, and a
   * quiet wait on it can never resolve early (only a reset leaves that
   * phase), so without the re-arm a queued intent would stall the bound
   * out and die. The reset makes the queued dispatch the new attempt it
   * is.
   */
  function rearmRefusedMachine(): void {
    if (useCssWriteStore.getState().write.phase === 'rejected') {
      dispatchEvent({ type: 'reset' });
    }
  }

  /**
   * The busy gate's honest refusal: a machine still not quiet past the
   * bound cannot mint a `submitted` (legal only from `idle`), so a bare
   * `refuse('busy')` there is a dropped event pair, never a badge. The
   * reset first — then the refusal lands and the bounded give-up is
   * reported, not silent.
   */
  function refuseBusy(): void {
    dispatchEvent({ type: 'reset' });
    refuse('busy');
  }

  /** Fires one scheduled key — the queue serializes, the intent reads live. */
  function fireKey(key: string): void {
    // the fired key is already gone from the scheduler's table — the
    // derived count reads exactly the pauses that remain
    syncScheduledCount();
    void queue.enqueue(async () => {
      rearmRefusedMachine();
      await waitForQuiet(QUIET_BOUND_MS);
      const intent = intentsRef.current.get(key);
      // the intent leaves the table on EVERY exit path — a dropped
      // intent never survives to shadow a later same-key schedule
      intentsRef.current.delete(key);
      if (intent === undefined) return;
      if (useCssWriteStore.getState().write.phase !== 'idle') return refuseBusy();
      await runIntent(intent);
    });
  }

  /** Schedules one intent — the settled pause, replacing any pending one for the key. */
  function schedule(key: string, intent: CssEditIntent): void {
    intentsRef.current.set(key, intent);
    // A refused machine re-arms on the next edit — the new attempt's
    // reset (J3's retry-recovery law).
    if (useCssWriteStore.getState().write.phase === 'rejected') {
      dispatchEvent({ type: 'reset' });
    }
    scheduler.schedule(key, () => fireKey(key));
    syncScheduledCount();
  }

  /** The declaration-value edit gesture — the persist-on-pause write. */
  function scheduleDeclarationEdit(
    record: BoundStyleRecord,
    property: string,
    nextValue: string,
  ): void {
    schedule(`${record.file}#${record.selector}#${record.media ?? ''}#${property}`, {
      ...recordIdentityOf(record),
      kind: 'declaration',
      property,
      nextValue,
    });
  }

  /** The selector-rename gesture — the scoped-splice species. */
  function scheduleSelectorEdit(record: BoundStyleRecord, nextSelector: string): void {
    schedule(`${record.file}#${record.selector}#${record.media ?? ''}@selector`, {
      ...recordIdentityOf(record),
      kind: 'selector',
      nextSelector,
    });
  }

  /** The undo gesture — the popped inverse, dispatched as a write. */
  function undo(): void {
    const entry = useCssUndoStore.getState().peek();
    if (entry === null) return;
    useCssUndoStore.getState().pop(sessionRef.current.ref);
    void queue.enqueue(async () => {
      rearmRefusedMachine();
      await waitForQuiet(QUIET_BOUND_MS);
      if (useCssWriteStore.getState().write.phase !== 'idle') return refuseBusy();
      const anchor = useCssAnchorStore.getState().anchors.get(entry.file);
      if (anchor === undefined) {
        refuse('no-facts');
        reloadStyles();
        return;
      }
      if (anchor.raw.slice(entry.range.start, entry.range.end) !== entry.replaced) {
        // the stack's baselines died with the drifted world — clear it
        useCssUndoStore.getState().clear();
        refuse('undo-drift');
        reloadStyles();
        return;
      }
      const plan: SpliceWritePlan = {
        operation: 'splice' as const,
        grant: anchor.grant,
        range: entry.range,
        replacement: entry.replacement,
      };
      await submitSplice(entry.file, plan, null);
    });
  }

  return {
    status: cssWriteStatusOf(write, scheduledCount),
    phase: write.phase,
    canUndo,
    scheduleDeclarationEdit,
    scheduleSelectorEdit,
    undo,
  };
}
