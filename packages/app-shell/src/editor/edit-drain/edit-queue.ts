/**
 * The seam's edit ordering queue (ADR-0002 amendment 5): the
 * client-side serialization of mutation dispatches — ONE mutation in
 * flight per feature loop, every later dispatch queued behind the live
 * one's settle. This is the client half of the ordering law; the
 * server's own serialized queue is the F5 edit fence the runtime
 * owns, and the two never disagree: a client that never has two
 * mutations in flight can never observe the fence's interleaving.
 *
 * Mechanically a promise chain: `enqueue` returns the task's own
 * settlement, and a task that throws settles its caller while the
 * chain stays alive for the next queued task (one task's failure never
 * poisons the loop).
 */

/** The queue's surface — one instance per consuming feature loop. */
export interface EditQueue {
  /**
   * Runs `task` after every previously enqueued task settled — the
   * one-in-flight law. Resolves with the task's own outcome; never
   * rejects past the task's own rejection.
   */
  enqueue(task: () => Promise<void>): Promise<void>;
  /** The tasks waiting plus the live one (0 = quiet). */
  depth(): number;
}

/** Creates one edit queue — the serialized dispatch chain. */
export function createEditQueue(): EditQueue {
  let chain: Promise<void> = Promise.resolve();
  let live = 0;
  return {
    enqueue: (task) => {
      live += 1;
      const settled = chain.then(task, task);
      const done = settled.then(
        () => {
          live -= 1;
        },
        () => {
          live -= 1;
        },
      );
      // The chain advances only to track ordering — a rejected task is
      // the caller's outcome (returned below), never the chain's death.
      chain = done;
      return settled;
    },
    depth: () => live,
  };
}
