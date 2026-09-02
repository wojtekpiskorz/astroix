import { describe, expect, it } from 'vitest';
import { minimalChildEnv } from '../../project-plane/supervision/exact-child.ts';

/**
 * The exact-child environment whitelist (#231 focused tests): the species
 * the D3 `minimalChildEnv` precedent set — a supervised child's
 * environment is an explicit whitelist, never an inheritance, so a
 * poisoned parent (NODE_OPTIONS, secrets, vitest/Vite state) can never
 * leak into a managed project's processes.
 */

const POISONED: Record<string, string | undefined> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/dev',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8',
  NODE_OPTIONS: '--require /nonexistent/pwned.cjs',
  NODE_ENV: 'test',
  VITE_XXX: '1',
  ASTROIX_SECRET: 'sekrit-token',
  GITHUB_TOKEN: 'gh-token',
  CI: 'true',
  SHELL: '/bin/zsh',
};

describe('minimalChildEnv', () => {
  it('keeps exactly the whitelist plus telemetry-off — nothing else crosses', () => {
    expect(minimalChildEnv(POISONED)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      ASTRO_TELEMETRY_DISABLED: '1',
    });
  });

  it('drops a poisoned NODE_OPTIONS — a child never inherits the parent node flags', () => {
    const env = minimalChildEnv(POISONED);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(Object.hasOwn(env, 'NODE_OPTIONS')).toBe(false);
  });

  it('drops secrets and shell/vitest state the child has no business seeing', () => {
    const env = minimalChildEnv(POISONED);
    for (const key of ['ASTROIX_SECRET', 'GITHUB_TOKEN', 'NODE_ENV', 'VITE_XXX', 'SHELL']) {
      expect(Object.hasOwn(env, key), key).toBe(false);
    }
  });

  it('omits whitelist keys the parent does not carry — no empty-string or undefined values', () => {
    const env = minimalChildEnv({ HOME: '/home/dev' });
    expect(env).toEqual({ HOME: '/home/dev', ASTRO_TELEMETRY_DISABLED: '1' });
    expect(minimalChildEnv({ PATH: '', HOME: undefined })).toEqual({
      ASTRO_TELEMETRY_DISABLED: '1',
    });
  });

  it('is a fresh record per call — no shared mutable environment between children', () => {
    const a = minimalChildEnv(POISONED);
    const b = minimalChildEnv(POISONED);
    expect(a).not.toBe(b);
    a.PATH = '/mutated';
    expect(b.PATH).toBe('/usr/bin:/bin');
  });
});
