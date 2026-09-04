/**
 * `@wojciechpiskorz/astroix-app-shell/shell` — the rebuilt app shell
 * (#241, G2): the shell frame and provider composed over the ONE
 * AppClient at generation-scoped state — the role capability table,
 * the session-gated shell stores, the generation-scoped query discipline,
 * and the one ordered reset the transition-commit path executes — plus
 * the shell-owned natural-route canvas (#242, G3) and its selection
 * identity. The surface for renderer hosts (the web host's project
 * document today, the Electron renderer later); the domain-deaf
 * foundation barrel (`.` — negative-pinned) and the retained
 * `./presentation` widgets are untouched by it.
 *
 * Canvas internals stay INSIDE the package: the rule walk
 * (`canvas/canvas-rules.ts`) has no consumer beyond the canvas itself —
 * the one-consumer rule keeps it off this barrel. The disclosed seam
 * for the CSS vertical is `matchedSelectors` (the shared matching law)
 * plus the selection identity, exported below.
 *
 * The Content vertical's discovery panel (J1, #251) is exported for the
 * hosts' sidebar slots — a feature consuming this shell (useShell +
 * the generation-scoped query discipline), never a part of it.
 */

export { ProjectCanvas, type ProjectCanvasProps } from '../canvas/project-canvas';
export { ContentDiscovery } from '../features/content/discovery/content-discovery';
export { gatedSessionFetch, StaleSessionResultError } from '../query/gated-session-fetch';
export { type GatedEventCallbacks, gatedSseHandlers } from '../query/session-events';
export {
  isSessionQueryKey,
  removeSessionQueries,
  sessionQueryCount,
} from '../query/session-query-cache';
export { createShellQueryClient } from '../query/shell-query-client';
export {
  capabilitiesOf,
  ROLE_CAPABILITIES,
  roleCan,
  SHELL_CAPABILITIES,
  type ShellCapability,
  type ShellRole,
  shellRoleFromServerRole,
} from '../roles/capabilities';
export {
  type ActiveEntry,
  type CanvasOriginState,
  type CanvasSessionState,
  type ShellSelection,
  useAppStore,
} from '../state/app-store';
export {
  type HeldGrant,
  type PendingMutation,
  type ScheduledDebounce,
  type UndoRecord,
  useEditSessionStore,
} from '../state/edit-session-store';
export {
  matchedSelectors,
  type RuntimeRuleSelector,
  rematchSelection,
  type SelectionDescriptor,
  type SelectionMatch,
  selectionDescriptorOf,
  selectionSelector,
} from '../state/selection';
export {
  createSessionGate,
  type SessionGate,
  sameSessionPair,
} from '../state/session-gate';
export {
  bindShellSession,
  clearShellStores,
  type ShellStoreSnapshot,
  shellStoreSnapshot,
} from '../state/shell-stores';
export { AppShell, type AppShellSlots } from './app-shell';
export { commandErrorCode } from './command-error';
export {
  ShellContext,
  type ShellContextValue,
  type ShellStreamState,
  useShell,
} from './shell-context';
export { ShellProvider, type ShellProviderProps } from './shell-provider';
export {
  composeShellReset,
  runShellReset,
  SHELL_RESET_STEPS,
  type ShellResetActions,
  type ShellResetCompositionInputs,
  type ShellResetObserver,
  type ShellResetStep,
} from './shell-reset';
export {
  clearShellResetTrace,
  formatShellState,
  recordShellResetStepDone,
  ShellStateMarker,
  type ShellStateMarkerState,
  shellResetTrace,
} from './shell-state-marker';
export { useSessionQuery } from './use-session-query';
