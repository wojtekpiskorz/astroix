// Types for the slices of scripts/oracle.mjs that typed modules import —
// the consumed-slice pattern of e2e/oracle.d.mts (#213). See scripts/oracle.mjs
// for the full disposable-oracle machinery; add declarations here as .ts
// consumers appear (it is a typed window, not a mirror).
/** Absolute path of the canonical plain fixture (e2e/fixture). */
declare const canonicalFixture: string;

export { canonicalFixture };
