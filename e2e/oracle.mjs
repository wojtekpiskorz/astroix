// Disposable oracle locations (#213, ADR-0010): the canonical fixture
// (e2e/fixture) is a tracked plain Astro project with no Astroix import or
// dependency; the retired integration runs only through generated copies at
// these gitignored paths. Single source shared by the prepare scripts
// (scripts/oracle.mjs), playwright.config.ts and the specs — a hardcoding
// anywhere else drifts from the servers the lanes actually boot.
//
// Paths are repo-root-relative (specs and playwright run from the repo
// root); the prepare scripts resolve them against their own root. Cleanup is
// regenerate-on-setup: every prep pass rm-and-recreates the copy, so a
// leaked dirty file from a previous run cannot survive into the next —
// deterministic, never `git restore` (#213 AC).
export const ORACLE_MAIN = 'e2e/.oracle-fixture';
export const ORACLE_PACK = 'e2e/.oracle-pack';
export const ORACLE_SRC = 'e2e/.oracle-src';
