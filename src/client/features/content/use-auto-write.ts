import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  type EntryDraft,
  parseEntryDraft,
  sameDraft,
  serializeEntry,
} from '../../../core/entry-writer';
import { collectImagePaths, type FormFieldNode } from '../../../core/form-tree';
import { fetchFileContents, sha256Hex } from '../../editor/api';
import type { WriteStatus } from '../../editor/write-status-badge';
import { COLLECTIONS_KEY, postContentWrite } from './api';

const WRITE_DEBOUNCE_MS = 300;

/**
 * The entry's raw truth (#149): `parseEntryDraft`'s output — the file parse
 * the pane's halves mount on. The seq increments on every accepted change —
 * the mount read, a 409's disk reload, an external change accepted while
 * clean — and the pane keys its halves on it, so each bump remounts them
 * onto the new truth.
 */
export interface EntryTruth {
  seq: number;
  data: unknown;
  body: string;
}

interface AutoWriteParams {
  /** The entry's payload filePath — the file the loop reads and writes. */
  file: string | null;
  /** The walked tree — image() paths become the write's skip list. */
  fields: FormFieldNode[];
  /**
   * The payload's entry record, identity only (#149): a flip means the
   * refetched payload moved — the loop re-reads the file and compares
   * against its own truth instead of adopting the projection. The mount
   * flip never fires (the mount read below is the first truth).
   */
  payloadSignal: unknown;
}

interface AutoWrite {
  status: WriteStatus;
  /** The current raw truth — null until the mount read lands. */
  truth: EntryTruth | null;
  /** The pane's emit path calls this on every draft change. */
  notify: (draft: EntryDraft) => void;
}

/**
 * The content auto-write loop (spec Impl #9, the CSS vertical's doctrine on
 * entry files): drafts debounced ~300ms, serialized whole-file by core's
 * entry-writer against the raw bytes this hook loaded, written through the
 * hash-guarded endpoint. One truth-space (#149): the baseline, the draft and
 * the pane's halves all live in the raw file parse — the collections payload
 * never feeds them, its record identity is a change signal only. A 409
 * reloads the pane from disk (Impl #10) — unless the pane already shows the
 * disk truth (an external change accepted while clean), which then rebases
 * silently.
 */
export function useAutoWrite({ file, fields, payloadSignal }: AutoWriteParams): AutoWrite {
  const [status, setStatus] = useState<WriteStatus>('loading');
  const [truth, setTruth] = useState<EntryTruth | null>(null);
  const queryClient = useQueryClient();

  const draftRef = useRef<EntryDraft | null>(null);
  const fieldsRef = useRef(fields);
  const seqRef = useRef(0);

  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  // the render→loop bridges: event-time ref writes only (render-time ref
  // writes don't survive React Compiler replay)
  const handleRef = useRef<((draft: EntryDraft) => void) | null>(null);
  const reconcileRef = useRef<(() => void) | null>(null);
  const notify = (draft: EntryDraft): void => {
    draftRef.current = draft;
    handleRef.current?.(draft);
  };

  // the payload signal: an identity flip (the refetch landed) asks the loop
  // to reconcile from the file — echoes rebase silently, a genuine change
  // under a clean draft becomes the new truth, a dirty draft is left to the
  // hash guard
  const prevSignalRef = useRef(payloadSignal);
  useEffect(() => {
    if (prevSignalRef.current === payloadSignal) return;
    prevSignalRef.current = payloadSignal;
    reconcileRef.current?.();
  }, [payloadSignal]);

  useEffect(() => {
    if (file === null) {
      setStatus('error');
      return;
    }
    // publishes a truth — the seq is monotonic across effect re-runs
    // (StrictMode): a repeated mount read must still remount the halves,
    // never collide with a live seq
    const setEntryTruth = (draft: EntryDraft): void => {
      seqRef.current += 1;
      setTruth({ seq: seqRef.current, data: draft.data, body: draft.body });
    };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queuedWhileLoading = false;
    // the baseline is born with the mount read below and never survives an
    // effect re-run: within a pane lifetime `file` and `queryClient` (the
    // deps) are both stable, and StrictMode's first pass is cancelled
    // before its writes land — so there is nothing to carry across runs
    let raw: string | null = null;
    let baseline: EntryDraft | null = null;
    let chain: Promise<void> = Promise.resolve();
    // the last meaningful badge (written / the reload banner): a duplicate
    // no-op emission — a remount's initial values re-arming the loop —
    // restores it instead of flashing the loop back to idle
    let badge: WriteStatus = 'idle';

    const invalidateCollections = (): void => {
      void queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
    };

    // the write — always fires against the latest refs; the chain serializes
    // POSTs so a second write re-serializes against the rebased baseline
    // instead of racing its predecessor's hash
    const runWrite = async (): Promise<void> => {
      if (raw === null || baseline === null) return;
      const draft = draftRef.current;
      if (draft === null) return;
      let next: string;
      try {
        next = serializeEntry({
          raw,
          baseline,
          draft,
          protectedPaths: collectImagePaths(fieldsRef.current),
        });
      } catch {
        setStatus('error');
        return;
      }
      if (next === raw) {
        setStatus(badge);
        return;
      }
      const result = await postContentWrite({
        file,
        contents: next,
        expected: await sha256Hex(raw),
      });
      if (cancelled) return;
      if (result.status === 'written') {
        raw = next;
        baseline = draft;
        badge = 'saved';
        setStatus('saved');
        invalidateCollections();
        return;
      }
      if (result.status === 'conflict' && result.contents !== null) {
        const disk = parseEntryDraft(result.contents);
        if (disk === null) {
          setStatus('error');
          return;
        }
        raw = result.contents;
        baseline = disk;
        invalidateCollections();
        if (sameDraft(disk, draft)) {
          // the conflict's truth is what the pane already shows — an external
          // change accepted while clean; rebase silently, nothing to reload.
          // One truth-space makes the compare honest: the draft and the disk
          // parse skip the zod pass together, defaults and all.
          setStatus('idle');
          return;
        }
        // the typed edit is dropped (Impl #10): the remount re-reports from
        // the disk truth, and the refs follow it now — a pending timer
        // between here and the mount emission would otherwise write the
        // dropped draft back
        draftRef.current = disk;
        setEntryTruth(disk);
        badge = 'stale';
        setStatus('stale');
        return;
      }
      setStatus('error');
    };

    const schedule = (): void => {
      setStatus('pending');
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        chain = chain
          .then(() => runWrite())
          .catch(() => {
            if (!cancelled) setStatus('error');
          });
      }, WRITE_DEBOUNCE_MS);
    };

    handleRef.current = () => {
      if (raw === null) {
        // edits raced the mount read — reconcile once it lands
        queuedWhileLoading = true;
        return;
      }
      schedule();
    };

    reconcileRef.current = () => {
      if (raw === null || baseline === null) return;
      const startedFrom = raw;
      void (async () => {
        const contents = await fetchFileContents(file);
        if (cancelled || contents === null) return;
        // a write or reload moved the baseline while this read was in
        // flight — the signal it answers is already stale
        if (raw !== startedFrom) return;
        const parsed = parseEntryDraft(contents);
        if (parsed === null) return;
        if (sameDraft(parsed, baseline)) {
          // the loop's own echo coming back through the payload — the hash
          // baseline rebases (bytes may still differ: comments), the truth
          // does not move and nothing remounts
          raw = contents;
          return;
        }
        const draft = draftRef.current;
        if (draft === null || !sameDraft(draft, baseline)) {
          // dirty — the write loop's hash guard reconciles on the next write
          return;
        }
        raw = contents;
        baseline = parsed;
        draftRef.current = parsed;
        setEntryTruth(parsed);
      })();
    };

    void (async () => {
      const contents = await fetchFileContents(file);
      if (cancelled) return;
      if (contents === null) {
        setStatus('error');
        return;
      }
      const parsed = parseEntryDraft(contents);
      if (parsed === null) {
        setStatus('error');
        return;
      }
      raw = contents;
      baseline = parsed;
      // a draft that raced the mount read (an effect re-run's emission)
      // stays — the queue flag below reconciles it once raw lands
      if (!queuedWhileLoading) draftRef.current = parsed;
      setStatus('idle');
      setEntryTruth(parsed);
      if (queuedWhileLoading) {
        queuedWhileLoading = false;
        schedule();
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current = null;
      reconcileRef.current = null;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [file, queryClient]);

  return { status, truth, notify };
}
