import type { ReactNode } from 'react';
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
 * where each vertical's panel lands (its feature folder owns the
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

/** The app shell frame: header, session status, workbench row with its three slots. */
export function AppShell({ slots = {} }: { readonly slots?: AppShellSlots }): ReactNode {
  const { role, commandError } = useShell();
  return (
    <div data-astroix-app-shell data-astroix-role={role}>
      <ShellHeader />
      <div data-astroix-session-status>
        <SessionInspection />
        <StreamState />
        <p data-testid="command-error" hidden={commandError === null}>
          {commandError ?? ''}
        </p>
        <ShellStateMarker />
      </div>
      <div data-astroix-workbench-row>
        <aside data-slot="sidebar">{slots.sidebar ?? <SlotPlaceholder name="sidebar" />}</aside>
        <section data-slot="editor-dock">
          {slots.editorDock ?? <SlotPlaceholder name="editor-dock" />}
        </section>
        <section data-slot="canvas">{slots.canvas ?? <SlotPlaceholder name="canvas" />}</section>
      </div>
    </div>
  );
}
