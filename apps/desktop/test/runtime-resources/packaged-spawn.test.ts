import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CONTROL_PLANE_ENTRY_RESOURCE_PATH,
  NODE_EXECUTABLE_RESOURCE_PATH,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_NODE_PIN,
  verifyPackagedAssets,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { describe, expect, it } from 'vitest';

/**
 * The packaged-layout spawn lane (#244, H2): the REAL assembled runtime
 * under `apps/desktop/resources/` — the exact stock Node 24.20.0 binary
 * and the real rebased control-plane entry — verified and spawned
 * through the same adapter the app boots with. This lane is
 * deterministic given the assembly and self-skips without it (the
 * certify:adapter precedent: real binaries never gate `npm test`, which
 * stays network-free; run `npm run assemble:runtime` to make it live).
 */
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESOURCES_ROOT = join(DESKTOP_ROOT, 'resources');
const BUNDLED_NODE = join(RESOURCES_ROOT, NODE_EXECUTABLE_RESOURCE_PATH);

const assemblyExists = existsSync(BUNDLED_NODE);
const execFileAsync = promisify(execFile);

describe.skipIf(!assemblyExists)('the assembled packaged runtime — real spawn (#244)', () => {
  it('verifies through the adapter the app boots with (every pin, hash, and layout law)', async () => {
    const verified = await verifyPackagedAssets({
      resourcesRoot: RESOURCES_ROOT,
      architecture: process.arch,
      electronVersion: PACKAGED_ELECTRON_PIN,
    });
    expect(verified).toEqual({
      nodeExecutable: BUNDLED_NODE,
      controlPlaneEntry: join(RESOURCES_ROOT, CONTROL_PLANE_ENTRY_RESOURCE_PATH),
      execArgv: [],
    });
  });

  it('the bundled executable IS exactly stock Node 24.20.0 — the wrong-Node guard on the real artifact', async () => {
    const { stdout } = await execFileAsync(BUNDLED_NODE, ['--version']);
    expect(stdout.trim()).toBe(PACKAGED_NODE_PIN);
    expect(stdout.trim()).toBe('v24.20.0');
  });

  it('spawns the rebased control-plane entry under the bundled Node — no dev loaders, plain ECMAScript', async () => {
    // The entry evaluates to its config discipline: without the JSON argv
    // config it fails with its own typed diagnostic and a nonzero exit —
    // proof the rebased bundle loads (ESM, module-type marker, external
    // builtins only) under the exact bundled executable.
    const outcome = await execFileAsync(BUNDLED_NODE, [
      join(RESOURCES_ROOT, CONTROL_PLANE_ENTRY_RESOURCE_PATH),
    ]).catch((error: unknown) => error as NodeJS.ErrnoException & { code?: unknown });
    expect(outcome).toBeInstanceOf(Error);
    const stderr = (outcome as { stderr?: string }).stderr ?? '';
    expect(stderr).toContain('astroix-desktop-child');
    expect((outcome as { code?: number | string }).code).not.toBe(0);
  }, 30_000);
});
