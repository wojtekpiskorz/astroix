import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The web lane's teardown (#240): removes the whole scratch root the
 * config-load staging created — the staged fixture copies, the broken
 * root, the isolated registry, and the env file. A separate module
 * because Playwright's `globalTeardown` is a path (the config-load
 * staging and the teardown may not share module state).
 */

const SCRATCH_ROOT = join(tmpdir(), 'astroix-web-240');

export default async function globalTeardown(): Promise<void> {
  await rm(SCRATCH_ROOT, { recursive: true, force: true });
}
