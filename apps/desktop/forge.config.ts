import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import FusesPlugin from '@electron-forge/plugin-fuses';
import type { ForgeConfig } from '@electron-forge/shared-types';
import {
  PRODUCT_ARCH,
  PRODUCT_BUNDLE_ID,
  PRODUCT_MINIMUM_MACOS,
  PRODUCT_NAME,
  PRODUCT_PLATFORM,
} from './src/forge/product.ts';
import { RELEASE_FUSE_CONFIG } from './src/forge/release-fuses.ts';

/**
 * The hardened Forge wiring (#245, H3; ADR-0008 packager and runtime
 * layout): Electron Forge — pinned exactly 7.11.2 — using **Packager**,
 * the **FusesPlugin**, and the **ZIP maker**. The Forge Vite plugin is
 * NOT part of this pipeline: the main bundle is the workspace's own
 * vite build (`apps/desktop/smoke/build-main.mjs`, the H1 builder), and
 * the packaged runtime resources are H2's assembly
 * (`npm run assemble:runtime`) — the packaging step composes those
 * inputs, it never builds differently for packaging.
 *
 * The v1 product shape (ADR-0008): exactly one macOS `arm64` app,
 * minimum-OS metadata 13.5, no Intel/universal/DMG/notarization/
 * auto-update output. The pipeline runs it as
 * `electron-forge package --platform darwin --arch arm64` followed by
 * its own explicit stages (sign → verify → zip → extract-verify —
 * `apps/desktop/scripts/package.mjs`), because the ad-hoc signature
 * must come AFTER all resources and fuses are final, nested executable
 * code before the outer app (`src/forge/codesign.ts`).
 *
 * Accepted residual, recorded per the #245 readiness carry-note: the
 * verify-then-spawn TOCTOU window is accepted under ADR-0008's threat
 * model; a future Developer-ID-signed + notarized bundle is the lane
 * that revisits it (the unsigned artifact is deliberately ad-hoc
 * sealed, and Gatekeeper rejection is expected — `spctl` is not a
 * gate).
 */

const APP_ROOT = dirname(fileURLToPath(import.meta.url));

/** The immutable resource subtrees H2's assembly builds and Packager copies as REAL files outside the asar. */
export const PACKAGED_RESOURCE_SUBTREES: readonly string[] = Object.freeze([
  join(APP_ROOT, 'resources', 'astroix-runtime'),
  join(APP_ROOT, 'resources', 'node'),
]);

/** The packaged platform/arch pair the pipeline always passes to Forge (`--platform darwin --arch arm64`). */
export const PACKAGED_TARGET: Readonly<{ platform: string; arch: string }> = Object.freeze({
  platform: PRODUCT_PLATFORM,
  arch: PRODUCT_ARCH,
});

/**
 * The asar payload allowlist, as Packager's ignore function sees it
 * (app-relative names with a leading slash; the app root itself arrives
 * as `''`). Everything not named here — `src/`, `test/`, `smoke/`,
 * `scripts/`, `forge.config.ts`, `node_modules/`, and `resources/`
 * (which travels as extraResource, never inside the asar) — is excluded
 * from the asar: the bundled `dist-main/main.js` is self-contained (the
 * workspace runtime and protocol bundle in; only `electron` and node
 * builtins stay external).
 */
function ignoreAppTree(name: string): boolean {
  if (name === '') return false;
  if (name === '/package.json') return false;
  if (name === '/dist-main' || name.startsWith('/dist-main/')) return false;
  return true;
}

const config: ForgeConfig = {
  packagerConfig: {
    name: PRODUCT_NAME,
    appBundleId: PRODUCT_BUNDLE_ID,
    asar: true,
    // minimum-OS metadata 13.5 — the packaged app's deployment target
    extendInfo: {
      LSMinimumSystemVersion: PRODUCT_MINIMUM_MACOS,
    },
    // the bundled Node executable and the immutable runtime tree: real
    // files under Contents/Resources/, never inside app.asar (ADR-0008)
    extraResource: [...PACKAGED_RESOURCE_SUBTREES],
    ignore: ignoreAppTree,
    // NOTE: osxSign / osxNotarize stay deliberately UNSET. Ad-hoc
    // signing with identity '-' is this pipeline's own explicit stage
    // (nested code first, outer app last) so the signature is applied
    // after resources AND fuses are final — a packager-time signature
    // would also predate the extra resources. Notarization and
    // auto-update are explicit v1 non-goals (ADR-0008).
  },
  rebuildConfig: {},
  publishers: [],
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: [PRODUCT_PLATFORM],
      // no macUpdateManifestBaseUrl: no RELEASES.json, no auto-update
      // output — the ZIP is the sole deliverable (ADR-0008)
      config: {},
    },
  ],
  plugins: [
    // the release fuse law lives in one place —
    // apps/desktop/src/forge/release-fuses.ts — so the config that
    // applies the fuses and the verification that reads them back can
    // never drift apart. resetAdHocDarwinSignature is false inside it:
    // signing is the pipeline's own post-package stage. The plugin gets
    // a shallow COPY: Forge's config renderer mutates the config tree
    // it walks, and the frozen law stays frozen.
    new FusesPlugin({ ...RELEASE_FUSE_CONFIG }),
  ],
};

export default config;
