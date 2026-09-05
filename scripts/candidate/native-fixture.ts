import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sha256File } from './checksum.ts';
import { spawnCapture } from './node-sass-fixture.ts';
import { readAppBuildManifest } from './registry-lease.ts';

/**
 * The positive native fixture leg (#259, L2): builds better-sqlite3
 * 12.10.0 FROM SOURCE against the bundled Node and executes it under
 * the DOWNLOADED ARTIFACT's own bundled binary — the in-memory
 * create/insert/select/close sequence.
 *
 * The provenance chain, every link verified:
 *
 *   1. the official Node v24.20.0 darwin-arm64 distribution tarball —
 *      the exact artifact H2's assembly downloads and SHA-verifies
 *      against nodejs.org's SHASUMS256.txt (the assembly cache holds
 *      it after the one build; a missing cache entry is downloaded and
 *      SHA-verified here with the same discipline);
 *   2. the tarball's `bin/node` must hash EQUAL to the extracted
 *      app's build-manifest entry for `node/bin/node` — the
 *      toolchain's runtime IS the shipped runtime, byte for byte;
 *   3. the build runs UNDER the distribution's own node + npm
 *      (`<dist>/bin/node <dist>/lib/node_modules/npm/bin/npm-cli.js
 *      install --build-from-source`, `npm_config_nodedir` pointing at
 *      the distribution root) — no prebuilt binary can ride in;
 *   4. the execution runs UNDER the artifact's bundled binary
 *      (`<extracted-app>/Contents/Resources/node/bin/node check.mjs`),
 *      which asserts Node v24.20.0, ABI 137, darwin, arm64 before the
 *      addon loads.
 *
 * The install happens inside an isolated temp COPY of the fixture
 * template — never inside the workspace, never as a workspace
 * dependency (the repo's devDependency set stays untouched).
 */

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIXTURE_TEMPLATE = join(ROOT, 'qualification', 'fixtures', 'native-better-sqlite3');
const ASSEMBLE_CACHE = join(ROOT, 'apps', 'desktop', '.assemble-cache');

export interface SqliteFixtureVerdict {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly facts: {
    readonly executed: boolean;
    readonly packageVersion: string | null;
    readonly runtime: { readonly node: string | null; readonly abi: string | null } | null;
    readonly builtFromSource: boolean;
    readonly builtUnder: string | null;
    readonly inMemory: Readonly<Record<string, unknown>> | null;
    readonly detail: string | null;
  };
}

export async function runSqliteLeg(input: {
  readonly appPath: string;
  readonly nodePin: string;
  readonly nodeAbi: string;
  readonly packageVersion: string;
  readonly onLog?: (line: string) => void;
}): Promise<SqliteFixtureVerdict> {
  const log = (line: string): void => {
    input.onLog?.(line);
  };
  const scratch = await mkdtemp(join(tmpdir(), 'astroix-native-fixture-'));
  try {
    // ——— the provenance chain, one step per helper; a step's string
    // return is its named refusal ———
    const dist = await obtainVerifiedDistribution(input.nodePin, scratch, log);
    if (typeof dist === 'string') return refused(log, dist);
    const provenance = await extractAndVerifyProvenance(input, scratch, dist.tarball, log);
    if (typeof provenance === 'string') return refused(log, provenance);
    const build = await buildFixtureFromSource(input, scratch, provenance.distRoot, log);
    if (typeof build === 'string') return refused(log, build);
    const executed = await executeUnderArtifactNode(input, build.buildDir, log);
    if (typeof executed === 'string') return refused(log, executed);
    return {
      ok: true,
      findings: [],
      facts: {
        executed: true,
        packageVersion:
          typeof executed.verdict.packageVersion === 'string'
            ? executed.verdict.packageVersion
            : null,
        runtime: {
          node:
            typeof executed.verdict.runtime?.node === 'string'
              ? executed.verdict.runtime.node
              : null,
          abi:
            typeof executed.verdict.runtime?.abi === 'string' ? executed.verdict.runtime.abi : null,
        },
        builtFromSource: true,
        builtUnder: input.nodePin,
        inMemory:
          (executed.verdict.inMemory as Readonly<Record<string, unknown>> | undefined) ?? null,
        detail: build.buildLog.trim().slice(-500) || null,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Step 1: the official distribution tarball, SHA-verified against nodejs.org's SHASUMS256.txt. */
async function obtainVerifiedDistribution(
  nodePin: string,
  scratch: string,
  log: (line: string) => void,
): Promise<{ readonly tarball: string } | string> {
  const nodeVersion = nodePin.replace(/^v/, '');
  const distFile = `node-v${nodeVersion}-${process.platform}-${process.arch}.tar.gz`;
  const cached = join(ASSEMBLE_CACHE, distFile);
  let tarball = cached;
  try {
    await stat(cached);
    log(`native-fixture: using the assembled distribution cache (${distFile})`);
  } catch {
    tarball = join(scratch, distFile);
    log(`native-fixture: downloading the official ${distFile} (no assembly cache)`);
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${distFile}`);
    if (!response.ok) {
      return `the official distribution download failed (${String(response.status)})`;
    }
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  }
  const shasums = await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`);
  if (!shasums.ok) {
    return `the official SHASUMS256.txt could not be fetched (${String(shasums.status)})`;
  }
  const expectedSha = (await shasums.text())
    .split('\n')
    .find((entry) => entry.endsWith(` ${distFile}`))
    ?.split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expectedSha ?? '')) {
    return `${distFile} has no SHASUMS256.txt entry`;
  }
  const tarballSha = await sha256File(tarball);
  if (tarballSha !== expectedSha) {
    return 'the distribution tarball fails the official SHASUMS256.txt entry';
  }
  return { tarball };
}

/**
 * Step 2: the toolchain runtime IS the shipped runtime — the tarball's
 * `bin/node` must hash equal to the extracted app's build-manifest
 * entry for `node/bin/node`.
 */
async function extractAndVerifyProvenance(
  input: { readonly appPath: string; readonly nodePin: string },
  scratch: string,
  tarball: string,
  log: (line: string) => void,
): Promise<{ readonly distRoot: string } | string> {
  const nodeVersion = input.nodePin.replace(/^v/, '');
  const distExtract = join(scratch, 'dist');
  await mkdir(distExtract, { recursive: true });
  const extract = await execFileAsync('tar', ['-xzf', tarball, '-C', distExtract]);
  if (extract.stderr.trim() !== '') log(`native-fixture: tar noted ${extract.stderr.trim()}`);
  const distRoot = join(distExtract, `node-v${nodeVersion}-${process.platform}-${process.arch}`);
  const distNodeSha = await sha256File(join(distRoot, 'bin', 'node')).catch(() => null);
  const appManifest = await readAppBuildManifest(input.appPath);
  if (appManifest.node !== input.nodePin) {
    return `the artifact's manifest pins node ${appManifest.node}, not ${input.nodePin}`;
  }
  if (
    distNodeSha === null ||
    appManifest.nodeExecutableSha256 === null ||
    distNodeSha !== appManifest.nodeExecutableSha256
  ) {
    return "the distribution tarball's bin/node does not hash equal to the artifact's bundled node — the toolchain runtime is not the shipped runtime";
  }
  log('native-fixture: provenance holds — the distribution node and the shipped node hash equal');
  return { distRoot };
}

/**
 * Step 3: the isolated from-source build, under the distribution's own
 * node + npm — no prebuilt binary can ride in. Returns the build
 * directory and its captured log.
 */
async function buildFixtureFromSource(
  input: { readonly packageVersion: string; readonly nodePin: string },
  scratch: string,
  distRoot: string,
  log: (line: string) => void,
): Promise<{ readonly buildDir: string; readonly buildLog: string } | string> {
  const buildDir = join(scratch, 'fixture-build');
  await cp(FIXTURE_TEMPLATE, buildDir, { recursive: true });
  const templateManifest = JSON.parse(await readFile(join(buildDir, 'package.json'), 'utf8')) as {
    candidateDependencies?: Record<string, string>;
  };
  const declared = templateManifest.candidateDependencies?.['better-sqlite3'];
  if (declared !== input.packageVersion) {
    return `the fixture template declares better-sqlite3 ${String(declared)}, not ${input.packageVersion}`;
  }
  const distNpm = join(distRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    await stat(distNpm);
  } catch {
    return 'the official distribution carries no npm (cannot build from source under the bundled toolchain)';
  }
  log(
    `native-fixture: building better-sqlite3 ${input.packageVersion} from source under ${input.nodePin}…`,
  );
  const build = await spawnCapture(
    join(distRoot, 'bin', 'node'),
    [
      distNpm,
      'install',
      `better-sqlite3@${input.packageVersion}`,
      '--no-save',
      '--no-package-lock',
      '--loglevel=warn',
    ],
    20 * 60_000,
    {
      cwd: buildDir,
      env: {
        ...process.env,
        npm_config_build_from_source: 'true',
        npm_config_nodedir: distRoot,
        npm_config_update_notifier: 'false',
        PATH: `${join(distRoot, 'bin')}:${process.env.PATH ?? ''}`,
      },
    },
  );
  if (build.exitCode !== 0) {
    log(`native-fixture: build failed — ${build.stderr.slice(-2000)}`);
    return `the from-source build failed (exit ${String(build.exitCode)})`;
  }
  const nodeModules = await readdir(join(buildDir, 'node_modules', 'better-sqlite3')).catch(
    () => null,
  );
  if (nodeModules === null) return 'the build produced no better-sqlite3 module';
  const prebuilt = await findPrebuiltBinary(join(buildDir, 'node_modules', 'better-sqlite3'));
  if (prebuilt !== null) {
    return `a prebuilt binary rode in (${prebuilt}) — the build must be from source`;
  }
  return { buildDir, buildLog: build.stdout + build.stderr };
}

/** The check fixture's printed verdict (unknown-shaped until its fields are read). */
interface CheckVerdict {
  executed?: unknown;
  runtime?: { node?: unknown; abi?: unknown };
  inMemory?: unknown;
  packageVersion?: unknown;
  code?: unknown;
}

/** Step 4: the execution, under the ARTIFACT's own bundled binary. */
async function executeUnderArtifactNode(
  input: {
    readonly appPath: string;
    readonly nodePin: string;
    readonly nodeAbi: string;
    readonly packageVersion: string;
  },
  buildDir: string,
  log: (line: string) => void,
): Promise<{ readonly verdict: CheckVerdict } | string> {
  const appNode = join(input.appPath, 'Contents', 'Resources', 'node', 'bin', 'node');
  const check = await spawnCapture(
    appNode,
    [
      join(buildDir, 'check.mjs'),
      '--expect-node',
      input.nodePin,
      '--expect-abi',
      input.nodeAbi,
      '--expect-os',
      process.platform,
      '--expect-arch',
      process.arch,
      '--expect-package-version',
      input.packageVersion,
    ],
    60_000,
  );
  log(`native-fixture: check.mjs exit ${String(check.exitCode ?? check.signal)}`);
  let verdict: CheckVerdict | null = null;
  try {
    verdict = JSON.parse(check.stdout) as CheckVerdict;
  } catch {
    return `the check printed no parseable verdict (exit ${String(check.exitCode ?? check.signal)}): ${check.stdout.slice(-500)} ${check.stderr.slice(-500)}`;
  }
  if (check.exitCode !== 0 || verdict?.executed !== true) {
    return `the native check rejected the runtime (${String(verdict?.code ?? check.exitCode)})`;
  }
  return { verdict };
}

/** The leg's one refusal shape — the named detail, the no-execution facts. */
function refused(log: (line: string) => void, detail: string): SqliteFixtureVerdict {
  log(`native-fixture: REFUSED — ${detail}`);
  return {
    ok: false,
    findings: [detail],
    facts: {
      executed: false,
      packageVersion: null,
      runtime: null,
      builtFromSource: false,
      builtUnder: null,
      inMemory: null,
      detail,
    },
  };
}

/** A prebuilt-binary rider: better-sqlite3's prebuilds directory must not exist with content. */
async function findPrebuiltBinary(moduleRoot: string): Promise<string | null> {
  const prebuilds = join(moduleRoot, 'prebuilds');
  const entries = await readdir(prebuilds).catch(() => null);
  if (entries !== null && entries.length > 0) return `prebuilds/${entries[0]}`;
  return null;
}
