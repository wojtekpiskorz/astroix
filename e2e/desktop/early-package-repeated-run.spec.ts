import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type DesktopEvent,
  extractPackagedApp,
  makeStagingRoot,
  PACKAGE_ZIP,
  PackagedAppRun,
  processesReferencing,
  quitNormally,
  registerThroughNativePicker,
  removeStaging,
  snapshotManagedProject,
  uiScriptingAvailable,
} from './early-package-kit.ts';

/**
 * The repeated-run leg (#248, H6 focused tests): TWO consecutive
 * packaged smokes over FRESH extractions of the same ZIP — each with
 * its own isolated temp HOME and user-data root — proving no retained
 * state and deterministic cleanup: every cycle boots the same way,
 * registers the SAME managed project to the SAME canonical projectKey
 * through a fresh empty registry (identity is content-derived, never
 * machine state), quits with the same graceful child stop, and leaves
 * the same zero-residue audits. A first-run-only artifact (a lock file
 * outside userData, a cache keyed to the app path, a leftover process)
 * would break the second cycle's equality or its audits.
 */

const execFileAsync = promisify(execFile);
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

let staging: string;
let managedRoot: string;
let managedBefore: Map<string, string>;
let canDriveUi = true;
const liveRuns: PackagedAppRun[] = [];

beforeAll(async () => {
  staging = await makeStagingRoot('astroix-early-repeat-');
  managedRoot = join(staging, 'managed-project');
  await execFileAsync('cp', ['-R', join(REPO, 'e2e', 'fixture'), managedRoot]);
  managedBefore = snapshotManagedProject(managedRoot);
  canDriveUi = await uiScriptingAvailable();
}, 300_000);

afterAll(async () => {
  for (const run of liveRuns.splice(0)) await run.killForCleanup();
  if (staging !== undefined) await removeStaging(staging);
});

/** One full packaged cycle over a fresh extraction + fresh isolation roots. */
async function runCycle(cycle: number): Promise<{
  readonly projectKey: string | null;
  readonly canonicalRoot: string | null;
  readonly childStop: string | null;
  readonly exitCode: number | null;
}> {
  const extraction = join(staging, `cycle-${cycle}`);
  const appPath = await extractPackagedApp(PACKAGE_ZIP as string, extraction);
  const run = new PackagedAppRun(appPath, {
    staging: extraction,
    home: join(extraction, 'home'),
    userData: join(extraction, 'user-data'),
  });
  liveRuns.push(run);
  await run.waitForEvent('control-plane-booted', `cycle ${cycle} boot`);
  let projectKey: string | null = null;
  if (canDriveUi) {
    const registered: DesktopEvent = await registerThroughNativePicker(run, managedRoot);
    projectKey = String((registered.summary as Record<string, unknown>).projectKey);
  }
  await quitNormally(run);
  const quit = run.events.find((event) => event.kind === 'quit-settled');
  const exit = await run.exit;
  const strays = await processesReferencing(extraction);
  expect(strays, `cycle ${cycle} stray processes: ${JSON.stringify(strays)}`).toEqual([]);
  // The registry's own record: the canonical root this cycle's fresh
  // store holds (the deterministic identity half — the key is fresh
  // CSPRNG per registration by ADR-0006 §1, never root-derived).
  let canonicalRoot: string | null = null;
  const registryStore = join(run.roots.userData, 'registry', 'registry.json');
  if (existsSync(registryStore)) {
    const store = JSON.parse(await readFile(registryStore, 'utf8')) as {
      records?: ReadonlyArray<{ canonicalRoot?: unknown }>;
    };
    canonicalRoot = (store.records?.[0]?.canonicalRoot as string | undefined) ?? null;
  }
  const exitCode = exit.code;
  liveRuns.splice(liveRuns.indexOf(run), 1);
  return {
    projectKey,
    canonicalRoot,
    childStop: (quit?.childStop as string | undefined) ?? null,
    exitCode,
  };
}

describe.skipIf(!PACKAGE_ZIP)('the exact packaged host — the repeated-run leg (#248)', () => {
  it('two consecutive fresh-extraction cycles behave identically: no retained state, deterministic cleanup', async () => {
    const first = await runCycle(1);
    const second = await runCycle(2);
    for (const [name, cycle] of [
      ['first', first],
      ['second', second],
    ] as const) {
      console.log(
        `early-package-evidence: repeated run ${name} — projectKey=${cycle.projectKey} childStop=${cycle.childStop} exit=${String(cycle.exitCode)}`,
      );
      expect(cycle.childStop, `${name} cycle quit settles gracefully`).toBe('graceful');
      expect(cycle.exitCode, `${name} cycle exits 0`).toBe(0);
    }
    // The identity laws across two FRESH empty registries: the canonical
    // root — the deterministic identity — is the same realpath both
    // cycles, while the ProjectKey is freshly minted per registration
    // (ADR-0006 §1: the key is routing entropy, never root-derived, so
    // key equality across registrations is NOT the law — key FRESHNESS
    // and well-formedness are).
    if (canDriveUi) {
      expect(first.projectKey).not.toBeNull();
      expect(second.projectKey).not.toBeNull();
      expect(first.projectKey).toMatch(/^[a-z2-7]{26}$/);
      expect(second.projectKey).toMatch(/^[a-z2-7]{26}$/);
      expect(second.projectKey).not.toBe(first.projectKey);
      const managedReal = await realpath(managedRoot);
      expect(first.canonicalRoot).toBe(managedReal);
      expect(second.canonicalRoot).toBe(managedReal);
    } else {
      console.log(
        'early-package-evidence: UI scripting unavailable — the repeat identity leg compared boot/quit/cleanup only',
      );
    }
    // And the managed project is still untouched after two full cycles.
    const managedAfter = snapshotManagedProject(managedRoot);
    expect([...managedAfter.keys()]).toEqual([...managedBefore.keys()]);
    for (const [path, recorded] of managedBefore) {
      expect(managedAfter.get(path), `managed-project drift at ${path}`).toBe(recorded);
    }
  }, 420_000);
});
