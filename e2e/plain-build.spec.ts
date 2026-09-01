import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The only e2e during the no-E2E interval (ADR-0010, amended 2026-09-01:
// the interval starts at the plain-fixture conversion, not retirement —
// owner ruling on #197). Serverless by design: no oracle prep, no webServer,
// no browser. It guards exactly one thing — the canonical fixture is a
// plain Astro project that installs, builds, and stands alone (#213 AC-3).
// The B lanes' capture suites replace the retired legacy suite here.
const FIXTURE = join('e2e', 'fixture');

test('the canonical plain fixture builds with zero astroix bytes', () => {
  execSync('npm run build', { cwd: FIXTURE, stdio: 'pipe' });
  const dist = join(FIXTURE, 'dist');

  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) collect(full);
      else files.push(full);
    }
  };
  collect(dist);
  expect(files.length).toBeGreaterThan(0);

  // Case-sensitive: the fixture hero says "Astroix fixture" (capital A) —
  // any lowercase-'astroix' producer means something injected itself back
  // into the canonical project.
  const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('astroix'));
  expect(offenders).toEqual([]);
});
