import { useEffect, useRef } from 'react';
import type { CollectionEntryRecord, CollectionRecord } from '../../../core/collections';
import type { FormFieldNode } from '../../../core/form-tree';
import { MarkdownEditor } from '../../editor/markdown-editor';
import { useCollections, useContentSchema } from './api';
import { ContentForm } from './content-form';
import { useContentStore } from './store';
import { type ContentWriteStatus, useAutoWrite } from './use-auto-write';

/** The active entry's record in the payload — null when not found. */
function findActiveEntry(
  collections: CollectionRecord[] | undefined,
  active: { collection: string; entryId: string } | null,
): { collection: string; entry: CollectionEntryRecord } | null {
  if (active === null || collections === undefined) return null;
  const entry = collections
    .find((collection) => collection.name === active.collection)
    ?.entries.find((candidate) => candidate.id === active.entryId);
  if (entry === undefined) return null;
  return { collection: active.collection, entry };
}

/** The pane header's write-status text — empty where the loop is quiet. */
const WRITE_STATUS_TEXT: Record<ContentWriteStatus, string> = {
  loading: '',
  idle: '',
  pending: 'writing…',
  saved: 'written',
  stale: 'changed on disk — reloaded',
  error: 'write error',
};

interface PaneEditorProps {
  collection: string;
  entry: CollectionEntryRecord;
  fields: FormFieldNode[];
}

/**
 * The entry editor: the schema-generated form over the frontmatter with the
 * markdown body editor below. Each half reports through the pane's combined
 * draft refs (latest-callback semantics; nothing here re-renders the pane)
 * and the auto-write loop consumes them — debounce → serialize → whole-file
 * write (Impl #9); the loop's 409 reload remounts both halves from disk.
 */
function PaneEditor({ collection, entry, fields }: PaneEditorProps) {
  // refs, not state: a change in either half reports through the seam without
  // re-rendering the pane (each widget owns its own committed truth)
  const bodyRef = useRef(entry.body ?? '');
  const dataRef = useRef<unknown>(entry.data);
  const autoWrite = useAutoWrite({
    file: entry.filePath,
    data: entry.data,
    body: entry.body ?? '',
    fields,
  });

  const emit = (): void => {
    autoWrite.notify({ data: dataRef.current, body: bodyRef.current });
  };

  // the 409 reload's disk truth re-seeds the refs: the remounted form
  // re-reports its values on mount, the body editor never does — so the body
  // ref is set here, not left holding the dropped draft
  useEffect(() => {
    if (autoWrite.reload === null) return;
    dataRef.current = autoWrite.reload.data;
    bodyRef.current = autoWrite.reload.body;
  }, [autoWrite.reload]);

  // keyed by the reload seq: a 409 remounts both halves with the disk truth
  // (the typed edit is dropped — Impl #10; keeping it would be a one-line
  // form.reset onto the reload instead, not doctrine)
  const seq = autoWrite.reload?.seq ?? 0;
  const formData = autoWrite.reload?.data ?? entry.data;
  const formBody = autoWrite.reload?.body ?? entry.body;

  return (
    <div data-astroix-content-pane="form" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <code className="truncate text-muted-foreground">
          {collection}/{entry.id}
        </code>
        <span
          data-astroix-write-status={autoWrite.status}
          className={
            autoWrite.status === 'saved'
              ? 'text-emerald-400'
              : autoWrite.status === 'pending' || autoWrite.status === 'stale'
                ? 'text-amber-400'
                : autoWrite.status === 'error'
                  ? 'text-red-400'
                  : 'text-muted-foreground'
          }
        >
          {WRITE_STATUS_TEXT[autoWrite.status]}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContentForm
          key={seq}
          collection={collection}
          fields={fields}
          entryData={formData}
          onValuesChange={(values) => {
            dataRef.current = values;
            emit();
          }}
        />
      </div>
      <div className="flex h-[45%] min-h-0 shrink-0 flex-col border-t border-border">
        <MarkdownEditor
          key={seq}
          body={formBody}
          onChange={(markdown) => {
            bodyRef.current = markdown;
            emit();
          }}
        />
      </div>
    </div>
  );
}

/**
 * The Content vertical's editor pane (#72): the schema-generated form over
 * the active entry's frontmatter (#71's list click or route resolution sets
 * it). Inline validation runs debounced and on blur and never gates anything
 * (US11/US12) — the auto-write never checks those issues either; a
 * schema-breaking draft lands on disk, ~300ms after the pause (Impl #9).
 */
export function ContentEditorPane() {
  const { data: collections, isPending } = useCollections();
  const activeEntry = useContentStore((state) => state.activeEntry);

  // the host's mid-sync payload can come back empty — hold the last good
  // data instead of tearing the editor down under a dirty draft; only a
  // session that has NEVER seen data reads as the boot race's still-loading
  const lastCollectionsRef = useRef<CollectionRecord[] | null>(null);
  useEffect(() => {
    if (collections !== undefined && collections.length > 0) {
      lastCollectionsRef.current = collections;
    }
  }, [collections]);
  const hasCollections = collections !== undefined && collections.length > 0;
  const effectiveCollections = hasCollections ? collections : lastCollectionsRef.current;

  const picked = findActiveEntry(effectiveCollections ?? undefined, activeEntry);
  const { data: schema, isPending: schemaPending } = useContentSchema(picked?.collection ?? null);

  // boot race (content.spec.ts): the store sync can land after the server
  // starts listening — an empty payload reads as still-loading, not empty
  const syncing = isPending || effectiveCollections === null;

  if (syncing || picked === null) {
    return (
      <div
        data-astroix-content-pane={syncing ? 'syncing' : 'empty'}
        className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
      >
        {syncing
          ? 'Waiting for the content sync…'
          : 'No entry open — pick one in the Content list.'}
      </div>
    );
  }

  if (schemaPending || schema === undefined) {
    return (
      <div
        data-astroix-content-pane="syncing"
        className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
      >
        Walking the {picked.collection} schema…
      </div>
    );
  }

  // keyed by entry identity: switching entries remounts the editor with
  // fresh defaults instead of resetting a dirty draft under the user
  return (
    <PaneEditor
      key={`${picked.collection}/${picked.entry.id}`}
      collection={picked.collection}
      entry={picked.entry}
      fields={schema.fields}
    />
  );
}
