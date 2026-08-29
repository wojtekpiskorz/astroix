import { useEffect, useRef } from 'react';
import type { CollectionEntryRecord, CollectionRecord } from '../../../core/collections';
import type { FormFieldNode } from '../../../core/form-tree';
import { MarkdownEditor } from '../../editor/markdown-editor';
import { useCollections, useContentSchema } from './api';
import { ContentForm } from './content-form';
import { useContentStore } from './store';

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

/** The draft the pane emits — the seam #74's auto-write loop wires into. */
export interface ContentDraft {
  collection: string;
  id: string;
  data: unknown;
  body: string;
}

interface PaneEditorProps {
  collection: string;
  entry: CollectionEntryRecord;
  fields: FormFieldNode[];
  onDraftChange: (draft: ContentDraft) => void;
}

/**
 * The entry editor: the schema-generated form over the frontmatter with the
 * markdown body editor below. Each half reports through the pane's combined
 * draft seam (latest-callback ref — render-time ref writes don't survive
 * React Compiler replay); nothing here touches disk.
 */
function PaneEditor({ collection, entry, fields, onDraftChange }: PaneEditorProps) {
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);

  // refs, not state: a change in either half emits through the seam without
  // re-rendering the pane (each widget owns its own committed truth)
  const bodyRef = useRef(entry.body ?? '');
  const dataRef = useRef<unknown>(entry.data);
  const emit = (): void => {
    onDraftChangeRef.current({
      collection,
      id: entry.id,
      data: dataRef.current,
      body: bodyRef.current,
    });
  };

  return (
    <div data-astroix-content-pane="form" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <code className="truncate text-muted-foreground">
          {collection}/{entry.id}
        </code>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContentForm
          collection={collection}
          fields={fields}
          entryData={entry.data}
          onValuesChange={(values) => {
            dataRef.current = values;
            emit();
          }}
        />
      </div>
      <div className="flex h-[45%] min-h-0 shrink-0 flex-col border-t border-border">
        <MarkdownEditor
          body={entry.body}
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
 * (US11/US12) — there is no save to gate here.
 */
export function ContentEditorPane({
  onDraftChange,
}: {
  onDraftChange?: (draft: ContentDraft) => void;
} = {}) {
  const { data: collections, isPending } = useCollections();
  const activeEntry = useContentStore((state) => state.activeEntry);
  const picked = findActiveEntry(collections, activeEntry);
  const { data: schema, isPending: schemaPending } = useContentSchema(picked?.collection ?? null);

  // boot race (content.spec.ts): the store sync can land after the server
  // starts listening — an empty payload reads as still-loading, not empty
  const syncing = isPending || (collections !== undefined && collections.length === 0);

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
      onDraftChange={onDraftChange ?? (() => {})}
    />
  );
}
