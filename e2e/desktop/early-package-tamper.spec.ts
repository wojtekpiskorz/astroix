import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILD_MANIFEST_RESOURCE_PATH } from '../../packages/runtime/src/internal/packaged-assets.ts';
import {
  extractPackagedApp,
  makeStagingRoot,
  PACKAGE_ZIP,
  PackagedAppRun,
  processesReferencing,
  removeStaging,
  sanitizationFindings,
} from './early-package-kit.ts';

/**
 * The prelaunch rejection legs (#248, H6 focused tests): the packaged
 * fail-closed law firing in the REAL extracted package — tampered
 * resources, a swapped bundled Node, and a tampered manifest pin all
 * reject BEFORE activation, with the sanitized diagnostic vocabulary
 * (codes and relative resource ids only — never an absolute packaged
 * path, never a hash), exit code 1, no control-plane child ever
 * spawned, and no fallback (a perfectly working different Node sits
 * right beside the bundle and is never used — ADR-0008's no-fallback
 * law, proven live rather than asserted).
 *
 * Each leg tampers its OWN fresh extraction of the same ZIP: the exact
 * artifact, mutated the way a real attacker or a broken copy would be.
 */

const execFileAsync = promisify(execFile);

let staging: string;
const appRuns: PackagedAppRun[] = [];

beforeAll(async () => {
  staging = await makeStagingRoot('astroix-early-tamper-');
}, 300_000);

afterAll(async () => {
  for (const run of appRuns.splice(0)) await run.killForCleanup();
  await removeStaging(staging);
});

describe.skipIf(!PACKAGE_ZIP)(
  'the exact packaged host — prelaunch tamper and wrong-Node rejections (#248)',
  () => {
    it('rejects a tampered runtime resource byte before activation, sanitized, childless', async () => {
      const appPath = await extractPackagedApp(
        PACKAGE_ZIP as string,
        join(staging, 'resource-tamper'),
      );
      // one byte appended to the rebased control-plane entry — the hash law
      const entry = join(
        appPath,
        'Contents',
        'Resources',
        'astroix-runtime',
        'control-plane',
        'child.js',
      );
      await writeFile(entry, `${await readFile(entry, 'utf8')}\n`);
      const outcome = await launchAndCollect(appPath, join(staging, 'resource-tamper'));
      expectRefused(outcome, 'resource-tampered', 'astroix-runtime/control-plane/child.js');
    }, 180_000);

    it('rejects a swapped bundled Node before activation — a working different Node is never a fallback', async () => {
      const appPath = await extractPackagedApp(PACKAGE_ZIP as string, join(staging, 'wrong-node'));
      // a REAL, working, same-architecture Node over the bundled slot: the
      // byte hash is the identity, and identity is the only authority
      const bundled = join(appPath, 'Contents', 'Resources', 'node', 'bin', 'node');
      await execFileAsync('cp', [process.execPath, bundled], { timeout: 60_000 });
      await execFileAsync('chmod', ['755', bundled]);
      const outcome = await launchAndCollect(appPath, join(staging, 'wrong-node'));
      expectRefused(outcome, 'resource-tampered', 'node/bin/node');
      // The no-fallback law, observed: the refused boot never searched for
      // a substitute (the swapped binary itself was runnable).
      expect(
        outcome.stderrLines.some((line) => line.includes('there is no fallback')),
        'the diagnostic states the no-fallback law',
      ).toBe(true);
    }, 180_000);

    it('rejects a tampered manifest pin before activation, with pin-level detail only', async () => {
      const appPath = await extractPackagedApp(PACKAGE_ZIP as string, join(staging, 'pin-tamper'));
      // the manifest is not hash-pinned by itself — the pin table is its
      // own law: a wrong Node pin is a pin-mismatch, printed with field
      // and version strings only
      const manifestPath = join(
        appPath,
        'Contents',
        'Resources',
        ...BUILD_MANIFEST_RESOURCE_PATH.split('/'),
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.node = 'v0.0.0-tampered';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const outcome = await launchAndCollect(appPath, join(staging, 'pin-tamper'));
      expectRefused(outcome, 'pin-mismatch', undefined);
      expect(
        outcome.stderrLines.some(
          (line) => line.includes('field=node') && line.includes('v0.0.0-tampered'),
        ),
        'the pin mismatch prints field-level detail',
      ).toBe(true);
    }, 180_000);
  },
);

interface RefusedRun {
  readonly run: PackagedAppRun;
  readonly exitCode: number | null;
  readonly stderrLines: readonly string[];
}

/** Launches one tampered extraction and awaits its fail-closed exit. */
async function launchAndCollect(appPath: string, isolationRoot: string): Promise<RefusedRun> {
  const run = new PackagedAppRun(appPath, {
    staging: isolationRoot,
    home: join(isolationRoot, 'home'),
    userData: join(isolationRoot, 'user-data'),
  });
  appRuns.push(run);
  const exit = await Promise.race([
    run.exit,
    new Promise<{ code: number | null; signal: string | null }>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `the tampered app did not refuse (still running); stderr:\n${run.stderrLines.join('\n')}`,
            ),
          ),
        60_000,
      ),
    ),
  ]);
  // No orphaned child: the refusal precedes any spawn, so not even the
  // control-plane child may linger around the tampered extraction.
  const strays = await processesReferencing(isolationRoot);
  expect(strays, `orphaned processes after the refusal: ${JSON.stringify(strays)}`).toEqual([]);
  return { run, exitCode: exit.code, stderrLines: run.stderrLines };
}

/** The one fail-closed law every tamper leg asserts: sanitized refusal, exit 1, nothing booted, nothing spawned. */
function expectRefused(outcome: RefusedRun, code: string, resource: string | undefined): void {
  expect(outcome.exitCode, 'the refused boot exits 1').toBe(1);
  const diagnostic = outcome.stderrLines.find((line) => line.includes(`code=${code}`));
  expect(
    diagnostic,
    `the sanitized ${code} diagnostic (stderr: ${outcome.stderrLines.join(' | ')})`,
  ).toBeDefined();
  if (resource !== undefined) {
    expect(
      diagnostic?.includes(`resource=${resource}`),
      'the diagnostic names the relative resource id',
    ).toBe(true);
  }
  // Sanitized: the diagnostic passes the SAME disclosure guard the
  // product's public log does (findDisclosure — any absolute-path shape
  // wherever it points, home-relative, drive/UNC, PID, port, env
  // values) plus the lane's 64-hex digest law. No root-membership
  // shortcut: a leaked path leaks regardless of where it points.
  expect(
    sanitizationFindings(diagnostic === undefined ? [] : [diagnostic]),
    'the diagnostic carries no disclosure shape and no digest',
  ).toEqual([]);
  // Refused BEFORE activation: no boot completed, no child ever spawned.
  expect(outcome.run.events, 'no product event ever fired').toEqual([]);
  expect(outcome.run.stdoutLines.join('\n')).not.toContain('control-plane-booted');
}
