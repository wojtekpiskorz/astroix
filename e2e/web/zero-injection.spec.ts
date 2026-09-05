import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';
import { snapshotManagedProject as snapshotProject } from '../managed-project-snapshot.ts';
import {
  activateButton,
  BOOT_BUDGET_MS,
  LOAD_BUDGET_MS,
  PROJECT_APP_URL,
  recordLandedSession,
  restoreIdle,
} from './spec-helpers.ts';

/**
 * The zero-injection battery (#242, G3) — the guarantee the whole
 * product stands on (CONTEXT.md "zero-injection guarantee"), proven on
 * the MANAGED copy itself across the full hosting loop: registration
 * (boot-time, control-plane-side), start, inspect, navigation, and
 * stop leave the project's bytes and metadata untouched — no Astroix
 * dependency, integration, generated bridge, config or manifest
 * mutation, and no hidden control file; ordinary Astro/Vite caches
 * (`.astro/`, the linked installation, build output) are the permitted
 * side effects and are excluded by name. After being hosted, the
 * managed project still builds with ZERO astroix bytes in its output
 * (the case-sensitive rule of the canonical plain-build smoke, applied
 * to the copy that was actually hosted), and the tracked canonical
 * fixture stayed plain throughout.
 *
 * Runs after the canvas battery (the lane's alphabetical, serial
 * order): the BEFORE snapshot therefore also re-proves that battery's
 * promised in-place restores.
 */

const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROJECT_A = stagedCopyRoot('project-a');

/** Every file below one directory — the build-output scan's walker. */
function collectFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else files.push(full);
  }
  return files;
}

test.describe.configure({ mode: 'serial' });

test('a full hosting loop leaves the managed project untouched — bytes and metadata identical', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const before = snapshotProject(PROJECT_A);
  // The snapshot sees the real project surface (the fixture's sources).
  expect(before.size).toBeGreaterThan(5);
  expect([...before.keys()]).toContain('src/pages/index.astro');
  expect([...before.keys()]).toContain('package.json');

  await page.goto('/__astroix/app/');
  await expect(page.getByTestId('session-label')).toHaveText('idle', { timeout: LOAD_BUDGET_MS });
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await recordLandedSession(page);
  // Start + inspect: the shell's live inspection and the loaded canvas.
  // Load-shaped landing waits, sized for a shared CI runner (#392).
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/, {
    timeout: LOAD_BUDGET_MS,
  });
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  // Navigation through the canvas: the project's own natural route.
  await page.getByTestId('canvas-address').fill('/blog/hello-builder');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toContainText('/blog/hello-builder', {
    timeout: LOAD_BUDGET_MS,
  });
  // Stop.
  await restoreIdle(page);

  // A second start/stop cycle: nothing from the first run lingers as
  // state in the project on the second pass either.
  await page.goto('/__astroix/app/');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL, { timeout: BOOT_BUDGET_MS });
  await recordLandedSession(page);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project', {
    timeout: LOAD_BUDGET_MS,
  });
  await restoreIdle(page);

  const after = snapshotProject(PROJECT_A);
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [path, recorded] of before) {
    expect(after.get(path), `managed-project drift at ${path}`).toBe(recorded);
  }
});

test('the hosted project still builds with zero astroix bytes, and the canonical fixture stayed plain', () => {
  test.setTimeout(180_000);
  execSync('npm run build', { cwd: PROJECT_A, stdio: 'pipe' });

  const files = collectFiles(join(PROJECT_A, 'dist'));
  expect(files.length).toBeGreaterThan(0);
  // Case-sensitive like the canonical plain-build smoke: the fixture's
  // own copy says "Astroix fixture" (capital A); any lowercase
  // 'astroix' producer means something injected itself into the
  // managed project's build.
  const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('astroix'));
  expect(offenders).toEqual([]);

  // The tracked canonical fixture never hosted anything at all: its
  // worktree status stayed clean (the staged copies — and only they —
  // carried the dev servers).
  const status = execSync('git status --porcelain -- e2e/fixture', {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
  });
  expect(status.trim()).toBe('');
});
