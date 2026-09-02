import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError } from '../../astro-project-adapter/adapter-error';
import { CERTIFIED_PAIRS } from '../../astro-project-adapter/certified-pair';
import { certifyPairBeforeConfig } from '../../astro-project-adapter/pair-gate';
import { removeStubInstalls, stageStubInstall } from './stub-install';

/**
 * The pair gate (#225 AC): every unlisted pair fails BEFORE the
 * managed-project config callback runs, reporting detected pair,
 * certified pairs, and rejected contract. Astro and Vite resolve from
 * the managed project's installation — stubbed here at the resolution
 * layer only (fake manifests, no behavior layer).
 */

const scratchDirs: string[] = [];

async function stubProject(pair: { astro: string; vite: string }): Promise<string> {
  const root = await stageStubInstall(pair);
  scratchDirs.push(root);
  return root;
}

afterEach(async () => {
  await removeStubInstalls(scratchDirs.splice(0));
});

describe('certifyPairBeforeConfig', () => {
  it('passes the exact certified pair to the config callback', async () => {
    const root = await stubProject({ astro: '7.2.10', vite: '8.2.2' });
    let configRuns = 0;
    const result = await certifyPairBeforeConfig({ projectRoot: root }, async (pair) => {
      configRuns += 1;
      return `config-of-${pair.astro}`;
    });
    expect(configRuns).toBe(1);
    expect(result).toBe('config-of-7.2.10');
  });

  it('rejects an uncertified pair before the config callback executes', async () => {
    const root = await stubProject({ astro: '7.2.10', vite: '8.2.1' });
    let configRuns = 0;
    const rejection = await certifyPairBeforeConfig({ projectRoot: root }, async () => {
      configRuns += 1;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(configRuns).toBe(0);
    expect(rejection).toBeInstanceOf(AdapterError);
    const error = rejection as AdapterError;
    expect(error.code).toBe('uncertified-pair');
    expect(error.details).toEqual({
      detected: { astro: '7.2.10', vite: '8.2.1' },
      certified: [{ astro: '7.2.10', vite: '8.2.2' }],
      rejectedContract:
        'exact Astro/Vite pair certification must pass before project config executes',
    });
    expect(error.message).toBe(
      'AstroProjectAdapter compatibility rejection: detected astro@7.2.10 + vite@8.2.1; certified pairs: astro@7.2.10 + vite@8.2.2; failed contract: exact Astro/Vite pair certification must pass before project config executes',
    );
  });

  it('never reads the project config while rejecting — resolution only', async () => {
    // The callback is the only thing that could execute config; proving it
    // never runs (above) plus the resolution-only reads (the stub has no
    // config, no astro code, only manifests) is the before-config proof.
    const root = await stubProject({ astro: '7.2.0', vite: '8.2.2' });
    await expect(certifyPairBeforeConfig({ projectRoot: root }, async () => 'ran')).rejects.toThrow(
      /detected astro@7\.2\.0 \+ vite@8\.2\.2/,
    );
  });

  it('certifies against the supplied set (the certification-fixture override)', async () => {
    const root = await stubProject({ astro: '7.3.0', vite: '8.3.0' });
    const certifiedPairs = [{ astro: '7.3.0', vite: '8.3.0' }];
    expect(
      await certifyPairBeforeConfig({ projectRoot: root, certifiedPairs }, async (pair) => pair),
    ).toEqual({ astro: '7.3.0', vite: '8.3.0' });
    // The default set still rejects the same pair.
    await expect(certifyPairBeforeConfig({ projectRoot: root }, async () => 'ran')).rejects.toThrow(
      /certified pairs: astro@7\.2\.10 \+ vite@8\.2\.2/,
    );
  });

  it('surfaces resolution failures as dependency-unresolved, not uncertified-pair', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astroix-pair-gate-empty-')));
    scratchDirs.push(root);
    await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
    await expect(
      certifyPairBeforeConfig({ projectRoot: root }, async () => 'ran'),
    ).rejects.toMatchObject({
      code: 'dependency-unresolved',
    });
  });

  it('the default certified set is the exact certified pair, never a range', () => {
    expect(CERTIFIED_PAIRS).toHaveLength(1);
    expect(CERTIFIED_PAIRS[0]).toEqual({ astro: '7.2.10', vite: '8.2.2' });
  });
});
