import { useEffect, useRef, useState } from 'react';
import type { CollectionEntryRecord, CollectionRecord } from '../../../core/collections';
import type { FormFieldNode } from '../../../core/form-tree';
import { MarkdownEditor } from '../../editor/markdown-editor';
import { WriteStatusBadge } from '../../editor/write-status-badge';
import { useCollections, useContentSchema } from './api';
import { ContentForm } from './content-form';
import { useContentStore } from './store';
import { type EntryReload, useAutoWrite } from './use-auto-write';

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

  // the 409 reload's snapshot, held locally so it can expire: the loop's
  // invalidation refetches the collections payload, and the next entry
  // identity is the same disk truth in the payload's own projection (zod
  // defaults included) — handing the halves back to it un-freezes the echo
  // guards and repairs fields the raw parse could not fill
  const [diskReload, setDiskReload] = useState<EntryReload | null>(null);
  const [remountSeq, setRemountSeq] = useState(0);
  useEffect(() => {
    if (autoWrite.reload === null) return;
    setDiskReload(autoWrite.reload);
    setRemountSeq((seq) => seq + 1);
  }, [autoWrite.reload]);
  // the snapshot expires with the payload generation, adjusted during
  // render — entry.data's identity is the object the refetch rebuilt; the
  // entry record around it re-renders more often
  const payloadGenRef = useRef(entry.data);
  if (payloadGenRef.current !== entry.data) {
    payloadGenRef.current = entry.data;
    setDiskReload(null);
  }

  const emit = (): void => {
    autoWrite.notify({ data: dataRef.current, body: bodyRef.current });
  };

  // the reload's disk truth re-seeds the refs: the remounted form re-reports
  // its values on mount, the body editor never does — so the body ref is set
  // here, not left holding the dropped draft
  useEffect(() => {
    if (diskReload === null) return;
    dataRef.current = diskReload.data;
    bodyRef.current = diskReload.body;
  }, [diskReload]);

  // keyed by the remount seq: a 409 remounts both halves with the disk truth
  // (the typed edit is dropped — Impl #10; keeping it would be a one-line
  // form.reset onto the reload instead, not doctrine)
  const formData = diskReload?.data ?? entry.data;
  const formBody = diskReload?.body ?? entry.body;

  return (
    <div data-astroix-content-pane="form" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <code className="truncate text-muted-foreground">
          {collection}/{entry.id}
        </code>
        <WriteStatusBadge status={autoWrite.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContentForm
          key={remountSeq}
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
          key={remountSeq}
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
