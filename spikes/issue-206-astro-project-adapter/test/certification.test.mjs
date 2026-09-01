import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { certifyProjectBeforeConfig } from '../src/certification.mjs';

const CERTIFIED = [{ astro: '7.2.10', vite: '8.2.2' }];

test('an exact installed Astro/Vite pair reaches project config', async (t) => {
  const projectRoot = await fakeProject(t, { astro: '7.2.10', vite: '8.2.2' });
  let configRuns = 0;

  const result = await certifyProjectBeforeConfig(
    { certifiedPairs: CERTIFIED, projectRoot },
    async (pair) => {
      configRuns += 1;
      return pair;
    },
  );

  assert.deepEqual(result, { astro: '7.2.10', vite: '8.2.2' });
  assert.equal(configRuns, 1);
});

test('an uncertified pair is rejected before project config with the full contract', async (t) => {
  const projectRoot = await fakeProject(t, { astro: '7.2.10', vite: '8.2.1' });
  let configRuns = 0;

  await assert.rejects(
    certifyProjectBeforeConfig({ certifiedPairs: CERTIFIED, projectRoot }, async () => {
      configRuns += 1;
    }),
    {
      message:
        'AstroProjectAdapter compatibility rejection: detected astro@7.2.10 + vite@8.2.1; certified pairs: astro@7.2.10 + vite@8.2.2; failed contract: exact Astro/Vite pair certification must pass before project config executes',
    },
  );
  assert.equal(configRuns, 0);
});

async function fakeProject(t, pair) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'astroix-certification-test-'));
  t.after(() => rm(projectRoot, { force: true, recursive: true }));
  await writeFile(join(projectRoot, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const [name, version] of Object.entries(pair)) {
    const packageRoot = join(projectRoot, 'node_modules', name);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  }
  return projectRoot;
}
