import { useState } from 'react';
import type { CollectionRecord } from '../../../core/collections';
import type { ActiveEntry } from '../../../core/route-resolver';
import { MarkdownEditor } from '../../editor/markdown-editor';
import { useCollections } from './api';
import { useContentStore } from './store';

/** The active entry's body in the payload order — null when not found or body-less. */
function pickActiveBody(
  collections: CollectionRecord[] | undefined,
  active: ActiveEntry | null,
): { id: string; body: string } | null {
  if (active === null || collections === undefined) return null;
  const entry = collections
    .find((collection) => collection.name === active.collection)
    ?.entries.find((candidate) => candidate.id === active.entryId);
  if (entry === undefined || entry.body === null) return null;
  return { id: `${active.collection}/${entry.id}`, body: entry.body };
}

/**
 * The Content vertical's editor pane — the body editor on the active entry
 * (#71: list click or route resolution set it; #72's schema-generated form
 * takes the pane over from here). The emitted-markdown counter is this
 * slice's stand-in for the write status #74 mounts here.
 */
export function ContentEditorPane() {
  const { data, isPending } = useCollections();
  const activeEntry = useContentStore((state) => state.activeEntry);
  const [emittedLength, setEmittedLength] = useState<number | null>(null);

  // boot race (content.spec.ts): the store sync can land after the server
  // starts listening — an empty payload reads as still-loading, not empty
  const syncing = isPending || (data !== undefined && data.length === 0);
  const entry = pickActiveBody(data, activeEntry);

  if (syncing || entry === null) {
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

  const charCount = emittedLength ?? entry.body.length;
  return (
    <div data-astroix-content-pane="body" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <code className="truncate text-muted-foreground">{entry.id}</code>
        <span data-astroix-body-emitted={charCount} className="ml-auto text-muted-foreground">
          {charCount} chars
        </span>
      </div>
      <MarkdownEditor
        body={entry.body}
        onChange={(markdown) => setEmittedLength(markdown.length)}
      />
    </div>
  );
}
