import { useState } from 'react';
import type { CollectionRecord } from '../../../core/collections';
import { MarkdownEditor } from '../../editor/markdown-editor';
import { useCollections } from './api';

/** The payload's own order (server sorts names, then ids) walks collections→entries. */
function pickBodyEntry(collections: CollectionRecord[] | undefined): {
  id: string;
  body: string;
} | null {
  for (const collection of collections ?? []) {
    for (const entry of collection.entries) {
      if (entry.body !== null) return { id: `${collection.name}/${entry.id}`, body: entry.body };
    }
  }
  return null;
}

/**
 * The Content vertical's editor pane — a placeholder owner of the body editor
 * until #72's schema-generated form takes the pane over: with the real
 * selection paths (#71: list click, route resolution) not landed yet, it
 * deterministically edits the first body-bearing entry. The emitted-markdown
 * counter is this slice's stand-in for the write status #74 mounts here.
 */
export function ContentEditorPane() {
  const { data, isPending } = useCollections();
  const [emittedLength, setEmittedLength] = useState<number | null>(null);

  // boot race (content.spec.ts): the store sync can land after the server
  // starts listening — an empty payload reads as still-loading, not empty
  const syncing = isPending || (data !== undefined && data.length === 0);
  const entry = pickBodyEntry(data);

  if (syncing || entry === null) {
    return (
      <div
        data-astroix-content-pane={syncing ? 'syncing' : 'empty'}
        className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
      >
        {syncing
          ? 'Waiting for the content sync…'
          : 'No entry with a body found — the entries list lands with #71.'}
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
