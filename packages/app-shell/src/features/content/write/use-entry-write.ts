import { useEffect, useRef } from 'react';
import { useShell } from '../../../app-shell/shell-context.ts';
import { roleCan } from '../../../roles/capabilities.ts';
import { useEditSessionStore } from '../../../state/edit-session-store.ts';
import { useEntryWriteFacts } from '../api.ts';
import { useFormDraftStore } from '../forms/form-draft-store.ts';
import type { EntryFormView } from '../forms/use-entry-form.ts';
import { buildEntryWritePlan } from './serialize-entry-write.ts';
import { classifySettle, type WritePhase } from './write-state.ts';
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
 * `refresh-required` until the refreshed payload's entry revision moves
 * past the written baseline, when the draft reopens on the served truth
 * and the loop goes quiet again. An UNCERTAIN settle (transport,
 * `internal-error`, abort, the stale-response belt) is
 * `irreversible-postcommit` — the write may or may not have landed —
 * and converges through the same refresh, never a guess.
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
      dispatchEvent({ type: 'reset' });
    }
  }, [bindingKey, dispatchEvent]);

  // The refresh-landed convergence: after a settled mutation, the loop
  // remembers the PRE-COMMIT baseline; the moment the live inspection's
  // entry revision moves off it, revisioned server truth has arrived —
  // the draft reopens on it (the form slice's open effect) whatever the
  // machine's phase raced to, because the refresh's own completion can
  // land before React renders the payload.
  const awaitedBaselineRef = useRef<string | null>(null);
  useEffect(() => {
    const awaited = awaitedBaselineRef.current;
    if (awaited === null || view.baselineRevision === null || view.liveRevision === null) return;
    if (view.baselineRevision !== awaited || view.liveRevision === awaited) return;
    awaitedBaselineRef.current = null;
    clearDraft();
    dispatchEvent({ type: 'refresh-landed', seq: write.seq });
  }, [write.seq, view.baselineRevision, view.liveRevision, clearDraft, dispatchEvent]);

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
    if (refused !== null) {
      const seq = nextSeq();
      dispatchEvent({ type: 'submitted', seq });
      dispatchEvent({ type: 'rejected', seq, code: refused });
      return;
    }
    if (serialized === null || !serialized.ok) {
      const seq = nextSeq();
      dispatchEvent({ type: 'submitted', seq });
      dispatchEvent({
        type: 'rejected',
        seq,
        code: serialized === null ? 'no-grant' : serialized.code,
      });
      return;
    }
    const seq = nextSeq();
    dispatchEvent({ type: 'submitted', seq });
    // The baseline this dispatch writes against — the refresh's landing
    // is observed as the live revision moving off exactly it.
    awaitedBaselineRef.current = view.baselineRevision;
    try {
      const result = await session.applyEdit(serialized.plan);
      const settled = classifySettle(result);
      if (settled.kind === 'committed') {
        dispatchEvent({ type: 'committed', seq, revision: settled.revision });
        if (settled.nextGrantToken !== null) {
          holdGrant(session.ref, { token: settled.nextGrantToken });
        }
      } else {
        dispatchEvent({ type: 'rejected', seq, code: settled.code });
      }
    } catch (error) {
      const settled = classifySettle(error instanceof Error ? error : new Error('unknown'));
      if (settled.kind === 'conflict') {
        dispatchEvent({ type: 'conflict', seq, currentSha256: settled.currentSha256 });
      } else if (settled.kind === 'rejected') {
        dispatchEvent({ type: 'rejected', seq, code: settled.code });
      } else {
        dispatchEvent({ type: 'uncertain', seq });
      }
    }
    await refreshAfterSettle(seq);
  }

  /**
   * The post-settlement refresh: one macrotask ahead of the
   * invalidation so the settled phase renders first (a deterministic
   * act boundary in tests, one paint in production — a microtask would
   * batch the two states into one render and hide the commit), then
   * the generation-scoped content and routes keys invalidate — the
   * same discipline the SSE invalidation bridge drives. The loop holds
   * `refresh-required` until the refetch has completed: its landing
   * both reopens the draft on the new truth (when the revision moved)
   * and quiets the loop — an uncertain write whose file did not move
   * is answered by the same completion, never a hang.
   */
  async function refreshAfterSettle(seq: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    dispatchEvent({ type: 'refresh-begun', seq });
    await queryClient.invalidateQueries({ queryKey: session.queryKey('content') });
    await queryClient.invalidateQueries({ queryKey: session.queryKey('routes') });
    dispatchEvent({ type: 'refresh-landed', seq });
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
