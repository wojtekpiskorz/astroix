import { useEffect } from 'react';
import { candidateRoutes, resolveActiveEntry } from '../../../core/route-resolver';
import { useChromeStore } from '../../store';
import { toCollectionsIndex, useCollections, useRoutes } from './api';
import { useContentStore } from './store';

/**
 * The Content vertical's sidebar body: the collections→entries list with the
 * active entry highlighted (#71). Clicking an entry opens it (active entry,
 * manual) and — when route resolution yields exactly one candidate route —
 * navigates the canvas there, verified by forward match after the load.
 */
export function ContentSidebar() {
  const { data: collections, isPending: collectionsPending } = useCollections();
  const { data: routes, isPending: routesPending } = useRoutes();
  const canvasLoad = useChromeStore((state) => state.canvasLoad);
  const requestCanvasNav = useChromeStore((state) => state.requestCanvasNav);
  const activeEntry = useContentStore((state) => state.activeEntry);
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
    // unique-hit-or-silent: exactly one candidate route navigates, then the
    // load's forward match verifies it (a miss keeps the manual pick)
    const candidates = candidateRoutes(entryId, routes);
    const [candidate] = candidates;
    if (candidate === undefined || candidates.length !== 1) return;
    armReverseVerify({ collection, entryId });
    requestCanvasNav(candidate.url);
  };

  return (
    <div data-astroix-entries="ready" className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2">
      {collections?.map((collection) => (
        <section key={collection.name} data-astroix-collection={collection.name}>
          <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
            {collection.name}
          </h2>
          <ul className="flex flex-col">
            {collection.entries.map((entry) => {
              const active =
                activeEntry !== null &&
                activeEntry.collection === collection.name &&
                activeEntry.entryId === entry.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-astroix-entry={entry.id}
                    data-active={active ? 'true' : 'false'}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => openEntry(collection.name, entry.id)}
                    className={`w-full rounded-sm px-2 py-1 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground ${
                      active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {entry.id}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
