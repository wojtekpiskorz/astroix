import { spawnSync } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import {
  BUILD_MANIFEST_RESOURCE_PATH,
  buildManifest,
  MODULE_TYPE_MARKER_RESOURCE_PATH,
  NODE_EXECUTABLE_RESOURCE_PATH,
  NODE_RESOURCE_DIR,
  PACKAGED_ELECTRON_PIN,
  PACKAGED_NODE_PIN,
  RUNTIME_RESOURCE_DIR,
  serializeManifest,
  verifyPackagedAssets,
} from '../../../packages/runtime/src/internal/packaged-assets.ts';
import { sha256File } from '../src/forge/inventory.ts';

/**
 * The packaged-runtime assembly step (#244, H2; ADR-0008 resource layout):
 * builds the immutable resources a packaged app resolves its spawns from
 * — REAL files, never inside `app.asar`:
 *
 *   <out>/astroix-runtime/control-plane/child.js   the rebased control-plane
 *                                                   runtime (vite bundle:
 *                                                   the control-plane and
 *                                                   project-plane code plus
 *                                                   the non-project
 *                                                   dependencies — zod,
 *                                                   postcss, the workspace
 *                                                   core/protocol — as one
 *                                                   plain-ECMAScript file
 *                                                   that needs no dev
 *                                                   loaders under the
 *                                                   bundled Node)
 *   <out>/astroix-runtime/package.json             the module-type marker
 *                                                   ({"type":"module"}): the
 *                                                   rebased entry's ESM
 *                                                   identity never depends
 *                                                   on an ancestor package
 *                                                   json — the packaged
 *                                                   Contents/Resources tree
 *                                                   has none
 *   <out>/node/bin/node                             the exact stock
 *                                                   Node 24.20.0 executable
 *                                                   (official distribution
 *                                                   tarball, SHA-verified
 *                                                   against nodejs.org's
 *                                                   SHASUMS256.txt)
 *   <out>/astroix-runtime/build-manifest.json       the build manifest
 *                                                   (source commit,
 *                                                   architecture, pins,
 *                                                   inventory, SHA-256s)
 *
 * A locally-run assembly gate, never a CI gate (like `test:desktop` and
 * `certify:adapter`): it downloads real artifacts from nodejs.org, so it
 * stays OUT of `npm test` and CI. `npm run assemble:runtime` runs it
 * (Node ≥ 22.6 with --experimental-transform-types plus the desktop
 * package's raw-Node register — the repo's extensionless-TS resolve hook —
 * so the pin table, manifest builder, and verifier are the runtime
 * package's own code: one source of truth, no script-side pin copy). The
 * assembly ends by verifying its own output through the same adapter the
 * app boots with.
 *
 * The default output `apps/desktop/resources/` is gitignored except its
 * `.gitkeep`; the Forge wiring that maps it into `Contents/Resources/`
 * is H3 (#245).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const ROOT = join(DESKTOP, '..', '..');
const DEFAULT_OUT = join(DESKTOP, 'resources');
const DEFAULT_CACHE = join(DESKTOP, '.assemble-cache');

const outDir = resolve(cliValue('--out') ?? DEFAULT_OUT);
const cacheDir = resolve(cliValue('--cache') ?? DEFAULT_CACHE);

function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

// ——— the v1 product shape (ADR-0008): exactly one macOS arm64 app ———

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(
    `assemble-runtime: the packaged product is macOS arm64 only (ADR-0008); refusing to assemble for ${process.platform}-${process.arch}`,
  );
  process.exit(1);
}

// ——— 1. the source commit ———

const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: DESKTOP, encoding: 'utf8' });
if (git.status !== 0 || !/^[0-9a-f]{40}$/.test((git.stdout ?? '').trim())) {
  console.error('assemble-runtime: could not read the source commit (git rev-parse HEAD)');
  process.exit(1);
}
const sourceCommit = git.stdout.trim();

// ——— 2. the rebased control-plane runtime ———

await rm(join(outDir, RUNTIME_RESOURCE_DIR), { recursive: true, force: true });
await mkdir(join(outDir, RUNTIME_RESOURCE_DIR, 'control-plane'), { recursive: true });

await build({
  root: DESKTOP,
  configFile: false,
  logLevel: 'silent',
  build: {
    target: 'node24',
    outDir: join(outDir, RUNTIME_RESOURCE_DIR),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: join(DESKTOP, 'src', 'main', 'control-plane-child.ts'),
      formats: ['es'],
      fileName: () => 'control-plane/child.js',
    },
    rollupOptions: {
      // the bundled runtime externalizes ONLY node builtins: the
      // non-project dependencies (zod, postcss, the workspace
      // core/protocol) bundle in as real built bytes
      external: (id) => id.startsWith('node:'),
      output: {
        entryFileNames: 'control-plane/child.js',
        chunkFileNames: 'chunk-[name].js',
      },
    },
  },
});

// ——— 2a. the plane worker's rebased sibling entry (#362) ———
//
// The plane supervisor's worker-plan seam resolves the worker entry as a
// sibling FILE path relative to its own module (`new URL('../worker/
// worker-child.ts', import.meta.url)`) — the dev checkout's workspace
// source. The bundler's asset pipeline INLINES that referenced .ts as a
// base64 data URL inside the controller (a spawnable path that is not a
// file: the packaged plane's first activation found exactly that), so
// the assembly rebases the expression onto the sibling entry it emits
// below (ADR-0008's "the packaged runtime rebases it to the bundled
// entry"). The rebase is a POST-PASS over the built controller: the
// payload is verified to BE the worker tail's source (decoded, matched
// by its own boot function) before the expression is replaced, and any
// drift of the seam's shape fails the assembly loudly.
const CONTROLLER_ENTRY = join(outDir, RUNTIME_RESOURCE_DIR, 'control-plane', 'child.js');
const WORKER_TAIL_SIGNATURE = 'bootProjectPlaneWorker';
const inlinedWorkerTail =
  /new URL\("data:video\/mp2t;base64,([A-Za-z0-9+/=]+)", "" \+ import\.meta\.url\)/;
{
  const controller = await readFile(CONTROLLER_ENTRY, 'utf8');
  const match = inlinedWorkerTail.exec(controller);
  if (match === null) {
    throw new Error(
      'assemble-runtime: the controller no longer inlines the worker tail as a data URL — the rebase drifted; update the assembly',
    );
  }
  const payload = Buffer.from(match[1], 'base64').toString('utf8');
  if (!payload.includes(WORKER_TAIL_SIGNATURE)) {
    throw new Error(
      'assemble-runtime: the inlined asset is not the plane worker tail — refusing to rebase the wrong expression',
    );
  }
  const rebased = controller.replace(
    match[0],
    "new URL('../worker/worker-child.js', import.meta.url)",
  );
  await writeFile(CONTROLLER_ENTRY, rebased);
  console.log('assemble-runtime: rebased the controller worker-entry seam onto the sibling bundle');
}

// The forked worker tail the plane supervisor spawns: the SAME runtime
// code (the composition server and its internals), bundled as its own
// plain-ECMAScript entry at the exact sibling path the rebased
// controller references — `<resources>/astroix-runtime/worker/
// worker-child.js`, beside `control-plane/child.js`.
await mkdir(join(outDir, RUNTIME_RESOURCE_DIR, 'worker'), { recursive: true });
await build({
  root: DESKTOP,
  configFile: false,
  logLevel: 'silent',
  build: {
    target: 'node24',
    outDir: join(outDir, RUNTIME_RESOURCE_DIR, 'worker'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: join(ROOT, 'packages', 'runtime', 'project-plane', 'worker', 'worker-child.ts'),
      formats: ['es'],
      fileName: () => 'worker-child.js',
    },
    rollupOptions: {
      external: (id) => id.startsWith('node:'),
      output: {
        entryFileNames: 'worker-child.js',
        chunkFileNames: 'chunk-[name].js',
      },
    },
  },
});

// ——— 2b. the native compiler binding's binary beside the worker entry (#362) ———
//
// The worker's graph inlines Astro's native compiler binding loader
// (NAPI-RS generated): its FIRST darwin attempt is a relative
// `require('./astro.darwin-arm64.node')` against its own module — which
// inside the bundle is the worker entry's directory. A bundle can never
// inline native bytes, so the exact platform binary the workspace
// resolved ships as a real file at that relative path — no scoped
// node_modules tree (the manifest's resource-path vocabulary carries no
// `@`), and every platform this product ships does the same.
const NATIVE_BINDINGS = [
  {
    from: join(
      ROOT,
      'node_modules',
      '@astrojs',
      'compiler-binding-darwin-arm64',
      'astro.darwin-arm64.node',
    ),
    to: join(outDir, RUNTIME_RESOURCE_DIR, 'worker', 'astro.darwin-arm64.node'),
  },
];
for (const binding of NATIVE_BINDINGS) {
  await cp(binding.from, binding.to);
}

// ——— 2b. the client documents the child's origin listener serves (#362, H7) ——

// The launcher and project app documents every renderer host serves
// (the SAME web client build the web host boots from): the desktop
// child composes the shared control-plane composition, whose document
// surface serves them from an explicitly named directory — the packaged
// resources' client subtree, built here beside the rebased entry and
// inventoried like every other immutable resource.
const WEB_CLIENT_ROOT = join(ROOT, 'apps', 'web', 'client');
await build({
  root: WEB_CLIENT_ROOT,
  configFile: false,
  logLevel: 'silent',
  base: '/__astroix/app/',
  build: {
    outDir: join(outDir, RUNTIME_RESOURCE_DIR, 'client'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        launcher: join(WEB_CLIENT_ROOT, 'launcher.html'),
        project: join(WEB_CLIENT_ROOT, 'project.html'),
      },
    },
  },
});

// ——— 3. the exact stock Node distribution ———

const nodeVersion = PACKAGED_NODE_PIN.replace(/^v/, '');
const distFile = `node-v${nodeVersion}-${process.platform}-${process.arch}.tar.gz`;
const distUrl = `https://nodejs.org/dist/v${nodeVersion}/${distFile}`;
const shasumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;

await mkdir(cacheDir, { recursive: true });
const tarball = join(cacheDir, distFile);
if (!(await fileExists(tarball)) || (await sha256File(tarball)) !== (await officialSha(distFile))) {
  console.log(`assemble-runtime: downloading ${distUrl}`);
  const response = await fetch(distUrl);
  if (!response.ok) {
    console.error(`assemble-runtime: download failed (${response.status} ${distUrl})`);
    process.exit(1);
  }
  await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  const downloaded = await sha256File(tarball);
  if (downloaded !== (await officialSha(distFile))) {
    console.error(
      'assemble-runtime: the downloaded tarball fails the official SHASUMS256.txt entry',
    );
    process.exit(1);
  }
} else {
  console.log('assemble-runtime: using the cached Node distribution tarball');
}

const extractDir = await mkdtemp(join(tmpdir(), 'astroix-assemble-node-'));
try {
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8' });
  if (tar.status !== 0) {
    console.error(`assemble-runtime: extraction failed (${tar.stderr})`);
    process.exit(1);
  }
  await rm(join(outDir, NODE_RESOURCE_DIR), { recursive: true, force: true });
  await mkdir(dirname(join(outDir, NODE_EXECUTABLE_RESOURCE_PATH)), { recursive: true });
  await cp(
    join(extractDir, `node-v${nodeVersion}-${process.platform}-${process.arch}`, 'bin', 'node'),
    join(outDir, NODE_EXECUTABLE_RESOURCE_PATH),
  );
  await chmod(join(outDir, NODE_EXECUTABLE_RESOURCE_PATH), 0o755);
} finally {
  await rm(extractDir, { recursive: true, force: true });
}

// ——— 4. the build manifest ———

// The rebased entry is plain ECMAScript with import syntax: its module
// type must never depend on an ancestor package.json — the packaged
// Contents/Resources tree has none, so without this marker the bundled
// child.js would load as CommonJS and die on its first import statement.
// One immutable marker file, inventoried like every other resource.
await writeFile(join(outDir, MODULE_TYPE_MARKER_RESOURCE_PATH), '{"type":"module"}\n');

const inventory = [];
for (const subtree of [RUNTIME_RESOURCE_DIR, NODE_RESOURCE_DIR]) {
  await collectResources(join(outDir, subtree), subtree, inventory);
}
const manifest = buildManifest({ sourceCommit, architecture: process.arch, resources: inventory });
await writeFile(join(outDir, BUILD_MANIFEST_RESOURCE_PATH), serializeManifest(manifest));

// ——— 5. verify what was assembled, with the adapter the app boots with ———

const verified = await verifyPackagedAssets({
  resourcesRoot: outDir,
  architecture: process.arch,
  electronVersion: PACKAGED_ELECTRON_PIN,
});
if ('code' in verified) {
  console.error(
    `assemble-runtime: the assembled layout FAILS verification: ${JSON.stringify(verified)}`,
  );
  process.exit(1);
}
const bundled = await stat(join(outDir, NODE_EXECUTABLE_RESOURCE_PATH));
console.log(
  `assemble-runtime: assembled ${manifest.resources.length} resources under ${relative(DESKTOP, outDir)}/ ` +
    `(node ${PACKAGED_NODE_PIN}, ${Math.round(bundled.size / 1e6)} MB executable; entry ${relative(outDir, verified.controlPlaneEntry)}; manifest ${BUILD_MANIFEST_RESOURCE_PATH}) — verification passed`,
);

// ——— helpers ———

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function officialSha(file) {
  const response = await fetch(shasumsUrl);
  if (!response.ok) {
    console.error(`assemble-runtime: could not fetch ${shasumsUrl} (${response.status})`);
    process.exit(1);
  }
  const line = (await response.text()).split('\n').find((entry) => entry.endsWith(` ${file}`));
  const hash = line?.split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) {
    console.error(`assemble-runtime: ${file} has no SHASUMS256.txt entry`);
    process.exit(1);
  }
  return hash;
}

/** Collects the inventory facts (path, sha256, bytes, executable) for one ratified subtree. */
async function collectResources(dir, subtree, inventory) {
  for (const name of (await readdir(dir)).sort()) {
    const absolute = join(dir, name);
    const entryStat = await stat(absolute);
    if (entryStat.isDirectory()) {
      await collectResources(absolute, `${subtree}/${name}`, inventory);
      continue;
    }
    if (subtree === RUNTIME_RESOURCE_DIR && `${subtree}/${name}` === BUILD_MANIFEST_RESOURCE_PATH) {
      continue; // the manifest never inventories itself
    }
    inventory.push({
      path: `${subtree}/${name}`,
      sha256: await sha256File(absolute),
      bytes: entryStat.size,
      executable: (entryStat.mode & 0o111) !== 0,
    });
  }
}
