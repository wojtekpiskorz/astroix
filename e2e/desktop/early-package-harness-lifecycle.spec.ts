import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HarnessRun } from './harness-kit.ts';

/**
 * The shared run's lifecycle law (#248, review round 4): cleanup can
 * NEVER hang — the hole this spec pins shut was `stop()`/`
 * killForCleanup()` gating on `exitCode === null`, which a SIGNAL-killed
 * child also satisfies (the signal lives in `signalCode`), so cleanup
 * awaited a fresh `once('exit')` listener a process that had already
 * emitted exit could never fire — every packaged spec's afterAll hung
 * to the 180 s hook timeout and the real failure surfaced as a hook
 * timeout, not the leg's error. The one settled predicate (code OR
 * signal) now lives in `harness-kit.ts` and serves `exit`, `stop()`,
 * and `killForCleanup()` alike; the post-SIGKILL await is bounded.
 *
 * Deterministic and always-on: a plain OS child (no Electron, no
 * package build) exercises the shared run's own semantics — the law
 * serves every `e2e/desktop` lane, H4/H5 included.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the shared harness run — cleanup settles, never hangs (#248)', () => {
  it('a signal-killed child settles and stop() returns promptly (the hook-timeout hole)', async () => {
    const run = new HarnessRun({
      executable: '/bin/sleep',
      argv: ['30'],
      reportPrefix: 'lifecycle-probe: ',
      cwd: REPO,
    });
    // Signal death: exitCode stays null, the signal lands in signalCode —
    // the exact shape the old `exitCode === null` cleanup misread.
    run.child.kill('SIGKILL');
    const settled = await run.exit;
    expect(settled.code).toBeNull();
    expect(settled.signal).toBe('SIGKILL');
    // The old stop() hung HERE forever (quit to a dead pipe, a 5 s race
    // against a listener that could never fire, then an unbounded await
    // of another). The shared settled predicate returns immediately.
    const startedAt = Date.now();
    await run.stop();
    const elapsedMs = Date.now() - startedAt;
    expect(
      elapsedMs,
      `stop() on a settled child must return promptly (took ${elapsedMs} ms)`,
    ).toBeLessThan(2000);
  }, 30_000);

  it('a live child stops through the bounded escalation, and stop() is idempotent', async () => {
    const run = new HarnessRun({
      executable: '/bin/sleep',
      argv: ['30'],
      reportPrefix: 'lifecycle-probe: ',
      cwd: REPO,
    });
    // The quit op is never read (sleep has no protocol); the bounded
    // graceful window expires, the SIGKILL lands, and the BOUNDED
    // post-kill await settles — the whole path under its own bound.
    const startedAt = Date.now();
    await run.stop();
    const elapsedMs = Date.now() - startedAt;
    // 5 s graceful + SIGKILL settlement: comfortably under the 180 s
    // hook timeout, and never unbounded.
    expect(elapsedMs, `the ordered stop must stay bounded (took ${elapsedMs} ms)`).toBeLessThan(
      30_000,
    );
    const settled = await run.exit;
    expect(settled.signal).toBe('SIGKILL');
    // Idempotent: a second stop on the settled child returns immediately.
    const againStartedAt = Date.now();
    await run.stop();
    expect(Date.now() - againStartedAt).toBeLessThan(1000);
  }, 60_000);
});
