import { type ReactNode, useLayoutEffect, useState } from 'react';
import { useAppStore } from '../../state/app-store.ts';
import type { SelectionDescriptor } from '../../state/selection.ts';
import { observedRouteOf, useStylesInspection } from './api.ts';
import { type RecordIdentity, recordIdentityOf, resolveRecord } from './editing/resolve-record.ts';
import { selectedCanvasElement, subscribeCanvasMutations } from './inspection/canvas-element.ts';
import { matchedStyleRows } from './inspection/match-rows.ts';
import { CssRuleEditor } from './rule-editor.tsx';
import { RuleList } from './rule-list.tsx';
import { useCssInspectionStore } from './store.ts';
import { useCssAutoWrite } from './use-auto-write.ts';

/**
 * The CSS vertical's sidebar panel (#249, I1; the editing surface
 * joined at #250, I2): the styles slice for the OBSERVED route and
 * live selection, mounted by the host through the shell's sidebar slot
 * beside the Content vertical's discovery panel. It consumes the
 * shell's session-bound surfaces only — the ONE AppClient through
 * `useShell()` (inside `api.ts` and the auto-write loop), the app
 * store's live selection and observed canvas state, and the disclosed
 * canvas re-match seam — and renders the joined source/effective truth
 * for whatever element is selected on whatever route the canvas
 * observes.
 *
 * The selection lifecycle lands here as pure derivation: the rows
 * re-derive from (records × live element), so a style invalidation's
 * SSE-driven refetch re-matches them, the ordered reset clears the
 * store's selection (the panel falls to no-selection), an off-origin
 * canvas navigation clears it the same way, and a canvas DOM change
 * that no longer carries the element clears the list (the
 * missing-element state) — the mutation subscription re-derives on the
 * live document's own changes.
 *
 * The editing surface (#250): one row's edit gesture opens its rule in
 * the rule editor, addressed by SEMANTIC identity (file + selector +
 * media + range hint) so the write's own refresh — the served records
 * re-ranged by the landed splice — re-resolves the SAME rule instead
 * of losing it. The editor's every change schedules the grant-bound
 * auto-write loop; no path is ever selected or submitted.
 */

/** The panel's shared state surface — one root, one honest state word. */
function StatePanel({
  state,
  children,
}: {
  readonly state: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <p
      data-testid="css-rules-state"
      data-state={state}
      className="px-2 text-xs text-muted-foreground"
    >
      {children}
    </p>
  );
}

/** The CSS panel — the sidebar slot's styles surface. */
export function CssSidebar(): ReactNode {
  const selection = useAppStore((state) => state.selection);
  const canvas = useAppStore((state) => state.canvas);
  // The route source is the canvas's OBSERVED URL (the #374 ruling's
  // CSS-side consequence: this vertical never navigates — it reads the
  // observed route), and only while the canvas is on the project
  // origin (the fail-closed gate).
  const route = canvas !== null && canvas.origin === 'project' ? observedRouteOf(canvas.url) : null;

  return (
    <div
      data-astroix-css-sidebar
      data-testid="css-panel"
      className="flex min-h-0 flex-col gap-2 pt-2"
    >
      <h2 className="mb-1 px-2 text-xs font-semibold tracking-widest text-slate-500 uppercase">
        CSS
      </h2>
      {selection === null ? (
        <StatePanel state="no-selection">
          select an element in the canvas to see its rules
        </StatePanel>
      ) : route === null ? (
        <StatePanel state="no-route">the canvas is not on an inspectable project route</StatePanel>
      ) : (
        <CssRulesPanel descriptor={selection} route={route} />
      )}
    </div>
  );
}

/** The rules surface for one live selection on one observed route — mounts the styles query. */
function CssRulesPanel({
  descriptor,
  route,
}: {
  readonly descriptor: SelectionDescriptor;
  readonly route: string;
}): ReactNode {
  const inspection = useStylesInspection(route);
  const openRowKey = useCssInspectionStore((state) => state.openRowKey);
  const openRow = useCssInspectionStore((state) => state.openRow);
  const closeRow = useCssInspectionStore((state) => state.closeRow);
  // The editing target's semantic identity — the one piece of state the
  // write's own refresh must survive (a fresh record re-resolves, never
  // a lost editor), and the auto-write loop the editor schedules
  // through. A no-facts payload keeps the read list but opens no
  // editor: an un-enriched inspection is read-only truth.
  const [editing, setEditing] = useState<RecordIdentity | null>(null);
  const controls = useCssAutoWrite(inspection.payload);
  const payload = inspection.payload;
  const editingRecord =
    editing !== null && payload !== null ? resolveRecord(payload.records, editing) : null;
  const editingRaw = editing !== null ? (payload?.writeFacts.get(editing.file)?.raw ?? null) : null;

  // The live element through the disclosed re-match seam, held with the
  // descriptor it was found for (a descriptor change never renders the
  // previous element's rows). The canvas document's own mutations — an
  // HMR rebuild that drops or reshapes the selected element — re-find
  // through the same subscription (debounced inside the seam), so the
  // missing-element truth converges on the live document's own changes.
  // The find runs in a layout effect: the corrected state paints, never
  // an intermediate frame.
  const [found, setFound] = useState<{
    readonly descriptor: SelectionDescriptor;
    readonly element: Element | null;
  } | null>(null);
  useLayoutEffect(() => {
    const find = (): void => {
      setFound({ descriptor, element: selectedCanvasElement(descriptor) });
    };
    find();
    return subscribeCanvasMutations(find);
  }, [descriptor]);
  const element = found !== null && found.descriptor === descriptor ? found.element : null;

  if (element === null) {
    return (
      <StatePanel state="missing-element">
        the selected element is no longer in the canvas
      </StatePanel>
    );
  }
  if (inspection.status === 'loading') {
    return <StatePanel state="loading">inspecting styles…</StatePanel>;
  }
  if (inspection.status === 'unresolved-route') {
    return (
      <StatePanel state="unresolved-route">
        the observed canvas route resolves to no route
      </StatePanel>
    );
  }
  if (inspection.status === 'diagnostic') {
    return (
      <p
        data-testid="css-rules-diagnostic"
        className="mx-2 rounded-sm bg-destructive/10 px-2 py-1 text-xs text-destructive"
      >
        {inspection.diagnosticMessage}
      </p>
    );
  }
  const rows = matchedStyleRows(inspection.payload?.records ?? [], element);
  if (rows.length === 0) {
    return <StatePanel state="empty">no matching rules for this element</StatePanel>;
  }
  return (
    <>
      <RuleList
        rows={rows}
        openKey={openRowKey}
        onOpenDetail={(key) => {
          if (openRowKey === key) closeRow();
          else openRow(key);
        }}
        onEdit={
          payload !== null && payload.writeFacts.size > 0
            ? (row) => {
                setEditing(recordIdentityOf(row.record));
              }
            : undefined
        }
      />
      {editing !== null && editingRecord !== null && editingRaw !== null && (
        <CssRuleEditor
          key={`${editingRecord.file}#${editingRecord.range.start}`}
          record={editingRecord}
          raw={editingRaw}
          controls={controls}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
