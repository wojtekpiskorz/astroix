/**
 * The seam's debounce scheduler (ADR-0002 amendment 5 — the chartered
 * first fire's own scheduling piece, born with the CSS auto-write loop
 * #250/I2): the persist-on-pause discipline CONTEXT.md names — one
 * scheduled dispatch per edit KEY, a later schedule for the same key
 * REPLACING the earlier one (the pause extends; only the settled state
 * at fire time is ever written), an independent key scheduling its own
 * timer. Purely mechanical: the fire callback is the consumer's (the
 * write loop's dispatch), the delay is the constructor's (the settled
 * ~300 ms auto-write pause, injectable for tests), and the scheduler
 * holds no domain knowledge — no plan, no grant, no target.
 *
 * The reset law: `clear()` cancels every pending timer at once — the
 * transition-commit teardown's `debounces` clearing step calls it, so a
 * document being replaced never fires a dead session's write.
 */

/** One scheduled dispatch's handle. */
export interface ScheduledFire {
  /** Cancels this one scheduled fire (a replaced or abandoned edit). */
  cancel(): void;
}

/** The scheduler's surface — one instance per consuming feature loop. */
export interface DebounceScheduler {
  /**
   * Schedules one keyed fire — replacing any pending fire for the same
   * key (the pause extends). Returns the scheduled fire's cancel
   * handle.
   */
  schedule(key: string, fire: () => void): ScheduledFire;
  /** Cancels the pending fire for one key, if any. */
  cancel(key: string): void;
  /** Cancels every pending fire — the reset's clearing step. */
  clear(): void;
  /** The keys with a pending fire (the accounting the edit-session store mirrors). */
  pendingKeys(): readonly string[];
}

/** The settled auto-write pause (CONTEXT.md: "debounce ~300 ms"). */
export const AUTO_WRITE_DEBOUNCE_MS = 300;

/** Creates one debounce scheduler — `delayMs` injectable for tests. */
export function createDebounceScheduler(
  delayMs: number = AUTO_WRITE_DEBOUNCE_MS,
): DebounceScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearKey = (key: string): void => {
    const timer = timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(key);
  };
  return {
    schedule: (key, fire) => {
      clearKey(key);
      const timer = setTimeout(() => {
        timers.delete(key);
        fire();
      }, delayMs);
      timers.set(key, timer);
      return { cancel: () => clearKey(key) };
    },
    cancel: (key) => clearKey(key),
    clear: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    pendingKeys: () => [...timers.keys()],
  };
}
