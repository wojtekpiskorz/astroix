import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { parse } from 'yaml';
import { jsonEqual, serializeEntry, splitEntryFile } from '../../../core/entry-writer';
import { collectImagePaths, type FormFieldNode } from '../../../core/form-tree';
import { fetchFileContents, sha256Hex } from '../../editor/api';
import { COLLECTIONS_KEY, postContentWrite } from './api';

const WRITE_DEBOUNCE_MS = 300;

export type ContentWriteStatus = 'loading' | 'idle' | 'pending' | 'saved' | 'stale' | 'error';

/** The 409 reload's disk truth — the pane remounts its halves on `seq`. */
export interface EntryReload {
  seq: number;
  data: unknown;
  body: string;
}

/** The pane's draft halves, as its emit path reports them. */
export interface AutoWriteDraft {
  data: unknown;
  body: string;
}

interface AutoWriteParams {
  /** The entry's payload filePath — the file the loop reads and writes. */
  file: string | null;
  /** The entry as loaded — the mount snapshot the diff runs against. */
  data: unknown;
  body: string;
  /** The walked tree — image() paths become the write's skip list. */
  fields: FormFieldNode[];
}

interface AutoWrite {
  status: ContentWriteStatus;
  reload: EntryReload | null;
  /** The pane's emit path calls this on every draft change. */
  notify: (draft: AutoWriteDraft) => void;
}

/**
 * The content auto-write loop (spec Impl #9, the CSS vertical's doctrine on
 * entry files): drafts debounced ~300ms, serialized whole-file by core's
 * entry-writer against the raw bytes this hook loaded, written through the
 * hash-guarded endpoint. The baseline is the write loop's own truth — what
 * it last established on disk (mount load, its writes, 409 reloads); payload
 * refetches never move it. A 409 reloads the pane from disk (Impl #10) —
 * unless the pane already shows the disk truth (an external change accepted
 * while clean), which then rebases silently.
 */
export function useAutoWrite({ file, data, body, fields }: AutoWriteParams): AutoWrite {
  const [status, setStatus] = useState<ContentWriteStatus>('loading');
  const [reload, setReload] = useState<EntryReload | null>(null);
  const queryClient = useQueryClient();

  // the mount snapshot (the pane is keyed per entry): payload refetches
  // change `data`/`body` identities, the diff baseline must not follow
  const baselineRef = useRef<AutoWriteDraft>({ data, body });
  const draftRef = useRef<AutoWriteDraft>({ data, body });
  const fieldsRef = useRef(fields);

  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  // the render→loop bridge: event-time ref writes only (render-time ref
  // writes don't survive React Compiler replay)
  const handleRef = useRef<((draft: AutoWriteDraft) => void) | null>(null);
  const notify = (draft: AutoWriteDraft): void => {
    draftRef.current = draft;
    handleRef.current?.(draft);
  };

  useEffect(() => {
    if (file === null) {
      setStatus('error');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queuedWhileLoading = false;
    let raw: string | null = null;
    let baseline = baselineRef.current;
    let chain: Promise<void> = Promise.resolve();
    let reloadSeq = 0;
    // the last meaningful badge (written / the reload banner): a duplicate
    // no-op emission — a remount's initial values re-arming the loop —
    // restores it instead of flashing the loop back to idle
    let badge: ContentWriteStatus = 'idle';

    const invalidateCollections = (): void => {
      void queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY });
    };

    // the write — always fires against the latest refs; the chain serializes
    // POSTs so a second write re-serializes against the rebased baseline
    // instead of racing its predecessor's hash
    const runWrite = async (): Promise<void> => {
      if (raw === null) return;
      const draft = draftRef.current;
      let next: string;
      try {
        next = serializeEntry({
          raw,
          baseline: { data: baseline.data, body: baseline.body },
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
        baselineRef.current = draft;
        badge = 'saved';
        setStatus('saved');
        invalidateCollections();
        return;
      }
      if (result.status === 'conflict' && result.contents !== null) {
        // JSON round-trip: the disk truth in the payload's projection (a
        // yaml date would otherwise leak a Date object into the baseline)
        let disk: AutoWriteDraft;
        try {
          const split = splitEntryFile(result.contents);
          const parsed = split.yaml === null ? {} : parse(split.yaml);
          disk = { data: JSON.parse(JSON.stringify(parsed)) ?? {}, body: split.body };
        } catch {
          setStatus('error');
          return;
        }
        raw = result.contents;
        baseline = disk;
        baselineRef.current = disk;
        invalidateCollections();
        if (jsonEqual(disk.data, draft.data) && disk.body === draft.body) {
          // the conflict's truth is what the pane already shows — an external
          // change accepted while clean; rebase silently, nothing to reload
          setStatus('idle');
          return;
        }
        reloadSeq += 1;
        setReload({ seq: reloadSeq, data: disk.data, body: disk.body });
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
        // edits raced the initial raw fetch — reconcile once it lands
        queuedWhileLoading = true;
        return;
      }
      schedule();
    };

    void (async () => {
      const contents = await fetchFileContents(file);
      if (cancelled) return;
      if (contents === null) {
        setStatus('error');
        return;
      }
      raw = contents;
      setStatus('idle');
      if (queuedWhileLoading) {
        queuedWhileLoading = false;
        schedule();
      }
    })();

    return () => {
      cancelled = true;
      handleRef.current = null;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [file, queryClient]);

  return { status, reload, notify };
}
