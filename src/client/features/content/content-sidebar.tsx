import { useEffect } from 'react';
import { EntryTree } from '../../../../packages/app-shell/src/presentation/entry-tree';
import {
  hasCandidateRoutes,
  pickNavigableCandidate,
  resolveActiveEntry,
} from '../../../core/route-resolver';
import { useChromeStore } from '../../store';
import { toCollectionsIndex, useCollections, useRoutes } from './api';
import { useContentStore } from './store';

/**
 * The Content vertical's sidebar body — now the integration-era adapter over
 * the moved entry tree (#219, ADR-0010): the queries, the canvas→entry
 * resolution effect, and the click's candidate-route navigation stay here;
 * the tree, the active-entry highlight, and the unrouted markers render from
 * the prop-driven widget. Clicking an entry opens it (active entry, manual)
 * and — when route resolution yields a benign plurality (#109: candidates
 * that all forward-resolve to this entry) — navigates the canvas through the
 * most specific one, verified by forward match after the load.
 */

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
      canvasLoad,
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
    armReverseVerify(url);
    requestCanvasNav(url);
  };

  // zero candidate routes = no page follows this entry — the marker is the
  // legend for the click's silence, presentation only (never a disable)
  const unroutedIds = new Set<string>();
  for (const collection of collections ?? []) {
    for (const entry of collection.entries) {
      if (!hasCandidateRoutes(entry.id, routes ?? [])) unroutedIds.add(entry.id);
    }
  }

  return (
    <EntryTree
      collections={(collections ?? []).map((collection) => ({
        name: collection.name,
        entryIds: collection.entries.map((entry) => entry.id),
      }))}
      activeEntry={activeEntry}
      unroutedIds={unroutedIds}
      collapsedFolders={collapsedFolders}
      onToggleFolder={toggleFolder}
      onOpenEntry={openEntry}
    />
  );
}
