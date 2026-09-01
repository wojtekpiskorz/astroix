/**
 * Per-lane e2e ports (#120): canonical defaults for CI, env overrides for
 * parallel local lanes — each worktree runs its own pair, so sibling lanes
 * never share a port or a server. Single module so every consumer reads the
 * same numbers: during the no-E2E interval the consumers are the oracle
 * staging scripts and the coming B-lane capture suites (playwright.config.ts
 * carries no webServers until product e2e returns, #240) — a spec or script
 * hardcoding a port drifts from the server it drives.
 */
// `||`, not `??`: an empty-string export must fall through to the default the
// same way the `${VAR:-default}` dev scripts treat it — `Number('')` is 0.
// Parity is mechanism-only, not the numbers: the fixture scripts' own shell
// defaults stay off the canonical trio (main's manual `npm run dev` doubles
// as the dogfood server on the smoke port 4312, the src oracle's manual
// default is 4310) so a lane and a dogfood server never want the same port;
// this module owns the Playwright-driven defaults and the config always
// exports the var on that path.
export const MAIN_PORT = Number(process.env.ASTROIX_E2E_PORT || 4314);
export const PACK_PORT = Number(process.env.ASTROIX_E2E_PACK_PORT || 4313);
export const SRC_PORT = Number(process.env.ASTROIX_E2E_SRC_PORT || 4311);
// The where-strategy inspection-contract oracle (#216, lane B1): the second
// boot the B1 capture suite drives, so it lives beside the pair above — off
// the canonical trio and every manual dogfood default alike. Same `||`-not-
// `??` rule as the trio; consumers are e2e/contract-oracle/oracle-server.ts
// (re-export) and the where oracle's generated dev script.
export const WHERE_PORT = Number(process.env.ASTROIX_E2E_WHERE_PORT || 4395);
