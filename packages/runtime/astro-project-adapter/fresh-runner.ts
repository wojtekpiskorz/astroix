import type { AdapterErrorDetails } from './adapter-error';
import { AdapterError } from './adapter-error';
import type { ModuleRunnerLike } from './seam-readers';
import { readRunnerContract, readSsrEnvironment } from './seam-readers';

/**
 * The fresh-runner discipline (#206, core-reuse "Content"): one fresh
 * Vite module runner per inspection pass, always closed in `finally`.
 * The runner constructor pins a `send` listener on the SSR environment's
 * hot transport and holds the evaluated module graph in memory; leaks
 * surface as `MaxListenersExceededWarning` from the 11th unclosed runner.
 *
 * `withFreshRunner` proves the #206 cleanup property on every pass: after
 * `close()` the runner reports closed and the hot transport's `send`
 * listener count is restored to its pre-runner value — no transport or
 * graph residue survives the pass. Residue is a `runner-cleanup`
 * rejection, never a silent degradation.
 */

/** The cleanup proof one pass produced — the fresh-runner property, as evidence. */
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
  const sendListenersBefore = hotTransportEmitter.listenerCount('send');
  const runner = readRunnerContract(input.createServerModuleRunner(input.ssrEnvironment));

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

  const sendListenersAfterClose = hotTransportEmitter.listenerCount('send');
  const closedAfterClose = runner.isClosed();
  let cleanupError: unknown;
  if (!closedAfterClose) {
    cleanupError = residueError(
      'open-runner',
      sendListenersBefore,
      sendListenersAfterClose,
      closeError,
    );
  } else if (sendListenersAfterClose !== sendListenersBefore) {
    cleanupError = residueError(
      'send-listeners',
      sendListenersBefore,
      sendListenersAfterClose,
      closeError,
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

function residueError(
  residue: 'send-listeners' | 'open-runner',
  before: number,
  after: number,
  cause: unknown,
): AdapterError {
  const details: AdapterErrorDetails = { residue, before, after };
  const what =
    residue === 'open-runner'
      ? 'the runner still reports open after close'
      : `the hot transport send listener count changed from ${before} to ${after} across the pass`;
  return new AdapterError(
    'runner-cleanup',
    `AstroProjectAdapter runner cleanup rejection: ${what}`,
    details,
    { cause },
  );
}
