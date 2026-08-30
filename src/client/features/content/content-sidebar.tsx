import { ChevronDown, ChevronRight, CircleOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { candidateRoutes, pickNavigableCandidate, resolveActiveEntry } from '../../../core/route-resolver';
import { useChromeStore } from '../../store';
import { toCollectionsIndex, useCollections, useRoutes } from './api';
import { useContentStore } from './store';

/**
 * The Content vertical's sidebar body: the collections→entries list with the
 * active entry highlighted (#71). Clicking an entry opens it (active entry,
 * manual) and — when route resolution yields a benign plurality (#109:
 * candidates that all forward-resolve to this entry) — navigates the canvas
 * through the most specific one, verified by forward match after the load.
 * The list renders as a tree (#111): folder structure derived from entry-id
 * path segments, entries with zero candidate routes carry a dimmed marker
 * (a legend for the navigation silence, never a behavior change).
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
 * Pure derivation from the collections payload — no endpoint or core change.
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

export function ContentSidebar() {
  const { data: collections, isPending: collectionsPending } = useCollections();
  const { data: routes, isPending: routesPending } = useRoutes();
  const canvasLoad = useChromeStore((state) => state.canvasLoad);
  const requestCanvasNav = useChromeStore((state) => state.requestCanvasNav);
  const activeEntry = useContentStore((state) => state.activeEntry);
  const collapsedFolders = useContentStore((state) => state.collapsedFolders);
  const toggleFolder = useContentStore((state) => state.toggleFolder);
  const selectEntry = useContentStore((state) => state.selectEntry);
  const armReverseVerify = useContentStore((state) => state.armReverseVerify);
  const applyCanvasResolution = useContentStore((state) => state.applyCanvasResolution);

  // Reactive selection (canvas→entry): every canvas load resolves the URL
  // against routes × collections. The effect re-runs on remounts and
  // refetches too — the store applies each load seq at most once, so only
  // actual loads resolve (a tab roundtrip never re-resolves an unchanged
  // URL). While this tab is unmounted the load signal stays live in the
  // app store; entering the tab resolves the current canvas position.
  useEffect(() => {
    if (canvasLoad === null || collections === undefined || routes === undefined) return;
    applyCanvasResolution(
      resolveActiveEntry(routes, canvasLoad.url, toCollectionsIndex(collections)),
      canvasLoad.seq,
    );
  }, [canvasLoad, collections, routes, applyCanvasResolution]);

  // boot race (content.spec.ts): the store sync can land after the server
  // starts listening — an empty payload reads as still-loading; routes gate
  // the list too, so entry clicks can always resolve their candidates
  const syncing =
    collectionsPending || routesPending || (collections !== undefined && collections.length === 0);

  if (syncing) {
    return (
      <div
        data-astroix-entries="pending"
        className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2 text-slate-500"
      >
        <p>Waiting for the content sync…</p>
      </div>
    );
  }

  const openEntry = (collection: string, entryId: string): void => {
    // manual pick first: the entry opens whatever navigation decides
    selectEntry({ collection, entryId });
    if (collections === undefined || routes === undefined) return;
    // an id held by two collections is ambiguity the resolver stays silent
    // on — no navigation, the entry just opened
    const holders = collections.filter((c) => c.entries.some((entry) => entry.id === entryId));
    if (holders.length !== 1) return;
    // benign plurality (#109): candidates that all forward-resolve to this
    // entry navigate through the most specific one — the load's forward
    // match verifies it (a miss keeps the manual pick); plurality to
    // different entries or no candidate at all stays silent
    const url = pickNavigableCandidate(entryId, routes, toCollectionsIndex(collections));
    if (url === null) return;
    armReverseVerify({ collection, entryId });
    requestCanvasNav(url);
  };

  const isActive = (collection: string, entryId: string): boolean =>
    activeEntry !== null &&
    activeEntry.collection === collection &&
    activeEntry.entryId === entryId;

  // zero candidate routes = no page follows this entry — the marker is the
  // legend for the click's silence, presentation only (never a disable)
  const unrouted = (entryId: string): boolean =>
    candidateRoutes(entryId, routes ?? []).length === 0;

  const renderFolder = (collection: string, folder: TreeFolder): ReactNode => {
    const folderKey = `${collection}/${folder.path}`;
    return (
      <FolderRow
        key={folderKey}
        folderKey={folderKey}
        name={folder.name}
        open={!collapsedFolders.has(folderKey)}
        onToggle={toggleFolder}
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
      active={isActive(collection, entryId)}
      unrouted={unrouted(entryId)}
      onOpen={openEntry}
    />
  );

  return (
    <div data-astroix-entries="ready" className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2">
      {collections?.map((collection) => {
        const tree = buildTree(collection.entries.map((entry) => entry.id));
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
