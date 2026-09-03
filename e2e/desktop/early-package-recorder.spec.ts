import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The recorder's focused negative proofs (#248, review round 3): the
 * battery verdict's honesty law — a red battery can NEVER record green.
 *
 * The recorder (`apps/desktop/scripts/run-early-package-smoke.mjs`)
 * rules the recorded run CONJUNCTIVELY: the `Tests` summary counts
 * (parsed order-free — vitest 4 prints FAILED FIRST) AND the process
 * exit code must both be green. The hole this spec pins shut: vitest
 * exits 1 for reds the Tests line cannot carry — an unloadable spec
 * contributes ZERO tests, so a green `Tests  9 passed (9)` can sit
 * beside a failed FILE and a nonzero exit; the old parser trusted the
 * line alone and would have written a green evidence record over a red
 * battery.
 *
 * The proofs run against the REAL recorder module (imported inert —
 * the runner only orchestrates as a command) through a node subprocess:
 * the shape cases over vitest 4.1.11's real summary lines, and one
 * LIVE red battery through the real `runBattery` spawn path (a
 * no-match filter — the exact red the family prefix invites). No
 * package build needed: this spec is always live in the desktop lane.
 */

const execFileAsync = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(REPO, 'apps', 'desktop', 'scripts', 'run-early-package-smoke.mjs');

/** The recorder's verdict shape (the runner's exported `batteryVerdict`). */
interface Verdict {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly summary: string | null;
  readonly exitCode: number;
  readonly ok: boolean;
}

/**
 * Evaluates one expression against the imported recorder module — the
 * import is inert (the runner orchestrates only as a command), so the
 * expression sees the exports and nothing else ran. The verdict JSON is
 * the LAST stdout line: the live leg's `runBattery` tees the inner
 * vitest output to stdout first (the recorder's user-facing behavior,
 * kept intact), and the JSON lands after it.
 */
async function evaluate<T>(expression: string): Promise<T> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const runner = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});\n` +
        `const value = await (${expression})(runner);\n` +
        'console.log(JSON.stringify(value));',
    ],
    { cwd: REPO, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const lastLine = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (lastLine === undefined)
    throw new Error('early-package: the recorder evaluation printed nothing');
  return JSON.parse(lastLine) as T;
}

describe('the recorder verdict — a red battery can never record green (#248)', () => {
  it('parses the Tests summary in any segment order and rules conjunctively with the exit code', async () => {
    const verdicts = await evaluate<Verdict[]>(`(runner) => [
      runner.batteryVerdict('      Tests  9 passed (9)\\n', 0),
      runner.batteryVerdict('      Tests  2 failed | 7 passed (9)\\n', 1),
      runner.batteryVerdict('      Tests  9 passed (9)\\n', 1),
      runner.batteryVerdict('No test files found, exiting with code 1\\n', 1),
      runner.batteryVerdict('      Tests  8 passed | 1 skipped (9)\\n', 0),
    ]`);
    const [green, redFailedFirst, silentGreenHole, noSummary, skipped] = verdicts;
    // The recorded run's own green shape: ok.
    expect(green).toMatchObject({ passed: 9, failed: 0, ok: true });
    // vitest 4 prints FAILED FIRST — the failed count is parsed from its
    // leading position, not a dead optional group.
    expect(redFailedFirst).toMatchObject({ passed: 7, failed: 2, ok: false });
    // The silent-green hole: a green Tests line with a RED exit (an
    // unloadable sibling spec, an unhandled error) is NOT ok — the line
    // alone is never authority.
    expect(silentGreenHole).toMatchObject({ passed: 9, failed: 0, exitCode: 1, ok: false });
    // No summary at all (a no-match filter): the exit code rules.
    expect(noSummary).toMatchObject({ summary: null, failed: 0, exitCode: 1, ok: false });
    // Skipped wherever it falls in the chain.
    expect(skipped).toMatchObject({ passed: 8, skipped: 1, ok: true });
  }, 240_000);

  it('a LIVE red battery through the real spawn path is not-ok', async () => {
    // A no-match family filter — exactly the red the positional prefix
    // filter invites (a renamed family, a broken glob): the real vitest
    // binary, the real config, exit 1, and the recorder's own spawn
    // path must rule the run red.
    const verdict = await evaluate<Verdict & { readonly saidNoTestFiles: boolean }>(
      `(runner) => runner
        .runBattery('(unmatched)', 'e2e/desktop/early-package-recorder-NO-SUCH-FILTER')
        .then((r) => ({ ...r, log: undefined, saidNoTestFiles: r.log.includes('No test files found') }))`,
    );
    expect(verdict.exitCode).toBe(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toBeNull();
    expect(verdict.saidNoTestFiles).toBe(true);
  }, 240_000);
});
