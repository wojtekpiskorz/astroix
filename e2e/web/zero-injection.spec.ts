import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { stagedCopyRoot } from '../../apps/web/src/stage-e2e.ts';

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
/** The permitted side effects (CONTEXT.md): ordinary Astro/Vite caches and build output. */
const EXCLUDED_ENTRIES = new Set(['node_modules', '.astro', 'dist']);

const PROJECT_APP_URL = /^http:\/\/(?!launcher)[a-z2-7]+\.localhost:\d+\/__astroix\/app\/$/;
const LAUNCHER_APP_URL = /launcher\.localhost:\d+\/__astroix\/app\//;

/** The list item whose staged copy is at `position` (0 and 1 are the fixture copies; 2 is broken). */
function activateButton(page: Page, position: number) {
  return page.getByTestId('project-list').locator('li').nth(position).getByTestId('activate');
}

/**
 * One managed-project snapshot: every file's bytes (SHA-256) and
 * metadata (kind, mode, symlink target), keyed by project-relative
 * path — everything a hidden control file, bridge, config edit, or
 * manifest mutation would move.
 */
function snapshotProject(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_ENTRIES.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.set(relative, `symlink:${readlinkSync(full)}`);
        continue;
      }
      if (entry.isDirectory()) {
        entries.set(relative, 'directory');
        walk(full, relative);
        continue;
      }
      const bytes = readFileSync(full);
      entries.set(
        relative,
        `file:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`,
      );
    }
  };
  walk(root, '');
  return entries;
}

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
  await expect(page.getByTestId('session-label')).toHaveText('idle');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  // Start + inspect: the shell's live inspection and the loaded canvas.
  await expect(page.getByTestId('inspect-revision')).toHaveText(/^\d+$/);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  // Navigation through the canvas: the project's own natural route.
  await page.getByTestId('canvas-address').fill('/blog/hello-builder');
  await page.getByTestId('canvas-navigate').click();
  await expect(page.getByTestId('canvas-url')).toContainText('/blog/hello-builder');
  // Stop.
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');

  // A second start/stop cycle: nothing from the first run lingers as
  // state in the project on the second pass either.
  await page.goto('/__astroix/app/');
  await activateButton(page, 0).click();
  await page.waitForURL(PROJECT_APP_URL);
  await expect(page.getByTestId('canvas-origin-state')).toHaveText('project');
  await page.getByTestId('deactivate').click();
  await page.waitForURL(LAUNCHER_APP_URL);
  await expect(page.getByTestId('session-label')).toHaveText('idle');

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
