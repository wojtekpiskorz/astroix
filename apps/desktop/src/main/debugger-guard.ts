/**
 * The CDP debugger guard (#247, H5; ADR-0009 "Before the first project
 * navigation, Electron's debugger is attached to the editing
 * `webContents`, CDP Network enabled, and
 * `Network.setBypassServiceWorker({ bypass: true })` set — and
 * retained"): the fail-closed state machine that owns the Service
 * Worker bypass on ONE editing target.
 *
 * The sequence is the invariant: attach (CDP 1.3) → `Network.enable` →
 * `Network.setBypassServiceWorker({bypass: true})`. Any failure at any
 * step — attach refused, enable rejected, bypass rejected — or either
 * retention failure later compromises the guard: `isBypassActive()`
 * goes false and the `onCompromised` hook fires, which the composition
 * answers by revoking document authority (editing disabled before
 * another control request). Recovery is re-activation on a fresh or
 * reloaded target — the guard re-runs the same three-step sequence.
 *
 * The two retention failures, both event-truth, not a poll:
 * - **The debugger detached** (another debugger took the target, the
 *   API detach, the target closing outside the deliberate path) — the
 *   `detach` listener is registered before the first command and lives
 *   until `dispose()`.
 * - **DevTools opened for this target** — an empirical law of the
 *   pinned Electron 44.1.0 (proven in this repo's `e2e/desktop` lane):
 *   opening DevTools does NOT detach `webContents.debugger` and does
 *   not block commands, so the docs' implied detachment cannot be the
 *   tripwire. The guard therefore observes `devtools-opened` itself
 *   and fail-closes: DevTools is kicked off the target
 *   (`closeDevtools`), the debugger slot is cleaned (`detach`), and
 *   the target is compromised — DevTools never shares the
 *   authoritative editing target (ADR-0009).
 *
 * The deliberate unload path (`dispose`) makes Electron's own
 * closing-target detach event expected, not a compromise.
 *
 * Editor mode does not reproduce project Service Worker or PWA
 * behavior (ADR-0009): the bypass is an integrity invariant over the
 * authoritative origin, not a fidelity promise.
 *
 * Electron-free beyond the structural seam type: the harness (and the
 * desktop composition lane) binds the real `webContents.debugger` and
 * the real webContents DevTools events onto it; the focused units pass
 * a fake; the real-CDP truth is the `e2e/desktop` lane.
 */

/** The CDP protocol version the guard attaches with (ADR-0009: "attach CDP 1.3"). */
export const CDP_PROTOCOL_VERSION = '1.3';

/** The CDP command that turns the Network domain on for the target. */
export const NETWORK_ENABLE_COMMAND = 'Network.enable';

/** The CDP command that is the bypass itself (the DevTools "Bypass service worker" switch). */
export const BYPASS_SERVICE_WORKER_COMMAND = 'Network.setBypassServiceWorker';

/**
 * The structural slice of the target's debug surface the guard drives:
 * Electron's `WebContents.debugger` satisfies the debugger half
 * unchanged, and the webContents `devtools-opened` event the observed
 * DevTools half — the adapter (harness or desktop composition) binds
 * both onto this one seam.
 */
export interface DebuggerSeam {
  /** Throws when another debugger is already attached (Electron's contract). */
  attach(protocolVersion: string): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Detaches the host debugger (the DevTools compromise path cleans the slot before recovery). */
  detach(): void;
  /** Registers the detach listener; returns its unbind. */
  onDetach(handler: (reason: string) => void): () => void;
  /** Registers the DevTools-opened listener; returns its unbind. */
  onDevtoolsOpened(handler: () => void): () => void;
  /** Closes DevTools for this target — the fail-closed response (DevTools cannot share the authoritative target). */
  closeDevtools(): void;
}

/** One settled step of the activation sequence — the ordering evidence the composition logs. */
export type DebuggerGuardStep = 'attached' | 'network-enabled' | 'bypass-set';

/** How the bypass failed — sanitized vocabulary; `detail` carries the platform message, never secrets. The `disposed` member is not a failure of the bypass at all: it answers an activation attempted on a deliberately torn-down guard. */
export type BypassFailure =
  | { readonly kind: 'attach-failed'; readonly detail: string }
  | { readonly kind: 'network-enable-failed'; readonly detail: string }
  | { readonly kind: 'bypass-set-failed'; readonly detail: string }
  | { readonly kind: 'debugger-detached'; readonly detail: string }
  | { readonly kind: 'devtools-opened'; readonly detail: string }
  | { readonly kind: 'disposed'; readonly detail: string };

/** The fixed detail of the observed DevTools compromise. */
export const DEVTOOLS_OPENED_DETAIL = 'DevTools opened for the authoritative editing target';

/** The guard's lifecycle: `compromised` is terminal until a re-activation succeeds. */
export type DebuggerGuardState = 'inactive' | 'activating' | 'bypassed' | 'compromised' | 'closed';

export interface DebuggerGuard {
  /**
   * Runs (or re-runs) the attach → enable → bypass sequence. Idempotent
   * while already bypassed; concurrent calls share one activation. A
   * failure compromises the guard and reports it through
   * `onCompromised` — never resolves `{ ok: true }` after a failure.
   * An activation on a disposed guard answers the `disposed` failure
   * kind (deliberate teardown, not a compromise, not an attach
   * refusal).
   */
  activate(): Promise<{ ok: true } | { ok: false; failure: BypassFailure }>;
  state(): DebuggerGuardState;
  /** True only while the bypass is live — the fail-closed admission gate. */
  isBypassActive(): boolean;
  /** The failure that compromised the guard, if any. */
  failure(): BypassFailure | null;
  /**
   * Deliberate teardown (the target is unloading): the detach event
   * Electron then emits is expected, not a compromise. No recovery
   * after this — the target is gone.
   */
  dispose(): void;
}

/** Construction input: the seam, the step evidence hook, the fail-closed hook. */
export interface DebuggerGuardOptions {
  readonly debugger: DebuggerSeam;
  /** Fires once per settled activation step, in sequence order. */
  readonly onStep?: (step: DebuggerGuardStep) => void;
  /** Fires on every failure and every unexpected detach — the composition's fail-closed trigger. */
  readonly onCompromised?: (failure: BypassFailure) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDebuggerGuard(options: DebuggerGuardOptions): DebuggerGuard {
  let state: DebuggerGuardState = 'inactive';
  let failure: BypassFailure | null = null;
  let disposed = false;
  let activation: Promise<{ ok: true } | { ok: false; failure: BypassFailure }> | null = null;

  const unbindDetach = options.debugger.onDetach((reason) => {
    // A detach while deliberately closed is the expected unload echo;
    // one after an earlier compromise changes nothing.
    if (disposed || state === 'compromised') return;
    state = 'compromised';
    failure = { kind: 'debugger-detached', detail: reason };
    options.onCompromised?.(failure);
  });

  // The observed DevTools law (Electron 44.1.0, proven in the
  // e2e/desktop lane): DevTools opening neither detaches the debugger
  // nor blocks it — so the guard observes the event itself and kicks
  // DevTools off the authoritative target before failing closed.
  const unbindDevtools = options.debugger.onDevtoolsOpened(() => {
    if (disposed || state === 'compromised') return;
    // Compromised FIRST: the detach event that our own slot-clean
    // triggers must not double-report a second failure.
    state = 'compromised';
    failure = { kind: 'devtools-opened', detail: DEVTOOLS_OPENED_DETAIL };
    options.debugger.closeDevtools();
    // Clean the debugger slot so a recovery re-attach cannot collide
    // with our own still-attached session.
    options.debugger.detach();
    options.onCompromised?.(failure);
  });

  /** Records a failure as the guard's truth and reports it — the one fail-closed sink. */
  function compromise(
    kind: BypassFailure['kind'],
    error: unknown,
  ): { ok: false; failure: BypassFailure } {
    const recorded: BypassFailure = { kind, detail: messageOf(error) };
    state = 'compromised';
    failure = recorded;
    options.onCompromised?.(recorded);
    return { ok: false, failure: recorded };
  }

  async function runActivation(): Promise<{ ok: true } | { ok: false; failure: BypassFailure }> {
    state = 'activating';
    try {
      options.debugger.attach(CDP_PROTOCOL_VERSION);
    } catch (error) {
      return compromise('attach-failed', error);
    }
    options.onStep?.('attached');
    // A detach that raced the sequence already compromised the guard —
    // every later step reports that failure instead of a second one,
    // and no step is SENT after the compromise is observed.
    try {
      await options.debugger.sendCommand(NETWORK_ENABLE_COMMAND);
    } catch (error) {
      if (wasCompromised()) return { ok: false, failure: recordedFailure() };
      return compromise('network-enable-failed', error);
    }
    if (wasCompromised()) return { ok: false, failure: recordedFailure() };
    options.onStep?.('network-enabled');
    try {
      await options.debugger.sendCommand(BYPASS_SERVICE_WORKER_COMMAND, { bypass: true });
    } catch (error) {
      if (wasCompromised()) return { ok: false, failure: recordedFailure() };
      return compromise('bypass-set-failed', error);
    }
    if (wasCompromised()) return { ok: false, failure: recordedFailure() };
    state = 'bypassed';
    options.onStep?.('bypass-set');
    return { ok: true };
  }

  /**
   * Reads the state through a call so the closure-mutated variable is
   * not narrowed to its last in-function assignment (the detach
   * listener writes `state` from outside this control flow).
   */
  function wasCompromised(): boolean {
    return state === 'compromised';
  }

  /** The already-recorded failure for a detach that raced the sequence. */
  function recordedFailure(): BypassFailure {
    return failure ?? { kind: 'debugger-detached', detail: 'detached during activation' };
  }

  return {
    activate: () => {
      if (disposed) {
        // A closed target does not recover — and this is neither a
        // compromise nor an attach refusal: `disposed` is its own kind,
        // so a caller keying on `failure.kind` never misattributes
        // deliberate teardown to the DevTools-holds-target class.
        return Promise.resolve({
          ok: false,
          failure: { kind: 'disposed', detail: 'guard disposed (target closed)' },
        });
      }
      if (state === 'bypassed') return Promise.resolve({ ok: true });
      // Share the in-flight activation REGARDLESS of state: a mid-flight
      // compromise (the detach listener fires while a step is pending)
      // must not let a retry start a parallel run whose failure paths
      // would report a second, wrong-kind compromise. The slot clears
      // when this run settles and is still the current one — the next
      // call after a compromise is a clean, sequential re-run.
      if (activation !== null) return activation;
      const current = runActivation();
      activation = current;
      void current.finally(() => {
        if (activation === current) activation = null;
      });
      return current;
    },
    state: () => state,
    isBypassActive: () => state === 'bypassed',
    failure: () => failure,
    dispose: () => {
      disposed = true;
      state = 'closed';
      unbindDetach();
      unbindDevtools();
    },
  };
}
