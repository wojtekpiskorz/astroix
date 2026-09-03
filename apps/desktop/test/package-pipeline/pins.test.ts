import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
} from '@wojciechpiskorz/astroix-runtime/internal/packaged-assets';
import { describe, expect, it } from 'vitest';

/**
 * The exact-pin law (#245, H3; ADR-0008 initial pins): Forge is pinned
 * EXACTLY to 7.11.2 and Electron to 44.1.0 — no ranges, no semver
 * trust. The declared devDependencies and the INSTALLED tree are both
 * asserted (offline — this reads node_modules, it never installs), and
 * the pins are cross-checked against the runtime package's own pin
 * table (`packaged-assets.ts`), the one source ADR-0008 records. Every
 * pin change requires packaged requalification.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_PACKAGE_JSON = join(HERE, '..', '..', 'package.json');
const WORKSPACE_ROOT = join(HERE, '..', '..', '..', '..');

interface DesktopPackageJson {
  devDependencies: Record<string, string>;
}

describe('the packaging pins — declared and installed (#245)', () => {
  it('pinned Forge exactly to 7.11.2 in every @electron-forge/* devDependency', async () => {
    const pkg = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, 'utf8')) as DesktopPackageJson;
    const forgeDeps = Object.entries(pkg.devDependencies).filter(([name]) =>
      name.startsWith('@electron-forge/'),
    );
    expect(forgeDeps.length).toBeGreaterThanOrEqual(4); // cli, core, shared-types, plugin-fuses, maker-zip
    for (const [name, range] of forgeDeps) {
      expect(range, `${name} must be exactly ${PACKAGED_FORGE_PIN}`).toBe(PACKAGED_FORGE_PIN);
    }
  });

  it('pinned Electron exactly to 44.1.0 — no range', async () => {
    const pkg = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, 'utf8')) as DesktopPackageJson;
    expect(pkg.devDependencies.electron).toBe(PACKAGED_ELECTRON_PIN);
    expect(pkg.devDependencies.electron).toBe('44.1.0');
  });

  it('pins @electron/fuses exactly (no range syntax)', async () => {
    const pkg = JSON.parse(await readFile(DESKTOP_PACKAGE_JSON, 'utf8')) as DesktopPackageJson;
    expect(pkg.devDependencies['@electron/fuses']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the INSTALLED @electron-forge/* packages are exactly 7.11.2', async () => {
    for (const name of [
      '@electron-forge/cli',
      '@electron-forge/core',
      '@electron-forge/plugin-fuses',
      '@electron-forge/maker-zip',
    ]) {
      expect(await readInstalledVersion(name), `${name} installed version`).toBe(
        PACKAGED_FORGE_PIN,
      );
    }
  });

  it('the INSTALLED electron is exactly 44.1.0', async () => {
    expect(await readInstalledVersion('electron')).toBe(PACKAGED_ELECTRON_PIN);
  });

  it("the pin table itself records ADR-0008's Forge pin", () => {
    expect(PACKAGED_FORGE_PIN).toBe('7.11.2');
    expect(PACKAGED_ELECTRON_PIN).toBe('44.1.0');
  });
});

/**
 * Reads the installed version straight from the hoisted workspace
 * `node_modules` manifest — no `require.resolve` (the Forge CLI package
 * declares no main), no network, no install.
 */
async function readInstalledVersion(name: string): Promise<string> {
  const manifestPath = join(WORKSPACE_ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`pins: ${name} is not installed (expected ${manifestPath}) — run npm install`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
  return manifest.version;
}
