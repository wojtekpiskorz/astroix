import { useEffect, useRef, useState } from 'react';
import { useShell } from '../../../app-shell/shell-context.ts';
import { classifySettle, type WritePhase } from '../../../editor/edit-drain/write-loop-state.ts';
import { roleCan } from '../../../roles/capabilities.ts';
import { useEditSessionStore } from '../../../state/edit-session-store.ts';
import { useEntryWriteFacts } from '../api.ts';
import { plainEquals } from '../forms/edit-intent.ts';
import { useFormDraftStore } from '../forms/form-draft-store.ts';
import type { EntryFormView } from '../forms/use-entry-form.ts';
import { buildEntryWritePlan } from './serialize-entry-write.ts';
import { useContentWriteStore } from './write-store.ts';

/**
 * The Content write loop (#253, J3): the feature-local loop that binds
 * J2's validated edit intent to an opaque grant, submits it through the
 * ONE AppClient's `applyEdit` (the one-AppClient law — no second
 * transport, no direct fetch, no browser filesystem path anywhere),
 * reports the AC's five states distinctly, and refreshes Content and
 * routes from revisioned server truth after every commit.
 *
 * The loop's admission order (each refusal names itself, sanitised, and
 * dispatches NOTHING):
 *
 * 1. the document's role may schedule edits at all (`schedule-edit`
 *    capability — the diagnostic target is read-only);
 * 2. the shell's session gate is still current (stale generation);
 * 3. the intent is ready (an unedited draft has nothing to write; a
 *    draft with diagnostics is not writable);
 * 4. the entry carries server-issued write facts (an entry the write
 *    composition could not enrich has no grant — read-only truth);
 * 5. the inspected baseline is still the live revision (stale
 *    baseline), and the grant binds exactly that revision (stale
 *    grant);
 * 6. the serializer accepts (core's entry-writer over the raw anchor).
 *
 * A settled mutation: `committed` (server revision + the follow-on
 * grant held in the shell's edit-session store) or `rejected` (with the
 * revision-conflict SHA when the server handed one back) converges by
 * invalidating the generation-scoped content and routes keys — then
 * `refresh-required` until the refreshed payload's entry revision AND
 * served projection have both moved past the written baseline (a
 * revision-moved, projection-stale payload is a torn truth, never a
 * reopen), when the draft reopens on the served truth and the loop
 * goes quiet again. An UNCERTAIN settle (transport, `internal-error`,
 * abort, the stale-response belt) is `irreversible-postcommit` — the
 * write may or may not have landed — and converges through the same
 * refresh, never a guess.
 */
export function useEntryWrite(view: EntryFormView): EntryWriteControls {
  const { session, role, gate, queryClient } = useShell();
  const facts = useEntryWriteFacts(
    view.activeEntry?.collection ?? null,
    view.activeEntry?.entryId ?? null,
  );
  const write = useContentWriteStore((state) => state.write);
  const nextSeq = useContentWriteStore((state) => state.nextSeq);
  const dispatchEvent = useContentWriteStore((state) => state.dispatch);
  const holdGrant = useEditSessionStore((state) => state.holdGrant);
  const clearDraft = useFormDraftStore((state) => state.clear);
  const bindingRef = useRef<string | null>(null);

  // The loop's binding reset: a changed entry (or the pane's absent
  // states) resets the machine — one entry's write truth never renders
  // for another's.
  const bindingKey =
    view.activeEntry === null
      ? null
      : `${session.ref.runtimeEpoch}/${session.ref.generation}/${view.activeEntry.collection}/${view.activeEntry.entryId}`;
  useEffect(() => {
    if (bindingRef.current !== bindingKey) {
      bindingRef.current = bindingKey;
      // A reset kills the awaited landing too: one entry's post-commit
      // refresh never lands another entry's pane.
      awaitedRef.current = null;
      dispatchEvent({ type: 'reset' });
    }
  }, [bindingKey, dispatchEvent]);

  // The awaited landing: after a settled mutation, the loop remembers
  // the PRE-COMMIT baseline — its revision AND its served projection
  // (the values the draft began from). The landing fires only when
  // revisioned server truth has ACTUALLY arrived, and that is two
  // movements, not one: the entry's revision (a fresh disk read
  // server-side, so it moves the instant the executor's atomic
  // replacement lands) AND the served projection (the managed dev
  // server's content layer, which converges on its own watcher
  // cadence and can TRAIL the disk). A revision-moved,
  // projection-stale payload is a TORN truth — reopening on it would
  // paint the pre-write values under the post-write revision, and the
  // pane would never self-correct (the reopen is once). So the loop
  // holds until both moved, the retry below keeps refetching until
  // they do, and the landing — the draft cleared, the cleared binding
  // re-arming the form slice's open effect to reopen on the served
  // truth (whatever the machine's phase raced to) — is the only
  // reopen there is.
  const awaitedRef = useRef<{ readonly revision: string; readonly values: unknown } | null>(null);
  const [refreshAttempts, setRefreshAttempts] = useState(0);
  const servedProjectionMoved = (() => {
    const awaited = awaitedRef.current;
    if (awaited === null || facts === null) return false;
    return !plainEquals(facts.servedValues, awaited.values);
  })();
  useEffect(() => {
    const awaited = awaitedRef.current;
    if (awaited === null || view.baselineRevision === null || view.liveRevision === null) return;
    if (view.baselineRevision !== awaited.revision) return;
    if (view.liveRevision === awaited.revision) return;
    if (!servedProjectionMoved) return;
    awaitedRef.current = null;
    setRefreshAttempts(0);
    clearDraft();
    dispatchEvent({ type: 'refresh-landed', seq: write.seq });
  }, [
    write.seq,
    view.baselineRevision,
    view.liveRevision,
    servedProjectionMoved,
    clearDraft,
    dispatchEvent,
  ]);

  // The bounded refresh retry: while the refresh is required and the
  // awaited truth has not landed (either stream — revision or served
  // projection — still on the written baseline), the loop refetches
  // the content key on a short cadence. The attempt counter (declared
  // with the landing's state above) is state so each tick re-arms the
  // timer (the effect's other deps can all hold steady across a
  // refetch that changed nothing), bounded at 40 attempts — never a
  // spin — and the bound's give-up is honest: the loop goes quiet on
  // the served truth as-is rather than hang on it.
  useEffect(() => {
    if (write.phase !== 'refresh-required') {
      if (refreshAttempts !== 0) setRefreshAttempts(0);
      return;
    }
    if (awaitedRef.current === null) return;
    if (view.baselineRevision === null || view.liveRevision === null) return;
    if (view.baselineRevision !== view.liveRevision && servedProjectionMoved) return;
    if (refreshAttempts >= 40) {
      // the honest give-up: the server never moved (or its projection
      // never converged); the pane keeps the served truth and the loop
      // goes quiet rather than hang on it
      awaitedRef.current = null;
      dispatchEvent({ type: 'refresh-landed', seq: write.seq });
      return;
    }
    const timer = setTimeout(() => {
      setRefreshAttempts((attempt) => attempt + 1);
      // NEVER cancel the in-flight fetch: the server-side inspection
      // does not observe the client's abort (a cancelled dispatch runs
      // to completion server-side), so a cancel-and-redispatch cadence
      // stacks concurrent fresh-runner passes over the one dev-server
      // transport until the adapter's runner-cleanup residue proof
      // trips. `cancelRefetch: false` dedupes against the in-flight
      // refetch instead — one content inspection in flight at a time,
      // every retry serialized behind it.
      void queryClient.refetchQueries(
        { queryKey: session.queryKey('content') },
        { cancelRefetch: false },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [
    write.phase,
    write.seq,
    refreshAttempts,
    view.baselineRevision,
    view.liveRevision,
    servedProjectionMoved,
    queryClient,
    session,
    dispatchEvent,
  ]);

  // The retry recovery: a rejection stands until the draft moves again —
  // the next edit is a new attempt, and the surface re-arms for it.
  const rejectedValuesRef = useRef<unknown>(null);
  useEffect(() => {
    if (write.phase !== 'rejected') {
      rejectedValuesRef.current = null;
      return;
    }
    if (rejectedValuesRef.current === null) {
      rejectedValuesRef.current = view.values;
      return;
    }
    if (rejectedValuesRef.current !== view.values) {
      rejectedValuesRef.current = null;
      dispatchEvent({ type: 'reset' });
    }
  }, [write.phase, view.values, dispatchEvent]);

  /** The client-side admission check — the first refusal, or null when writable. */
  function refusal(): string | null {
    if (!roleCan(role, 'schedule-edit')) return 'role-forbidden';
    if (!gate.isCurrent()) return 'stale-generation';
    if (view.status !== 'ready' || view.activeEntry === null) return 'no-entry';
    if (view.intentState === 'none') return 'nothing-to-write';
    if (view.intentState === 'invalid' || view.intent === null) return 'invalid-intent';
    if (facts === null) return 'no-grant';
    if (view.baselineRevision === null || view.liveRevision === null) return 'no-baseline';
    if (view.baselineRevision !== view.liveRevision) return 'stale-baseline';
    return null;
  }

  /** Submits the active intent — the pane's one write gesture. */
  async function submit(): Promise<void> {
    const refused = refusal();
    const serialized =
      refused === null && facts !== null && view.intent !== null
        ? buildEntryWritePlan({ facts, intent: view.intent, fields: view.fields })
        : null;
    if (refused !== null || serialized === null || !serialized.ok) {
      const seq = nextSeq();
      dispatchEvent({ type: 'submitted', seq });
      dispatchEvent({
        type: 'rejected',
        seq,
        code: refused ?? (serialized?.ok === false ? serialized.code : 'no-grant'),
      });
      return;
    }
    const seq = nextSeq();
    dispatchEvent({ type: 'submitted', seq });
    // The baseline this dispatch writes against — its revision (the
    // landing's freshness currency) and its served projection (the
    // values the draft began from — the landing's torn-truth gate):
    // the refresh's landing is observed as BOTH moving off it. The
    // refusal above proved both non-null; the guard keeps that proof
    // in the type.
    awaitedRef.current =
      view.baselineRevision !== null && view.intent !== null
        ? { revision: view.baselineRevision, values: view.intent.baseline.values }
        : null;
    try {
      const kind = settleDispatch(seq, classifySettle(await session.applyEdit(serialized.plan)));
      await refreshAfterSettle(seq, kind);
    } catch (error) {
      settleDispatch(seq, classifySettle(error instanceof Error ? error : new Error('unknown')));
      await refreshAfterSettle(seq, 'uncertain');
    }
  }

  /**
   * Dispatches one settle's machine events — the shared tail of both
   * settle paths (the awaited result and the caught error). Returns
   * the refresh kind the settle's phase implies: `committed` or
   * `uncertain` (every error-side settle — conflict included —
   * converged through its own refresh).
   */
  function settleDispatch(
    seq: number,
    settled: ReturnType<typeof classifySettle>,
  ): 'committed' | 'uncertain' {
    if (settled.kind === 'committed') {
      dispatchEvent({ type: 'committed', seq, revision: settled.revision });
      if (settled.nextGrantToken !== null) {
        holdGrant(session.ref, { token: settled.nextGrantToken });
      }
      return 'committed';
    }
    if (settled.kind === 'conflict') {
      dispatchEvent({ type: 'conflict', seq, currentSha256: settled.currentSha256 });
    } else if (settled.kind === 'rejected') {
      dispatchEvent({ type: 'rejected', seq, code: settled.code });
    } else {
      dispatchEvent({ type: 'uncertain', seq });
    }
    return 'uncertain';
  }

  /**
   * The post-settlement refresh: one macrotask ahead of the
   * invalidation so the settled phase renders first (a deterministic
   * act boundary in tests, one paint in production — a microtask would
   * batch the two states into one render and hide the commit), then
   * the generation-scoped content and routes keys invalidate — the
   * same discipline the SSE invalidation bridge drives.
   *
   * The two settle kinds land differently: an UNCERTAIN outcome is
   * answered by the refresh's own completion (the payload as served is
   * the truth, moved or not — the pane keeps the draft either way),
   * while a COMMITTED write holds `refresh-required` until BOTH the
   * live revision and the served projection have moved off the written
   * baseline (the landing gate above) — the bounded retry keeps
   * refetching while the dev server's content layer converges, so the
   * pane never reopens on the pre-write truth.
   */
  async function refreshAfterSettle(seq: number, kind: 'committed' | 'uncertain'): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    dispatchEvent({ type: 'refresh-begun', seq });
    await queryClient.invalidateQueries({ queryKey: session.queryKey('content') });
    await queryClient.invalidateQueries({ queryKey: session.queryKey('routes') });
    if (kind === 'uncertain') dispatchEvent({ type: 'refresh-landed', seq });
  }

  const blocking = refusal();
  return {
    phase: write.phase,
    revision: write.revision,
    code: write.code,
    conflictSha256: write.conflictSha256,
    /** The button's enablement: quiet, admitted, and genuinely writable. */
    canWrite: write.phase === 'idle' && blocking === null,
    /** The disabled button's sanitized reason (the admission's first refusal). */
    blockedReason: write.phase === 'idle' ? blocking : null,
    submit,
  };
}

/** The write surface's controls — everything the pane renders, nothing it owns. */
export interface EntryWriteControls {
  readonly phase: WritePhase;
  readonly revision: number | null;
  readonly code: string | null;
  readonly conflictSha256: string | null;
  readonly canWrite: boolean;
  readonly blockedReason: string | null;
  submit(): Promise<void>;
}
