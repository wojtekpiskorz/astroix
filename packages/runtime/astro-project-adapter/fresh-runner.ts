import type { AdapterErrorDetails } from './adapter-error';
import { AdapterError } from './adapter-error';
import type { ModuleRunnerLike, SendListenerAccounting } from './seam-readers';
import { readRunnerContract, readSsrEnvironment } from './seam-readers';

/**
 * The fresh-runner discipline (#206, core-reuse "Content"): one fresh
 * Vite module runner per inspection pass, always closed in `finally`.
 * The runner constructor pins a `send` listener on the SSR environment's
 * hot transport and holds the evaluated module graph in memory; leaks
 * surface as `MaxListenersExceededWarning` from the 11th unclosed runner.
 *
 * `withFreshRunner` proves the #206 cleanup property on every pass: after
 * `close()` the runner reports closed and the pass leaves no `send`
 * listener residue on the hot transport. Residue is a `runner-cleanup`
 * rejection, never a silent degradation.
 *
 * The proof is scoped PER PASS, by listener identity (#386): the
 * certified Vite pins its runner's transport listener synchronously in
 * the constructor (one per runner) and removes that same function inside
 * `close()`, so the pass can name the exact listeners it pinned — the
 * pre-create roster versus the post-create roster differ by precisely
 * the pass's own additions — and prove THOSE gone after close. A shared
 * listener COUNT cannot prove this under concurrent passes (the worker
 * serves inspections concurrently, and a cancelled HTTP dispatch still
 * runs to completion server-side): a sibling pass's in-flight listener
 * would pollute the count in either direction and trip a false residue.
 *
 * Teeth are kept on both sides of that scoping. The pass's own pinned
 * listeners must be gone after close (a leak always rejects), and any
 * listener that APPEARED on the transport across the pass and stayed
 * must belong to a registered in-flight fresh-runner pass — the
 * per-emitter registry below — or it is unattributable growth and
 * rejects just the same. A drifted pair that pins lazily or multiply is
 * a compatibility event either way: lazy pins are never registered (the
 * registry records only what a pass observed at its own synchronous
 * create), so a later roster sees them as unattributable growth, and a
 * runner that pins nothing has no transport footprint to leak.
 */

/** The cleanup proof one pass produced — the fresh-runner property, as evidence. */
/** Cleanup context for triage: the transport counts bracket the pass. The
 * proof itself is identity-based (the own/foreign verdict in the rejection);
 * these counts ride the evidence for the reader diagnosing a rejection. */
export interface RunnerCleanupEvidence {
  readonly sendListenersBefore: number;
  readonly sendListenersAfterClose: number;
  readonly closedAfterClose: boolean;
}

/** What a fresh-runner pass returns: the inspection result plus its cleanup evidence. */
export interface FreshRunnerOutcome<T> {
  readonly result: T;
  readonly evidence: RunnerCleanupEvidence;
}

/**
 * The per-emitter registry of `send` listeners currently pinned by
 * in-flight fresh-runner passes (#386), keyed weakly by the transport
 * emitter so distinct composition servers never interact. Registration
 * is identity-exact: a pass adds the listeners it observed its own
 * runner pin (at its synchronous create) and releases them once they are
 * observed gone from the emitter. Listeners a rejected pass leaked stay
 * registered — they are genuinely open, and concurrent passes must not
 * misattribute them as their own residue; the leaking pass's rejection
 * already named them.
 */
const pinnedByInFlightPass = new WeakMap<SendListenerAccounting, Set<unknown>>();

function inFlightPinned(emitter: SendListenerAccounting): Set<unknown> {
  let pinned = pinnedByInFlightPass.get(emitter);
  if (pinned === undefined) {
    pinned = new Set();
    pinnedByInFlightPass.set(emitter, pinned);
  }
  return pinned;
}

export async function withFreshRunner<T>(
  input: {
    /** The runner factory resolved from the managed project's Vite (certified exact-pair seam). */
    readonly createServerModuleRunner: (environment: unknown) => unknown;
    /** The composition server's SSR environment. */
    readonly ssrEnvironment: unknown;
  },
  inspection: (runner: ModuleRunnerLike) => Promise<T>,
): Promise<FreshRunnerOutcome<T>> {
  const { hotTransportEmitter } = readSsrEnvironment(input.ssrEnvironment);

  // The create block is one synchronous stretch: the pre-pass roster, the
  // runner construction, and the pinned diff. Nothing interleaves inside
  // it, so `pinned` is exactly the send listeners THIS pass created — a
  // concurrent sibling's listeners are either in the pre-pass roster
  // (pinned earlier) or appear only after this block completes.
  const beforeRoster = new Set(hotTransportEmitter.listeners('send'));
  const sendListenersBefore = hotTransportEmitter.listenerCount('send');
  const runner = readRunnerContract(input.createServerModuleRunner(input.ssrEnvironment));
  const pinned = hotTransportEmitter
    .listeners('send')
    .filter((listener) => !beforeRoster.has(listener));
  const openPinned = inFlightPinned(hotTransportEmitter);
  for (const listener of pinned) openPinned.add(listener);

  // The residue proof runs on EVERY exit path, not just the happy one: a
  // listener leaked during a failed pass must not quietly become the next
  // pass's baseline. An inspection failure and a cleanup failure together
  // surface as an AggregateError so neither hides the other.
  let result: T | undefined;
  let inspectionError: unknown;
  try {
    result = await inspection(runner);
  } catch (error) {
    inspectionError = error;
  }

  // Always close — a failed inspection must not leak the runner either.
  // A close rejection is itself a cleanup failure; it must not swallow a
  // captured inspection error on the way out.
  let closeError: unknown;
  try {
    await runner.close();
  } catch (error) {
    closeError = error;
  }

  // The proof block — one synchronous continuation after close settles:
  // the after-roster, the registry release, and the residue verdicts all
  // observe one coherent transport state.
  const afterRoster = new Set(hotTransportEmitter.listeners('send'));
  const sendListenersAfterClose = hotTransportEmitter.listenerCount('send');
  const closedAfterClose = runner.isClosed();
  // Release the pass's pinned listeners once they are observed gone; a
  // leaked one stays registered (attributed to this pass, which the
  // verdict below rejects for it).
  for (const listener of pinned) {
    if (!afterRoster.has(listener)) openPinned.delete(listener);
  }
  const verdict = listenerResidue({
    before: beforeRoster,
    pinned,
    after: afterRoster,
    openPinned,
  });

  let cleanupError: unknown;
  if (!closedAfterClose) {
    cleanupError = residueError(
      'open-runner',
      sendListenersBefore,
      sendListenersAfterClose,
      closeError,
      'the runner still reports open after close',
    );
  } else if (verdict !== null) {
    cleanupError = residueError(
      'send-listeners',
      sendListenersBefore,
      sendListenersAfterClose,
      closeError,
      RESIDUE_VERDICT_WHAT[verdict],
    );
  } else if (closeError !== undefined) {
    cleanupError = closeError;
  }
  if (cleanupError !== undefined) {
    if (inspectionError !== undefined) {
      throw new AggregateError(
        [inspectionError, cleanupError],
        'AstroProjectAdapter runner cleanup rejection: the inspection failed and the runner cleanup failed',
      );
    }
    throw cleanupError;
  }
  if (inspectionError !== undefined) {
    throw inspectionError;
  }
  return {
    result: result as T,
    evidence: { sendListenersBefore, sendListenersAfterClose, closedAfterClose },
  };
}

/**
 * The per-pass listener-residue verdict over the transport rosters
 * (#386): `'own'` when one of the pass's pinned listeners outlived
 * close, `'foreign'` when a listener appeared across the pass and stayed
 * without belonging to any registered in-flight pass, `null` when the
 * transport is provably clean for this pass.
 */
/** The residue verdicts' rejection messages — one home so the two branches cannot drift apart. */
const RESIDUE_VERDICT_WHAT: Readonly<Record<'own' | 'foreign', string>> = {
  own: 'the runner pinned send listeners that outlived close',
  foreign: 'send listeners appeared on the hot transport that no fresh-runner pass owns',
};

function listenerResidue(input: {
  readonly before: ReadonlySet<unknown>;
  readonly pinned: readonly unknown[];
  readonly after: ReadonlySet<unknown>;
  readonly openPinned: ReadonlySet<unknown>;
}): 'own' | 'foreign' | null {
  for (const listener of input.pinned) {
    if (input.after.has(listener)) return 'own';
  }
  for (const listener of input.after) {
    if (!input.before.has(listener) && !input.openPinned.has(listener)) return 'foreign';
  }
  return null;
}

function residueError(
  residue: 'send-listeners' | 'open-runner',
  before: number,
  after: number,
  cause: unknown,
  what: string,
): AdapterError {
  const details: AdapterErrorDetails = { residue, before, after };
  return new AdapterError(
    'runner-cleanup',
    `AstroProjectAdapter runner cleanup rejection: ${what}`,
    details,
    { cause },
  );
}
