import FusesPlugin from '@electron-forge/plugin-fuses';
import { describe, expect, it } from 'vitest';
import forgeConfig, { PACKAGED_RESOURCE_SUBTREES } from '../../forge.config.ts';
import { PRODUCT_BUNDLE_ID, PRODUCT_MINIMUM_MACOS, PRODUCT_NAME } from '../../src/forge/product.ts';
import { RELEASE_FUSE_CONFIG } from '../../src/forge/release-fuses.ts';

/**
 * The Forge config law (#245, H3; ADR-0008 packager layout): Electron
 * Forge pinned exactly 7.11.2 driven through Packager, the FusesPlugin,
 * and the ZIP maker — with the negative surface pinned as hard as the
 * positive one: no Forge Vite plugin (the packaged main is the same
 * bundle the dev workflow builds), no DMG maker, no notarization, no
 * auto-update manifest, no packager-time signing (the pipeline's own
 * stage signs after resources and fuses are final), and no
 * release-runtime fallback — the packaged app never runs the release
 * runtime differently from the fast workflows (the same assemble +
 * build inputs compose in).
 */

const packagerConfig = forgeConfig.packagerConfig ?? {};

describe('the Forge config — packager wiring (#245)', () => {
  it('stamps the ADR-0008 product identity: name Astroix, bundle id dev.astroix.app, min macOS 13.5', () => {
    expect(packagerConfig.name).toBe(PRODUCT_NAME);
    expect(packagerConfig.appBundleId).toBe(PRODUCT_BUNDLE_ID);
    expect(packagerConfig.extendInfo).toMatchObject({
      LSMinimumSystemVersion: PRODUCT_MINIMUM_MACOS,
    });
  });

  it('packages the app into an asar with only the bundled main and the package manifest', () => {
    expect(packagerConfig.asar).toBe(true);
    const ignore = packagerConfig.ignore;
    expect(typeof ignore).toBe('function');
    if (typeof ignore !== 'function') return;
    expect(ignore('')).toBe(false); // the app root
    expect(ignore('/package.json')).toBe(false);
    expect(ignore('/dist-main')).toBe(false);
    expect(ignore('/dist-main/main.js')).toBe(false);
    // everything else stays out of the asar — the resources travel as
    // real files (extraResource), the sources/test/tooling never ride along
    expect(ignore('/src/main/index.ts')).toBe(true);
    expect(ignore('/test/package-pipeline/forge-config.test.ts')).toBe(true);
    expect(ignore('/smoke/build-main.mjs')).toBe(true);
    expect(ignore('/scripts/package.mjs')).toBe(true);
    expect(ignore('/forge.config.ts')).toBe(true);
    expect(ignore('/node_modules')).toBe(true);
    expect(ignore('/resources/astroix-runtime/control-plane/child.js')).toBe(true);
    expect(ignore('/resources/node/bin/node')).toBe(true);
  });

  it('copies the two immutable resource subtrees as REAL files outside the asar (ADR-0008 layout)', () => {
    expect(PACKAGED_RESOURCE_SUBTREES).toHaveLength(2);
    expect(PACKAGED_RESOURCE_SUBTREES[0]?.endsWith(joinPosix('resources', 'astroix-runtime'))).toBe(
      true,
    );
    expect(PACKAGED_RESOURCE_SUBTREES[1]?.endsWith(joinPosix('resources', 'node'))).toBe(true);
    expect(packagerConfig.extraResource).toEqual([...PACKAGED_RESOURCE_SUBTREES]);
  });

  it('does NOT sign or notarize at packager time — the pipeline signs after resources and fuses are final', () => {
    expect(packagerConfig.osxSign).toBeUndefined();
    expect(packagerConfig.osxNotarize).toBeUndefined();
  });
});

describe('the Forge config — the ZIP maker, the sole deliverable (#245)', () => {
  it('declares exactly one maker: the ZIP maker, for darwin only', () => {
    expect(forgeConfig.makers).toHaveLength(1);
    const maker = forgeConfig.makers?.[0] as { name: string; platforms?: string[] };
    expect(maker.name).toBe('@electron-forge/maker-zip');
    expect(maker.platforms).toEqual(['darwin']);
  });

  it('configures no auto-update manifest (no RELEASES.json output)', () => {
    const maker = forgeConfig.makers?.[0] as { name: string; config?: Record<string, unknown> };
    expect(maker.config?.macUpdateManifestBaseUrl).toBeUndefined();
  });

  it('declares no DMG maker — DMG is an ADR-0008 explicit non-goal', () => {
    const names = (forgeConfig.makers ?? []).map((maker) => (maker as { name: string }).name);
    expect(names.some((name) => name.includes('dmg'))).toBe(false);
  });

  it('declares no publishers — nothing is uploaded from a packaging run', () => {
    expect(forgeConfig.publishers ?? []).toHaveLength(0);
  });
});

describe('the Forge config — the FusesPlugin, and nothing else (#245)', () => {
  it('runs exactly one plugin: the FusesPlugin over the release fuse law', () => {
    expect(forgeConfig.plugins).toHaveLength(1);
    const plugin = forgeConfig.plugins?.[0];
    expect(plugin).toBeInstanceOf(FusesPlugin);
    expect((plugin as { name: string }).name).toBe('fuses');
  });

  it('applies the release fuse law verbatim — one source of truth, no drift', () => {
    const plugin = forgeConfig.plugins?.[0] as { fusesConfig?: unknown };
    expect(plugin.fusesConfig).toEqual(RELEASE_FUSE_CONFIG);
  });

  it('keeps the FusesPlugin from signing (resetAdHocDarwinSignature false) — signing is the pipeline stage', () => {
    expect(RELEASE_FUSE_CONFIG.resetAdHocDarwinSignature).toBe(false);
  });

  it('uses NO Forge Vite/Webpack plugin — the packaging never builds differently than dev', () => {
    const names = (forgeConfig.plugins ?? []).map((plugin) => (plugin as { name: string }).name);
    expect(names.some((name) => name.includes('vite') || name.includes('webpack'))).toBe(false);
  });
});

function joinPosix(...segments: string[]): string {
  return segments.join('/');
}
