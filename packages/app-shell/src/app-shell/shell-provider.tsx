import type { QueryClient } from '@tanstack/react-query';
import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AppClient, SessionClient } from '../app-client.ts';
import { armContentRetryBelt, type ContentRetryBelt } from '../query/content-retry-belt.ts';
import { gatedSseHandlers } from '../query/session-events.ts';
import { createShellQueryClient } from '../query/shell-query-client.ts';
import type { ShellRole } from '../roles/capabilities.ts';
import { createSessionGate, type SessionGate } from '../state/session-gate.ts';
import { bindShellSession } from '../state/shell-stores.ts';
import { commandErrorCode } from './command-error.ts';
import { ShellContext, type ShellContextValue, type ShellStreamState } from './shell-context.ts';
import { composeShellReset, type ShellResetObserver } from './shell-reset.ts';
import { clearShellResetTrace, recordShellResetStepDone } from './shell-state-marker.tsx';

/**
 * The shell provider (#241, G2): composes the app shell over the ONE
 * AppClient (the one-AppClient law, #332) at the document's exact
 * `SessionRef` (ADR-0006 §3 — the document surface bound it at serve
 * time; the provider adopts it). It owns the session runtime — the
 * store binding, the session gate, the session-scoped abort controller,
 * the gated events subscription, the host's QueryClient — and the ONE
 * ordered reset the transition-commit path executes (ADR-0006 §5 /
 * ADR-0002 amendment 3): abort fetches, close SSE, remove
 * old-generation queries, clear the stores, THEN navigate.
 *
 * SSE admission note (#330, reads-law alignment): a live same-origin
 * GET stream presents `Sec-Fetch-Site: same-origin` and NO `Origin`
 * (`Origin` is a forbidden header on a same-origin GET in real
 * browsers), and admission verifies `Origin` only when present — so the
 * browser's own `EventSource` shape is admitted. The gate, the
 * dispatch, and the reset's `close-sse` step are the same machinery
 * every admitted stream drives; live-wire delivery legs ride the
 * product E2E (I/J/K, unblocked by #330).
 */

/** Construction props; hosts inject their document facts and keep the navigation seam testable. */
export interface ShellProviderProps {
  /** The one AppClient — every exchange goes through it, never a second transport. */
  readonly client: AppClient;
  /** The exact pair the document was served bound at (public correlation data, never authority). */
  readonly sessionRef: SessionRef;
  /** The document's role; defaults to the authoritative editing client (the web host binds the editor capability). */
  readonly role?: ShellRole;
  /** The host's QueryClient; one is created when the host does not own one. */
  readonly queryClient?: QueryClient;
  /** The reset's default navigation target; defaults to the neutral launcher document. */
  readonly launcherUrl?: string;
  /** The top-level replacement seam — `location.replace` in a host, injectable in tests. */
  readonly navigate?: (url: string) => void;
  /** An additional reset observer (the host's), composed inside the provider's own marker observer. */
  readonly resetObserver?: ShellResetObserver;
  readonly children: ReactNode;
}

/** The neutral launcher document's URL on this host's port (ADR-0005's loopback vocabulary). */
function defaultLauncherUrl(): string {
  return `http://launcher.localhost:${globalThis.location?.port}/__astroix/app/`;
}

/** The provider — one per project document. */
export function ShellProvider({
  client,
  sessionRef,
  role = 'authoritative',
  queryClient,
  launcherUrl,
  navigate,
  resetObserver,
  children,
}: ShellProviderProps): ReactNode {
  const queryClientRef = useRef<QueryClient | null>(null);
  if (queryClientRef.current === null)
    queryClientRef.current = queryClient ?? createShellQueryClient();
  const ownedQueryClient = queryClientRef.current;

  // The runtime freezes at the FIRST render's pair — one provider per
  // project document, one session per document lifecycle; a changed
  // session is a navigation (a new document), never a prop mutation.
  // Everything downstream (the adoption included) reads the frozen
  // `ref`, so a re-rendered sessionRef prop can never split the pair
  // the subscription serves from the one the host adopted.
  const runtimeRef = useRef<{
    ref: SessionRef;
    session: SessionClient;
    gate: SessionGate;
  } | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = {
      ref: sessionRef,
      session: client.forSession(sessionRef),
      gate: createSessionGate(sessionRef),
    };
  }
  const { session, gate } = runtimeRef.current;
  const frozenSessionRef = runtimeRef.current.ref;

  const [streamState, setStreamState] = useState<ShellStreamState>('connecting');
  const [commandError, setCommandError] = useState<string | null>(null);
  // Eager at first render, not in the effect: child effects (a session
  // query's first fetch among them) run BEFORE this provider's effect,
  // and the signal they chain must already be the live one — a pre-closed
  // stand-in would silently cancel every mount-time query.
  const controllerRef = useRef<AbortController | null>(null);
  if (controllerRef.current === null) controllerRef.current = new AbortController();
  const subscriptionRef = useRef<{ close(): void } | null>(null);

  useEffect(() => {
    client.adoptSession(frozenSessionRef);
    bindShellSession(frozenSessionRef);
    clearShellResetTrace();
    const controller = controllerRef.current;
    if (controller === null) return;
    // The content-family convergence belt's live handle (#451): one belt
    // at a time — a re-arming push cancels the pending one, the effect's
    // cleanup cancels the last, and the belt's own schedule dies with the
    // session (the abort signal below, or the gate the reset closes).
    let activeBelt: ContentRetryBelt | null = null;
    const subscription = session.events(
      gatedSseHandlers(gate, {
        onEvent: (envelope) => {
          setStreamState('open');
          // Revisioned invalidations refetch exactly the invalidated
          // families' generation-scoped keys — the SSE→query bridge.
          const event = envelope.event;
          if (event.type === 'invalidation') {
            activeBelt?.cancel();
            activeBelt = null;
            let contentRefetch: Promise<unknown> | null = null;
            for (const family of event.families) {
              const settle = ownedQueryClient.invalidateQueries({
                queryKey: session.queryKey(family),
              });
              void settle;
              if (family === 'content') contentRefetch = settle;
            }
            // The torn-truth belt (#451 over #450's disclosure): the
            // content push's first refetch can read the pre-edit listing
            // (the content layer's projection trails the file write);
            // the belt re-fetches on a bounded backoff until the served
            // payload's revision marker moves off the pre-push value.
            if (contentRefetch !== null) {
              activeBelt = armContentRetryBelt(
                {
                  queryClient: ownedQueryClient,
                  session,
                  gate,
                  signal: controller.signal,
                },
                contentRefetch,
              );
            }
          }
        },
        onStale: () => setStreamState('stale'),
        onTransportError: () => setStreamState('unavailable'),
        // The transport-open convergence (#342): an admitted stream is
        // live the moment it is established — a quiet session that
        // delivers no frame must not read as eternally connecting.
        // Ungated like the other stream-level callbacks; the onEvent
        // line above stays (idempotent — same terminal state).
        onOpen: () => setStreamState('open'),
      }),
    );
    subscriptionRef.current = subscription;
    void subscription.closed.then((reason) => {
      if (reason !== 'aborted') setStreamState(reason);
    });
    return () => {
      activeBelt?.cancel();
      subscription.close();
      controller.abort();
      subscriptionRef.current = null;
    };
    // frozenSessionRef is stable by construction (runtimeRef freezes on the
    // first render) — listing it satisfies the exhaustive-deps law without
    // ever re-running the effect: a re-rendered sessionRef prop cannot move it.
  }, [client, session, gate, ownedQueryClient, frozenSessionRef]);

  const reset = (url?: string): void => {
    composeShellReset({
      fetchAbort: { abort: () => controllerRef.current?.abort() },
      events: { close: () => subscriptionRef.current?.close() },
      queryClient: ownedQueryClient,
      gate,
      navigate: (target) => (navigate ?? defaultTopLevelReplacement)(target),
      url: url ?? launcherUrl ?? defaultLauncherUrl(),
    }).run({
      onStep: (step) => resetObserver?.onStep?.(step),
      onStepDone: (step) => {
        resetObserver?.onStepDone?.(step);
        recordShellResetStepDone(step, ownedQueryClient);
      },
    });
  };

  const value: ShellContextValue = {
    client,
    session,
    role,
    queryClient: ownedQueryClient,
    gate,
    sessionAbort: controllerRef.current.signal,
    streamState,
    reset,
    commandError,
    reportCommandError: (error) => setCommandError(commandErrorCode(error)),
    clearCommandError: () => setCommandError(null),
  };

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The default top-level replacement — the commit path's navigation (ADR-0006 §4 step 6). */
function defaultTopLevelReplacement(url: string): void {
  globalThis.location?.replace(url);
}
