import { ChevronDown, ChevronRight, CircleOff } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActiveEntryView, CollectionListingView } from './types';

/**
 * The Content vertical's entry tree (#219, lane C2): the collections →
 * entries list extracted from the integration-era content sidebar as a
 * prop-driven widget. The tree (nested ids under folders, flat ids bare,
 * #111), the active-entry highlight, and the unrouted-entry marker (#109 —
 * a legend for the click's navigational silence, never a behavior change)
 * all render from props; the queries, route resolution, canvas navigation,
 * and folder state stay with the host.
 */

/** A folder in the entry tree: collection-relative path key, basename label. */
interface TreeFolder {
  /** Path relative to the collection, e.g. '2024' or '2025/news'. */
  path: string;
  /** Display label: the path's last segment. */
  name: string;
  folders: TreeFolder[];
  /** Full entry ids filed directly under this folder (basename-labeled). */
  entries: string[];
}

/** A collection's entries as the sidebar tree: nested ids under folders, flat ids bare. */
interface CollectionTree {
  rootEntries: string[];
  folders: TreeFolder[];
}

/**
 * Derives the presentation tree from entry ids (#111): each '/'-separated
 * prefix of a nested id is a folder, the id's basename is the entry label.
 * Pure derivation from the collections listing — no endpoint or core change.
 */
function buildTree(entryIds: ReadonlyArray<string>): CollectionTree {
  const tree: CollectionTree = { rootEntries: [], folders: [] };
  for (const id of entryIds) {
    const segments = id.split('/');
    if (segments.length === 1) {
      tree.rootEntries.push(id);
      continue;
    }
    let children = tree.folders;
    let folder: TreeFolder | undefined;
    for (const segment of segments.slice(0, -1)) {
      const path = folder === undefined ? segment : `${folder.path}/${segment}`;
      let next = children.find((candidate) => candidate.path === path);
      if (next === undefined) {
        next = { path, name: segment, folders: [], entries: [] };
        children.push(next);
      }
      folder = next;
      children = next.folders;
    }
    folder?.entries.push(id);
  }
  return tree;
}

/** One entry row: full id as the test hook, basename as the label (#111). */
function EntryRow(props: {
  collection: string;
  entryId: string;
  active: boolean;
  unrouted: boolean;
  onOpen: (collection: string, entryId: string) => void;
}) {
  const label = props.entryId.split('/').at(-1) ?? props.entryId;
  return (
    <li>
      <button
        type="button"
        data-astroix-entry={props.entryId}
        data-active={props.active ? 'true' : 'false'}
        aria-current={props.active ? 'true' : undefined}
        data-astroix-entry-unrouted={props.unrouted ? 'true' : undefined}
        title={props.unrouted ? 'no route renders this entry' : undefined}
        onClick={() => props.onOpen(props.collection, props.entryId)}
        className={`w-full rounded-sm px-2 py-1 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground ${
          props.active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
        }`}
      >
        {label}
        {props.unrouted && <CircleOff aria-hidden className="ml-1 inline size-3 opacity-50" />}
      </button>
    </li>
  );
}

/** One folder row: the collapse toggle plus its children while open (#111). */
function FolderRow(props: {
  folderKey: string;
  name: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: ReactNode;
}) {
  const Chevron = props.open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        type="button"
        data-astroix-tree-folder={props.folderKey}
        aria-expanded={props.open ? 'true' : 'false'}
        onClick={() => props.onToggle(props.folderKey)}
        className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Chevron aria-hidden className="size-3 shrink-0" />
        {props.name}
      </button>
      {props.open && <ul className="ml-3 flex flex-col">{props.children}</ul>}
    </li>
  );
}

interface EntryTreeProps {
  /** The collections listing (inspection data): names and served-order entry ids. */
  collections: readonly CollectionListingView[];
  /** The open entry (selection state) — its row highlights. */
  activeEntry: ActiveEntryView | null;
  /**
   * Entry ids no route actually renders (route state, presentation-only
   * here): the unrouted marker's truth, computed by the host from the
   * routes payload (CONTEXT.md: unrouted entry).
   */
  unroutedIds: ReadonlySet<string>;
  /** Tree folders rendered collapsed (#111), keyed by collection-scoped path. */
  collapsedFolders: ReadonlySet<string>;
  /** Presentation-only state intent: toggle one tree folder. */
  onToggleFolder: (key: string) => void;
  /** Edit intent: an entry row's click opens the entry. */
  onOpenEntry: (collection: string, entryId: string) => void;
}

export function EntryTree({
  collections,
  activeEntry,
  unroutedIds,
  collapsedFolders,
  onToggleFolder,
  onOpenEntry,
}: EntryTreeProps) {
  const renderFolder = (collection: string, folder: TreeFolder): ReactNode => {
    const folderKey = `${collection}/${folder.path}`;
    return (
      <FolderRow
        key={folderKey}
        folderKey={folderKey}
        name={folder.name}
        open={!collapsedFolders.has(folderKey)}
        onToggle={onToggleFolder}
      >
        {folder.folders.map((child) => renderFolder(collection, child))}
        {folder.entries.map((entryId) => renderEntry(collection, entryId))}
      </FolderRow>
    );
  };

  // one row shape for every nesting depth — the full id stays the click contract
  const renderEntry = (collection: string, entryId: string): ReactNode => (
    <EntryRow
      key={entryId}
      collection={collection}
      entryId={entryId}
      active={
        activeEntry !== null &&
        activeEntry.collection === collection &&
        activeEntry.entryId === entryId
      }
      unrouted={unroutedIds.has(entryId)}
      onOpen={onOpenEntry}
    />
  );

  return (
    <div data-astroix-entries="ready" className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2">
      {collections.map((collection) => {
        const tree = buildTree(collection.entryIds);
        return (
          <section key={collection.name} data-astroix-collection={collection.name}>
            <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
              {collection.name}
            </h2>
            <ul className="flex flex-col">
              {tree.folders.map((folder) => renderFolder(collection.name, folder))}
              {tree.rootEntries.map((entryId) => renderEntry(collection.name, entryId))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
