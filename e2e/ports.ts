/**
 * Per-lane e2e ports (#120): canonical defaults for CI, env overrides for
 * parallel local lanes — each worktree runs its own pair, so sibling lanes
 * never share a port or a server. Single module because playwright.config.ts
 * and the specs must read the same numbers: a spec hardcoding a port drifts
 * from the webServer it drives.
 */
export const MAIN_PORT = Number(process.env.ASTROIX_E2E_PORT ?? 4314);
export const PACK_PORT = Number(process.env.ASTROIX_E2E_PACK_PORT ?? 4313);
