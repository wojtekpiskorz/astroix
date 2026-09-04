import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PACKAGED_CERTIFIED_PAIR,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_FORGE_PIN,
  PACKAGED_NODE_PIN,
} from '../../packages/runtime/src/internal/packaged-assets.ts';

/**
 * The synthetic-artifact builder of the qualification harness tests
 * (#258, L1): one shared factory for fake candidate ZIPs — the exact
 * app shape the intake law expects (one `Astroix.app`, executable,
 * parseable `Info.plist`), optionally carrying a self-consistent
 * resource tree with real hashes (the assembler's discipline, at stub
 * scale) so the battery-stage legs reach their SPECIFIC verdicts
 * instead of dying at the first missing file.
 *
 * Test machinery only — never imported by the harness itself.
 */

const execFileAsync = promisify(execFile);

/** A minimal, `plutil`-parseable `Info.plist`. */
const MINIMAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Astroix</string>
  <key>CFBundleIdentifier</key><string>dev.astroix.app</string>
  <key>LSMinimumSystemVersion</key><string>13.5</string>
</dict>
</plist>
`;

/** The well-behaved stub executable: stays up, exits 0 on SIGTERM. */
export const STUB_APP_SCRIPT = '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 0.2; done\n';

/** The stub bundled Node's identity report — one fixed JSON object, whatever the arguments. */
export const STUB_NODE_REPORT = (version: string, abi = '137'): string =>
  `#!/bin/sh\nprintf '%s' '{"version":"${version}","abi":${JSON.stringify(abi)}}'\n`;

export interface SyntheticResources {
  /** The version the bundled-Node stub REPORTS when executed. */
  readonly executedNodeVersion?: string;
  /** The version the build manifest DECLARES. */
  readonly declaredNodeVersion?: string;
  /** Replace the control-plane entry with a symlink to a file outside the bundle. */
  readonly symlinkEntry?: boolean;
  /** Drop one unlisted file inside the ratified `astroix-runtime` subtree. */
  readonly extraResourceFile?: boolean;
}

export interface SyntheticArtifact {
  readonly zipPath: string;
  readonly sha256: string;
}

/** Builds one synthetic candidate ZIP at `zipPath` (rebuilt each call). */
export async function buildSyntheticZip(
  zipPath: string,
  resources: SyntheticResources = {},
): Promise<SyntheticArtifact> {
  const buildDir = `${zipPath}.build`;
  await execFileAsync('rm', ['-rf', buildDir]);
  const appPath = join(buildDir, 'Astroix.app');
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(join(appPath, 'Contents', 'Resources', 'astroix-runtime', 'control-plane'), {
    recursive: true,
  });
  await mkdir(join(appPath, 'Contents', 'Resources', 'node', 'bin'), { recursive: true });
  await writeFile(join(appPath, 'Contents', 'Info.plist'), MINIMAL_PLIST);
  const executable = join(appPath, 'Contents', 'MacOS', 'Astroix');
  await writeFile(executable, STUB_APP_SCRIPT);
  await chmod(executable, 0o755);
  const resourcesRoot = join(appPath, 'Contents', 'Resources');
  const nodeBinary = join(resourcesRoot, 'node', 'bin', 'node');
  await writeFile(nodeBinary, STUB_NODE_REPORT(resources.executedNodeVersion ?? PACKAGED_NODE_PIN));
  await chmod(nodeBinary, 0o755);
  await writeFile(
    join(resourcesRoot, 'astroix-runtime', 'control-plane', 'child.js'),
    'export {}\n',
  );
  await writeFile(join(resourcesRoot, 'astroix-runtime', 'package.json'), '{"type":"module"}\n');
  if (resources.symlinkEntry === true) {
    const entry = join(resourcesRoot, 'astroix-runtime', 'control-plane', 'child.js');
    const outside = join(buildDir, 'outside-payload.js');
    await writeFile(outside, 'export { evil }\n');
    await execFileAsync('rm', [entry]);
    await symlink(outside, entry);
  }
  if (resources.extraResourceFile === true) {
    await writeFile(join(resourcesRoot, 'astroix-runtime', 'dropped-in.js'), 'export {}\n');
  }
  await writeHashedManifest(
    resourcesRoot,
    resources.declaredNodeVersion ?? PACKAGED_NODE_PIN,
    STUB_RESOURCE_INVENTORY,
  );
  // -y keeps symlinks as links (the substitution leg must ride INTO the zip)
  await execFileAsync('zip', ['-q', '-r', '-y', zipPath, 'Astroix.app'], { cwd: buildDir });
  const bytes = await readFile(zipPath);
  return { zipPath, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The canonical stub resource inventory — the files every synthetic
 * resource tree carries and every self-consistent manifest inventories
 * (the build manifest itself never inventories itself, like the real
 * assembler). One home, shared by the ZIP builder and the battery
 * tests' direct-tree legs (review round 2 on #373: the manifest writer
 * was built twice).
 */
export const STUB_RESOURCE_INVENTORY: readonly string[] = Object.freeze([
  'node/bin/node',
  'astroix-runtime/control-plane/child.js',
  'astroix-runtime/package.json',
]);

/**
 * The assembler's discipline at stub scale: manifest rows hash the REAL
 * stub bytes — self-consistent, like the real build manifest. The one
 * shared writer (imported by the battery tests too).
 */
export async function writeHashedManifest(
  resourcesRoot: string,
  nodeVersion: string,
  inventoried: readonly string[],
): Promise<void> {
  const rows: { path: string; sha256: string; bytes: number; executable: boolean }[] = [];
  for (const rel of inventoried) {
    const absolute = join(resourcesRoot, ...rel.split('/'));
    const bytes = await readFile(absolute);
    rows.push({
      path: rel,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      executable: rel === 'node/bin/node',
    });
  }
  await writeFile(
    join(resourcesRoot, 'astroix-runtime', 'build-manifest.json'),
    `${JSON.stringify(
      {
        schema: 1,
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
        architecture: 'arm64',
        electron: PACKAGED_ELECTRON_PIN,
        forge: PACKAGED_FORGE_PIN,
        node: nodeVersion,
        pair: { astro: PACKAGED_CERTIFIED_PAIR.astro, vite: PACKAGED_CERTIFIED_PAIR.vite },
        resources: rows,
      },
      null,
      2,
    )}\n`,
  );
}
