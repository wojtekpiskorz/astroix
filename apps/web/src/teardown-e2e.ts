import { rm } from 'node:fs/promises';
import { settleMemoPath, WEB_E2E_SCRATCH_ENV } from './stage-e2e.ts';

/**
 * The web lane's teardown (#240, #350): removes the scratch root the
 * config-load staging created — the staged fixture copies, the broken
 * root, the isolated registry, and the env file — plus the
 * warm-activation memo (#433 round 2), which lives OUTSIDE the root by
 * design (it must survive every mid-invocation staging wipe) and so
 * must die here, never with the root: one JSON per invocation, never
 * one accumulating per run beside the default nonce roots. The root is
 * per-invocation (nonce) by default, so it is learned from the
 * environment the staging published, never a fixed path (the constant's
 * name is the only thing shared with stage-e2e — module state may not
 * be, Playwright loads the teardown as its own module). Unset means
 * staging never ran (a config-load failure): nothing to remove.
 */

export default async function globalTeardown(): Promise<void> {
  const scratchRoot = process.env[WEB_E2E_SCRATCH_ENV];
  if (scratchRoot !== undefined && scratchRoot !== '') {
    await rm(scratchRoot, { recursive: true, force: true });
    await rm(settleMemoPath(), { force: true });
  }
}
