import type { ProjectKey, SessionRef } from '@wojciechpiskorz/astroix-protocol';
import {
  captureMenuAction,
  executeMenuAction,
  type MenuActionEnvelope,
  type MenuActionRejection,
} from '@wojciechpiskorz/astroix-runtime/session-supervisor/clients';
import type { GrantedProjectSummary } from './child-protocol.ts';

/**
 * The native application menu (#243, H1; ADR-0006 §5 "Menu actions
 * capture the `SessionRef` visible at creation and reject if stale at
 * execution"; ADR-0004 "Add Existing Project... is a native Electron
 * action"; #362 H7's activation entries): a pure template builder plus
 * a dispatcher that re-checks the session currency at click time
 * through F4's menu-action envelope (`session-supervisor/clients/
 * menu-actions.ts` — the runtime's own vocabulary, consumed read-only,
 * never mirrored).
 *
 * The capture is frozen at BUILD time — the template is rebuilt whenever
 * the session currency changes, so a menu built against project A and
 * clicked after an A→B switch is rejected as `stale-session` without
 * executing. The action ids are this module's own vocabulary; the seam
 * adapter maps them to real menu items and reports clicks back through
 * {@link dispatchMenuAction}.
 *
 * The activation surface (#362, #367): one `Activate <project>` item per
 * REGISTERED project — the native registration flow's sanitized
 * summaries AND the boot-time registry listing's (the registry persists
 * across launches; the second launch's menu is built from it), enabled
 * while no session is active — the activation is an idle-state
 * transition (ADR-0006 §4); a switch happens after a deactivate, never
 * through a concurrently-enabled activate item.
 */

/** The closed native action vocabulary — the seam carries these ids, nothing else. */
export type NativeMenuActionId = 'add-existing-project' | 'activate' | 'deactivate' | 'quit';

/** One template item — a plain descriptor the Electron seam adapts (no Electron types cross this boundary). */
export interface NativeMenuItem {
  readonly label: string;
  readonly accelerator?: string;
  readonly enabled?: boolean;
  /** Renders as a separator (label ignored). */
  readonly separator?: boolean;
  /** The action id reported back on click; a display-only item carries none. */
  readonly actionId?: NativeMenuActionId;
  /** The activation target — the project key an `activate` item names. */
  readonly projectKey?: ProjectKey;
}

/** One top-level menu (a labeled section) — the seam renders each as a submenu. */
export interface NativeMenuSection {
  readonly label: string;
  readonly items: readonly NativeMenuItem[];
}

/** The built menu: the sectioned template plus the currency capture frozen at build time. */
export interface NativeMenuDeclarations {
  readonly sections: readonly NativeMenuSection[];
  /** The deactivate capture — the `SessionRef` visible at menu creation (absent when no session was active). */
  readonly deactivateCapture: MenuActionEnvelope | null;
}

/**
 * Builds the application menu against the session visible now: the
 * product menu (About/Quit — Quit routes the host's quit transition,
 * never Electron's bare quit role), the native project registration
 * entry point, the per-project activation entries (#362 — the
 * composition's native surface, enabled only while no session is
 * active), and the session-scoped deactivate item — enabled only while
 * a session is active, capturing its reference.
 */
export function buildApplicationMenu(
  currentSessionRef: SessionRef | null,
  registeredProjects: readonly GrantedProjectSummary[] = [],
): NativeMenuDeclarations {
  const hasSession = currentSessionRef !== null;
  const activateItems: NativeMenuItem[] = registeredProjects.map((project) => ({
    label: `Activate ${project.displayName}`,
    enabled: !hasSession,
    actionId: 'activate' as const,
    projectKey: project.projectKey,
  }));
  return {
    sections: [
      {
        label: 'Astroix',
        items: [
          { label: 'About Astroix' },
          { label: '', separator: true },
          { label: 'Quit Astroix', accelerator: 'CmdOrCtrl+Q', actionId: 'quit' },
        ],
      },
      {
        label: 'File',
        items: [
          {
            label: 'Add Existing Project…',
            accelerator: 'CmdOrCtrl+O',
            actionId: 'add-existing-project',
          },
        ],
      },
      {
        label: 'Session',
        items: [
          ...(activateItems.length > 0 ? [...activateItems, { label: '', separator: true }] : []),
          {
            label: 'Deactivate Project',
            enabled: hasSession,
            actionId: 'deactivate',
          },
        ],
      },
    ],
    deactivateCapture: hasSession
      ? captureMenuAction({ sessionRef: currentSessionRef, action: 'deactivate' })
      : null,
  };
}

/** What the host does with a dispatched menu action. */
export interface NativeMenuActions {
  addExistingProject(): void;
  activate(projectKey: ProjectKey): void;
  deactivate(sessionRef: SessionRef): void;
  quit(): void;
  /** Surfaces one rejected action — the stale/currency law's honest outcome, never a silent no-op. */
  menuActionRejected(reason: MenuActionRejection): void;
}

/**
 * Dispatches one menu click: the captured envelope is re-checked against
 * the CURRENT session — an exact epoch+generation match executes, no
 * active session or any drift rejects (ADR-0006 §5). A display-only item
 * (`actionId` absent) is a no-op. The activation items carry their
 * project key at build time and the click reports it back — the dispatch
 * never guesses a target.
 */
export function dispatchMenuAction(
  declarations: NativeMenuDeclarations,
  actionId: NativeMenuActionId,
  currentSessionRef: SessionRef | null,
  actions: NativeMenuActions,
  projectKey?: ProjectKey,
): void {
  if (actionId === 'add-existing-project') {
    actions.addExistingProject();
    return;
  }
  if (actionId === 'quit') {
    actions.quit();
    return;
  }
  if (actionId === 'activate') {
    // The currency law for an IDLE-state transition is the item's own
    // captured target: a session that began since the menu was built
    // refuses here, and the composition's concurrent-activation law is
    // the control plane's.
    if (projectKey === undefined) return; // a drifted click with no target — never a guess
    actions.activate(projectKey);
    return;
  }
  const envelope = declarations.deactivateCapture;
  if (envelope === null) {
    // Clicked with no capture: the item was built while no session was
    // active (and renders disabled); the currency law still answers.
    actions.menuActionRejected('no-active-session');
    return;
  }
  const verdict = executeMenuAction(envelope, currentSessionRef);
  if (verdict.kind === 'accepted') {
    actions.deactivate(verdict.sessionRef);
    return;
  }
  actions.menuActionRejected(verdict.reason);
}
