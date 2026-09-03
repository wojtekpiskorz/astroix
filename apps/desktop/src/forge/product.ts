/**
 * Product identity for the packaged artifact (#245, H3; ADR-0008
 * identity and delivery): the ONE place that names the product facts
 * both the Forge wiring (`forge.config.ts`) and the packaging
 * verification (`src/forge/package-verification.ts`) rule on, so the
 * stamped artifact and the checks that read it back cannot drift.
 */

/** Product name (ADR-0008): `Astroix`. */
export const PRODUCT_NAME = 'Astroix';
/** Bundle identifier (ADR-0008): `dev.astroix.app`. */
export const PRODUCT_BUNDLE_ID = 'dev.astroix.app';
/** Minimum macOS (ADR-0008): 13.5 — the official Node 24 floor, the bundled runtime's floor. */
export const PRODUCT_MINIMUM_MACOS = '13.5';
/** The one supported product shape (ADR-0008): macOS arm64, nothing else. */
export const PRODUCT_PLATFORM = 'darwin';
export const PRODUCT_ARCH = 'arm64';
