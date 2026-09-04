import type { ReactNode } from 'react';
import { useAppStore } from '../state/app-store.ts';
import { SessionInspection } from './session-inspection.tsx';
import { useShell } from './shell-context.ts';
import { ShellHeader } from './shell-header.tsx';
import { ShellStateMarker } from './shell-state-marker.tsx';
import { StreamState } from './stream-state.tsx';

/**
 * The app shell (#241, G2; CONTEXT.md "app shell"/"workbench row";
 * ADR-0002's layout law): the shell-owned frame — header, the session
 * status strip, and the workbench row (sidebar + editor dock + canvas)
 * — with STABLE FEATURE SLOTS for the verticals. The slots are named,
 * typed `ReactNode` props: neither vertical (CSS, content) is
 * implemented here, and no slot content is — the placeholders name
 * where each vertical's panel lands (the feature folder owns the
 * content; the canvas frame belongs to the shell, ADR-0002).
 */

/** The stable feature slots — one per workbench column, typed for the verticals to fill. */
export interface AppShellSlots {
  /** The sidebar's browsing panel (the active vertical's rules/entries list). */
  readonly sidebar?: ReactNode;
  /** The editor dock's pane (the active vertical's editor). */
  readonly editorDock?: ReactNode;
  /** The canvas (the same-origin project iframe's mount; the frame is shell-owned). */
  readonly canvas?: ReactNode;
}

/** One slot's placeholder — names the landing place, implements nothing. */
function SlotPlaceholder({ name }: { name: string }): ReactNode {
  return <p data-slot-placeholder={name}>slot: {name}</p>;
}

/**
 * The session-live render boundary — the cache law's render-side belt
 * (#399 over #372; ADR-0006 §5). TanStack guarantees a mounted query
 * observer its cache entry: every `useQuery` render re-builds a removed
 * query into the cache under its key (`getOptimisticResult` →
 * `QueryCache.build`). The reset's `remove-queries` step kills the
 * session-scoped cache — and the ADR-0006 law is that nothing re-mints
 * dead-session keys during teardown. The registry walk (#372) made the
 * violation concrete: its synchronous feature-store resets notify every
 * feature panel's subscriptions, and React's sync flush then re-renders
 * those panels after the reset — re-minting the dead pair's entries —
 * so the shell gates the query-holding surfaces (the slots' content and
 * the session inspection) on the shell stores' session binding: while
 * no session is bound, they render nothing, and a dead session's
 * re-renders cannot reach a `useSessionQuery` at all. The belt rides
 * the same binding the reset's `clear-stores` step drops — one
 * lifecycle truth with the stores it protects.
 */
function SessionLive({ children }: { readonly children: ReactNode }): ReactNode {
  const live = useAppStore((state) => state.session !== null);
  return live ? children : null;
}

/** The app shell frame: header, session status, workbench row with its three slots. */
export function AppShell({ slots = {} }: { readonly slots?: AppShellSlots }): ReactNode {
  const { role, commandError } = useShell();
  return (
    <div data-astroix-app-shell data-astroix-role={role}>
      <ShellHeader />
      <div data-astroix-session-status>
        <SessionLive>
          <SessionInspection />
        </SessionLive>
        <StreamState />
        <p data-testid="command-error" hidden={commandError === null}>
          {commandError ?? ''}
        </p>
        <ShellStateMarker />
      </div>
      <div data-astroix-workbench-row>
        <aside data-slot="sidebar">
          <SessionLive>{slots.sidebar ?? <SlotPlaceholder name="sidebar" />}</SessionLive>
        </aside>
        <section data-slot="editor-dock">
          <SessionLive>{slots.editorDock ?? <SlotPlaceholder name="editor-dock" />}</SessionLive>
        </section>
        <section data-slot="canvas">
          <SessionLive>{slots.canvas ?? <SlotPlaceholder name="canvas" />}</SessionLive>
        </section>
      </div>
    </div>
  );
}
