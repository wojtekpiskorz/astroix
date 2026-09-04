import type { ReactNode } from 'react';
import { EntryTree } from '../../../presentation/entry-tree.tsx';
import type { UnsupportedCollectionDiagnostic } from '../api.ts';
import { useContentDiscovery } from '../api.ts';
import { useContentNavigationStore } from '../navigation/navigation-store.ts';
import { useEntryNavigation } from '../navigation/use-entry-navigation.ts';
import { useDiscoveryStore } from './discovery-store.ts';

/**
 * The Content vertical's discovery panel (#251, J1): the workbench
 * sidebar's browsing surface — collections and entries from the E4
 * content inspection, the unrouted markers from the E5 routes payload,
 * and the entry clicks that navigate the same-origin canvas through the
 * navigation slice. Mounted by the host through the shell's sidebar
 * slot; consumes the ONE AppClient through `useShell()` (the
 * one-AppClient law, #332) and renders the presentation `EntryTree`
 * (the retained widget this feature is the host of).
 *
 * The panel's state vocabulary is the AC's own: structured loading,
 * empty, unsupported, and diagnostic states — each carrying its honest
 * text and nothing else. Raw paths never render: the discovery
 * projection (`api.ts`) carries names, ids, and sanitized diagnostic
 * codes only; `filePath` and entry interiors never reach the DOM.
 */

/** The unsupported-collections notice — `unsupported` whole-state or the `ready` rail. */
function UnsupportedCollections({
  diagnostics,
}: {
  readonly diagnostics: readonly UnsupportedCollectionDiagnostic[];
}): ReactNode {
  return (
    <div data-astroix-unsupported-collections>
      <h3 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
        Unsupported collections
      </h3>
      <ul className="flex flex-col gap-1">
        {diagnostics.map((diagnostic) => (
          <li
            key={diagnostic.collection}
            data-astroix-unsupported-collection={diagnostic.collection}
            className="rounded-sm bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive"
          >
            <span data-unsupported-code={diagnostic.collection}>{diagnostic.code}</span>{' '}
            <span>{diagnostic.collection}</span>
            <p className="text-muted-foreground">
              expected {diagnostic.expected}; observed {diagnostic.observed}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The last navigation attempt's feedback — the unrouted legend and the seam's refusals. */
function NavigationFeedbackSurface(): ReactNode {
  const feedback = useContentNavigationStore((state) => state.feedback);
  if (feedback.kind === 'none') return <p data-testid="navigation-feedback" hidden />;
  const text =
    feedback.kind === 'no-route'
      ? `no route renders ${feedback.entryId}`
      : feedback.kind === 'canvas-unavailable'
        ? 'the canvas is not available'
        : `navigated to ${feedback.url}`;
  return <p data-testid="navigation-feedback">{text}</p>;
}

/** The discovery panel — the sidebar slot's content. */
export function ContentDiscovery(): ReactNode {
  const discovery = useContentDiscovery();
  const navigation = useEntryNavigation(discovery);
  const collapsedFolders = useDiscoveryStore((state) => state.collapsedFolders);
  const toggleFolder = useDiscoveryStore((state) => state.toggleFolder);

  return (
    <div
      data-astroix-content-discovery
      data-discovery-status={discovery.status}
      className="flex min-h-0 flex-1 flex-col gap-2 pt-2"
    >
      {discovery.status === 'loading' && (
        <p data-testid="discovery-status" className="px-2 text-xs text-muted-foreground">
          discovering content…
        </p>
      )}
      {discovery.status === 'empty' && (
        <p data-testid="discovery-status" className="px-2 text-xs text-muted-foreground">
          this project declares no content collections
        </p>
      )}
      {discovery.status === 'unsupported' && (
        <>
          <p data-testid="discovery-status" className="px-2 text-xs text-muted-foreground">
            no supported content collections
          </p>
          <UnsupportedCollections diagnostics={discovery.diagnostics} />
        </>
      )}
      {discovery.status === 'diagnostic' && (
        <p
          data-testid="discovery-diagnostic"
          className="mx-2 rounded-sm bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {discovery.diagnosticMessage}
        </p>
      )}
      {discovery.status === 'ready' && (
        <>
          <EntryTree
            collections={discovery.listing}
            activeEntry={navigation.activeEntry}
            unroutedIds={discovery.unroutedIds}
            collapsedFolders={collapsedFolders}
            onToggleFolder={toggleFolder}
            onOpenEntry={navigation.openEntry}
          />
          {discovery.diagnostics.length > 0 && (
            <UnsupportedCollections diagnostics={discovery.diagnostics} />
          )}
        </>
      )}
      <NavigationFeedbackSurface />
    </div>
  );
}
