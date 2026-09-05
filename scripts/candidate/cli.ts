import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildAttestation } from './build-attestation.ts';
import { fileFacts } from './checksum.ts';
import { checkDraftRef, draftAssetRef, modeCombinationProblem } from './draft-release.ts';
import { readSourceFacts } from './git-state.ts';
import { runMatrix } from './matrix.ts';
import { CHARTER_PINS, reconcilePins } from './pins.ts';
import { readRepoPins } from './repo-pins.ts';

/**
 * The restricted-candidate CLI (#259, L2; ADR-0008's candidate
 * checkpoints): assembles ONE exact candidate from clean synchronized
 * source, proves the uploaded/downloaded bytes are the assembled
 * bytes, runs the complete qualification matrix against the received
 * bytes, and emits the immutable evidence manifest. Run through the
 * raw-Node loader idiom (`npm run candidate -- <subcommand>`), like
 * L1's harness.
 *
 *   candidate preflight                    the fail-closed gate: clean
 *                                          source, reconciled pins,
 *                                          fixtures and workflow present
 *   candidate build --label <label>        the ONE build (H3's
 *                                          `npm run package`), its
 *                                          facts verified and written
 *   candidate qualify --zip <path> --expected-sha256 <sha> --label <label>
 *              --built <manifest> [--manifest-dir <dir>]
 *              [--mode dry-run|downloaded]
 *              [--draft-ref <repo:tag:asset>] [--uploaded] [--downloaded]
 *                                          the transfer proof + the full
 *                                          matrix + the evidence manifest
 *   candidate run --label <label>          preflight + build + the dry-run
 *                                          qualification, end to end
 *   candidate checksum <file>              one file's sha256 (the
 *                                          workflow's before/after steps)
 *
 * The evidence bundle is refusal-gated and immutable: every refusal —
 * a bad flag, a refused draft reference, a label whose manifest
 * already exists, a refused build attestation, a dirty tree — fires
 * BEFORE the evidence directory is touched, and a label's manifest is
 * written once; a failed run forces a NEW candidate label, never a
 * rewrite (a failed UPLOAD-path run needs a new label too — `gh
 * release create` fails on the existing tag, fail-closed by
 * construction). `--built` names the packaging manifest attesting the
 * one build the bytes came from, verified against --expected-sha256;
 * the `run` path observes the build in-process and attests nothing.
 * The manifest's `builtOnce` records only what the recorder observed
 * or verified — never a default.
 *
 * Exit codes: 0 — green; 1 — a check failed (fail-closed, evidence
 * recorded); 2 — misuse. Nothing here rebuilds after the one build,
 * patches app/runtime/Forge/protocol code, or publishes anything.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const USAGE = `usage: candidate <preflight|build|qualify|run|checksum> [flags]
  preflight
  build --label <label>
  qualify --zip <path> --expected-sha256 <sha> --label <label> --built <manifest>
          [--manifest-dir <dir>] [--mode dry-run|downloaded]
          [--draft-ref <repo:tag:asset>] [--uploaded] [--downloaded]
  run --label <label> [--manifest-dir <dir>]
  checksum <file>`;

// ——— the argument law (L1's discipline: explicit flags only, nothing guessed) ———

interface CliArguments {
  readonly command: string;
  readonly label?: string;
  readonly zip?: string;
  readonly expectedSha256?: string;
  readonly manifestDir?: string;
  readonly mode?: string;
  readonly draftRef?: string;
  readonly built?: string;
  readonly uploaded: boolean;
  readonly downloaded: boolean;
  readonly positional?: string;
}

/**
 * The label charset: lower-case letters, digits, and dashes, starting
 * with a letter or digit. The label is path-derived (the manifest
 * directory, the draft tag) and shell-derived in the dispatch workflow,
 * so it must be a closed set — `../` segments and every other escape
 * shape are refused here, before anything derives a path from them.
 */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function parseArguments(argv: readonly string[]): CliArguments | { code: string; detail: string } {
  const command = argv[0];
  if (command === undefined || command.startsWith('--')) {
    return { code: 'missing-command', detail: 'no subcommand given' };
  }
  const known = ['preflight', 'build', 'qualify', 'run', 'checksum'];
  if (!known.includes(command)) {
    return { code: 'unknown-command', detail: `unknown subcommand ${command}` };
  }
  if (command === 'checksum') {
    return parseChecksumArguments(command, argv.slice(1));
  }
  return parseFlagArguments(command, argv.slice(1));
}

/** The checksum command's argument law: exactly one file, nothing else. */
function parseChecksumArguments(
  command: string,
  rest: readonly string[],
): CliArguments | { code: string; detail: string } {
  const positional = rest[0];
  if (positional === undefined || positional.startsWith('--')) {
    return { code: 'value-absent', detail: 'checksum needs exactly one file argument' };
  }
  if (rest.length > 1) {
    return {
      code: 'positional-argument',
      detail: `unexpected extra argument ${String(rest[1])}`,
    };
  }
  return { command, uploaded: false, downloaded: false, positional };
}

/**
 * The flags each subcommand accepts — the parser's allowlist: a typo'd
 * flag is refused by name, never silently swallowed (#259 review
 * round 5), and a flag given twice is an ambiguity, never a guess.
 */
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  preflight: [],
  build: ['--label'],
  qualify: [
    '--label',
    '--zip',
    '--expected-sha256',
    '--manifest-dir',
    '--mode',
    '--draft-ref',
    '--built',
    '--uploaded',
    '--downloaded',
  ],
  run: ['--label', '--manifest-dir'],
};

/**
 * The flag commands' argument law: explicit `--flag value` pairs only,
 * nothing guessed — every token must be one of COMMAND_FLAGS' known
 * flags for THIS subcommand, each given at most once, and a value flag
 * must be immediately followed by its value.
 */
function parseFlagArguments(
  command: string,
  rest: readonly string[],
): CliArguments | { code: string; detail: string } {
  const knownFlags = COMMAND_FLAGS[command] ?? [];
  let index = 0;
  const flags = new Map<string, string | true>();
  while (index < rest.length) {
    const token = rest[index];
    index += 1;
    if (token === undefined) break;
    if (!token.startsWith('--')) {
      return { code: 'positional-argument', detail: `unexpected positional argument ${token}` };
    }
    if (!knownFlags.includes(token)) {
      return {
        code: 'unknown-flag',
        detail: `flag ${token} is not a ${command} flag (known: ${knownFlags.join(' ') || 'none'}) — a typo'd flag must be refused, never silently swallowed`,
      };
    }
    if (flags.has(token)) {
      return {
        code: 'duplicate-flag',
        detail: `flag ${token} given twice — an ambiguous candidate is rejected, never guessed`,
      };
    }
    if (token === '--uploaded' || token === '--downloaded') {
      flags.set(token, true);
      continue;
    }
    const value = rest[index];
    index += 1;
    if (value === undefined || value.startsWith('--')) {
      return { code: 'value-absent', detail: `flag ${token} has no value` };
    }
    flags.set(token, value);
  }
  const label = flags.get('--label') as string | undefined;
  if (label !== undefined && !LABEL_PATTERN.test(label)) {
    return {
      code: 'bad-label',
      detail: `--label must be lower-case letters, digits, and dashes, starting with a letter or digit (got ${label}) — the label derives the manifest directory and the draft tag, so it is a closed set`,
    };
  }
  return {
    command,
    label,
    zip: flags.get('--zip') as string | undefined,
    expectedSha256: flags.get('--expected-sha256') as string | undefined,
    manifestDir: flags.get('--manifest-dir') as string | undefined,
    mode: flags.get('--mode') as string | undefined,
    draftRef: flags.get('--draft-ref') as string | undefined,
    built: flags.get('--built') as string | undefined,
    uploaded: flags.get('--uploaded') === true,
    downloaded: flags.get('--downloaded') === true,
  };
}

const args = parseArguments(process.argv.slice(2));
if ('code' in args) {
  console.error(`candidate: ${args.detail}\n\n${USAGE}`);
  process.exit(2);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error(
    `candidate: the packaged product is macOS arm64 only (ADR-0008) — this host is ${process.platform}/${process.arch}`,
  );
  process.exit(2);
}

// ——— preflight ———

async function preflight(): Promise<boolean> {
  const source = await readSourceFacts(ROOT);
  if (!source.clean) {
    console.error(
      `candidate: the source tree is dirty — a candidate is built from clean synchronized source only:\n  ${source.porcelain.join('\n  ')}`,
    );
    return false;
  }
  console.log(`candidate: source clean at ${source.commit}`);
  const repo = await readRepoPins();
  const findings = reconcilePins(CHARTER_PINS, repo);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `candidate: PIN DRIFT — ${finding.field}: the repo pins ${finding.declared}, the charter demands ${finding.expected} (a pin drift is a STOP, never a silent substitution)`,
      );
    }
    return false;
  }
  console.log(
    `candidate: pins reconciled — node ${repo.node} (ABI ${CHARTER_PINS.nodeAbi}), electron ${repo.electron}, forge ${repo.forge}, pair ${repo.pair.astro} + ${repo.pair.vite}, min macOS ${repo.minimumMacOS}`,
  );
  const fixtures = [
    join(ROOT, 'qualification', 'fixtures', 'native-better-sqlite3', 'check.mjs'),
    join(ROOT, 'qualification', 'fixtures', 'unsupported-node-sass', 'reject.mjs'),
    join(ROOT, 'qualification', 'fixtures', 'unsupported-node-sass', 'package.json'),
  ];
  for (const fixture of fixtures) {
    if (!existsSync(fixture)) {
      console.error(`candidate: the qualification fixture is missing at ${fixture}`);
      return false;
    }
  }
  const { validateWorkflowFile, WORKFLOW_PATH } = await import('./workflow-law.ts');
  const workflow = await validateWorkflowFile(WORKFLOW_PATH);
  if (!workflow.ok) {
    for (const problem of workflow.problems) {
      console.error(`candidate: the candidate workflow violates its own law — ${problem}`);
    }
    return false;
  }
  console.log('candidate: preflight GREEN (clean source, reconciled pins, fixtures, workflow law)');
  return true;
}

// ——— build: the ONE build ———

interface BuildFacts {
  readonly zipPath: string;
  readonly zipBytes: number;
  readonly zipSha256: string;
  readonly sourceCommit: string;
  readonly manifest: Record<string, unknown>;
}

async function build(label: string): Promise<BuildFacts | null> {
  console.log(`candidate: the ONE build — npm run package -- --label ${label}`);
  const buildOk = await runInherited(
    'npm',
    ['run', 'package', '--', '--label', label],
    ROOT,
    30 * 60_000,
  );
  if (!buildOk) {
    console.error(
      'candidate: the packaging pipeline failed — a candidate is never built twice in one run',
    );
    return null;
  }
  const candidateDir = join(ROOT, 'apps', 'desktop', 'out', 'candidates', label);
  const packagingManifestPath = join(candidateDir, 'manifest.json');
  if (!existsSync(packagingManifestPath)) {
    console.error(
      `candidate: the packaging candidate manifest is missing (${packagingManifestPath})`,
    );
    return null;
  }
  const packagingManifest = JSON.parse(await readFile(packagingManifestPath, 'utf8')) as {
    zip?: { file?: unknown; bytes?: unknown; sha256?: unknown };
    sourceCommit?: unknown;
    node?: unknown;
  };
  const zipFile = typeof packagingManifest.zip?.file === 'string' ? packagingManifest.zip.file : '';
  if (zipFile === '') {
    console.error('candidate: the packaging manifest names no ZIP');
    return null;
  }
  const zipPath = join(ROOT, 'apps', 'desktop', 'out', 'make', 'zip', 'darwin', 'arm64', zipFile);
  if (!existsSync(zipPath)) {
    console.error(`candidate: the packaged ZIP is missing at ${zipPath}`);
    return null;
  }
  const facts = await fileFacts(zipPath);
  if (packagingManifest.zip?.sha256 !== facts.sha256) {
    console.error(
      `candidate: the packaged ZIP's live checksum ${facts.sha256} is not the pipeline's recorded ${String(packagingManifest.zip?.sha256)} — rebuilt bytes are refused (the one-build law)`,
    );
    return null;
  }
  if (packagingManifest.node !== CHARTER_PINS.node) {
    console.error(
      `candidate: the built artifact pins node ${String(packagingManifest.node)}, not the charter's ${CHARTER_PINS.node}`,
    );
    return null;
  }
  console.log(
    `candidate: built once — ${zipFile} (${String(facts.bytes)} bytes, sha256 ${facts.sha256.slice(0, 16)}…)`,
  );
  return {
    zipPath,
    zipBytes: facts.bytes,
    zipSha256: facts.sha256,
    sourceCommit:
      typeof packagingManifest.sourceCommit === 'string' ? packagingManifest.sourceCommit : '',
    manifest: packagingManifest as Record<string, unknown>,
  };
}

// ——— qualify: the transfer proof + the matrix + the manifest ———

/**
 * The one-build claim a recorder carries into the manifest (#259
 * review round 1): `builtOnce` in the evidence asserts only what THIS
 * process observed — the `run` path observed the build directly; every
 * other recorder must attest, naming the packaging manifest the bytes
 * came from (verified against the received checksum, never trusted).
 */
interface BuildClaim {
  readonly command: string;
  readonly zip: { readonly path: string; readonly bytes: number; readonly sha256: string };
  /** True only when this process ran the build and verified its facts (the `run` path). */
  readonly observed: boolean;
  /** The packaging manifest attesting the one build, when the build was not observed here. */
  readonly attestedBy?: string;
}

/** Checks a supplied `--draft-ref repo:tag:asset` against the run's own computed reference. */
function draftRefProblem(draftRef: string, draft: ReturnType<typeof draftAssetRef>): string | null {
  const [repository, tag, asset] = draftRef.split(':');
  return checkDraftRef({ repository: repository ?? '', tag: tag ?? '', asset: asset ?? '' }, draft);
}

/**
 * The one-build honesty law: resolves the `builtOnce` this recorder may
 * record — true from direct observation (the `run` path), or true only
 * after the supplied `--built` attestation names a packaging manifest
 * whose recorded checksum IS the received checksum. A recorder with
 * neither records its non-observation (false); a refused attestation is
 * a named refusal string.
 */
async function resolveBuiltOnce(
  build: BuildClaim,
  expectedSha256: string,
): Promise<{ builtOnce: boolean } | { refusal: string }> {
  if (build.observed) return { builtOnce: true };
  if (build.attestedBy === undefined) return { builtOnce: false };
  let attested: unknown;
  try {
    attested = JSON.parse(await readFile(build.attestedBy, 'utf8'));
  } catch {
    return { refusal: `unreadable-manifest — ${build.attestedBy}` };
  }
  const problem = verifyBuildAttestation({
    buildManifest: attested,
    receivedSha256: expectedSha256,
  });
  if (problem !== null) return { refusal: problem };
  return { builtOnce: true };
}

async function qualify(
  label: string,
  zipPath: string,
  expectedSha256: string,
  mode: 'dry-run' | 'downloaded',
  manifestDir: string,
  draftRef: string | undefined,
  uploaded: boolean,
  downloaded: boolean,
  build: BuildClaim,
): Promise<boolean> {
  // ——— the refusal gates, in order — every one returns BEFORE the
  // evidence destination is touched (a refused run never destroys the
  // existing bundle; the destination is cleared only after all gates)
  if (!existsSync(zipPath)) {
    console.error(`candidate: the ZIP does not exist at ${zipPath}`);
    return false;
  }
  const assetName = zipPath.split('/').pop() ?? 'Astroix-darwin-arm64-0.1.0.zip';
  const draft = draftAssetRef({ label, assetName });
  if (draftRef !== undefined) {
    const problem = draftRefProblem(draftRef, draft);
    if (problem !== null) {
      console.error(`candidate: the supplied draft reference is refused (${problem})`);
      return false;
    }
  }
  const modeProblem = modeCombinationProblem(mode, uploaded, downloaded, draftRef);
  if (modeProblem !== null) {
    console.error(`candidate: ${modeProblem}`);
    return false;
  }
  // the evidence-immutable law: a label's manifest is written ONCE. A
  // re-run over an existing manifest is refused — never a rewrite (the
  // ticket's own law: a failed run forces a NEW candidate label)
  const manifestPath = join(manifestDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    console.error(
      `candidate: the evidence manifest for label ${label} already exists at ${manifestPath} (evidence-exists — the evidence bundle is immutable; a failed run forces a NEW candidate label, never a rewrite)`,
    );
    return false;
  }
  const buildOnce = await resolveBuiltOnce(build, expectedSha256);
  if ('refusal' in buildOnce) {
    console.error(`candidate: the supplied build attestation is refused (${buildOnce.refusal})`);
    return false;
  }
  const source = await readSourceFacts(ROOT);
  if (!source.clean) {
    console.error(
      `candidate: the source tree became dirty since the build — the evidence would not tie to a clean commit:\n  ${source.porcelain.join('\n  ')}`,
    );
    return false;
  }
  const repo = await readRepoPins();
  const pinFindings = reconcilePins(CHARTER_PINS, repo);
  // a pin drift refuses BEFORE the destination is touched, like every
  // other never-green gate — a drifted standalone qualify must not run
  // the whole matrix and burn the label just to fail at the seal
  // (validateManifest's pinsProblems stays as the belt over the tables)
  if (pinFindings.length > 0) {
    for (const finding of pinFindings) {
      console.error(
        `candidate: PIN DRIFT — ${finding.field}: the repo pins ${finding.declared}, the charter demands ${finding.expected} (a pin drift is a STOP, never a silent substitution)`,
      );
    }
    return false;
  }
  // ——— every refusal gate has returned — only now is the destination
  // cleared and created for the run about to write its evidence
  await rm(manifestDir, { recursive: true, force: true });
  await mkdir(manifestDir, { recursive: true });
  const result = await runMatrix({
    label,
    mode,
    zipPath,
    expectedSha256,
    manifestDir,
    draftAsset: {
      repository: draft.repository,
      tag: draft.tag,
      asset: draft.asset,
      url: draft.url,
      visibility: draft.visibility,
    },
    source,
    pins: {
      charter: CHARTER_PINS,
      repo,
      reconciled: pinFindings.length === 0,
      findings: pinFindings,
    },
    build: { command: build.command, zip: build.zip, builtOnce: buildOnce.builtOnce },
    uploaded,
    downloaded,
  });
  return result.ok;
}

// ——— run: preflight + build + the dry run, end to end ———

async function run(label: string, manifestDir: string): Promise<boolean> {
  if (!(await preflight())) return false;
  const built = await build(label);
  if (built === null) return false;
  return qualify(
    label,
    built.zipPath,
    built.zipSha256,
    'dry-run',
    manifestDir,
    undefined,
    false,
    false,
    {
      command: `npm run package -- --label ${label}`,
      zip: { path: built.zipPath, bytes: built.zipBytes, sha256: built.zipSha256 },
      observed: true, // this process ran the one build and verified its facts
    },
  );
}

// ——— dispatch ———

const command = args.command;
let ok = false;
if (command === 'preflight') {
  ok = await preflight();
} else if (command === 'build') {
  if (args.label === undefined) misuse('build needs --label <label>');
  ok = (await build(args.label)) !== null;
} else if (command === 'qualify') {
  for (const [flag, value] of [
    ['--label', args.label],
    ['--zip', args.zip],
    ['--expected-sha256', args.expectedSha256],
  ] as const) {
    if (value === undefined) misuse(`qualify needs ${flag}`);
  }
  // the one-build honesty law: a standalone recorder observed no build —
  // it must attest one, naming the packaging manifest the bytes came
  // from (the `run` path observes the build directly and needs nothing)
  if (args.built === undefined) {
    misuse(
      'qualify needs --built <manifest> — the packaging manifest attesting the one build the bytes came from, verified against --expected-sha256',
    );
  }
  const mode = args.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'downloaded') {
    misuse(`--mode must be dry-run or downloaded (got ${mode})`);
  }
  if (args.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(args.expectedSha256)) {
    misuse('--expected-sha256 must be 64 lower-case hex digits');
  }
  const label = args.label as string;
  const zip = args.zip as string;
  const sha = args.expectedSha256 as string;
  const manifestDir = args.manifestDir ?? join(ROOT, 'qualification', 'manifests', label);
  // the named missing-ZIP refusal, before fileFacts would die on an
  // ENOENT stack (qualify's own gate stays as the law for every caller)
  if (!existsSync(zip)) {
    console.error(`candidate: the ZIP does not exist at ${zip}`);
    process.exit(1);
  }
  const receivedFacts = await fileFacts(zip);
  ok = await qualify(
    label,
    zip,
    sha,
    mode,
    manifestDir,
    args.draftRef,
    args.uploaded,
    args.downloaded,
    {
      command: `npm run package (attested by ${args.built as string})`,
      zip: { path: zip, bytes: receivedFacts.bytes, sha256: sha },
      observed: false,
      attestedBy: args.built,
    },
  );
} else if (command === 'run') {
  if (args.label === undefined) misuse('run needs --label <label>');
  const label = args.label as string;
  const manifestDir = args.manifestDir ?? join(ROOT, 'qualification', 'manifests', label);
  ok = await run(label, manifestDir);
} else if (command === 'checksum') {
  const file = args.positional as string;
  if (!existsSync(file)) misuse(`checksum: no such file: ${file}`);
  const facts = await fileFacts(file);
  console.log(facts.sha256);
  ok = true;
}
process.exit(ok ? 0 : 1);

function misuse(detail: string): never {
  console.error(`candidate: ${detail}\n\n${USAGE}`);
  process.exit(2);
}

function runInherited(
  command: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      console.error(`candidate: spawn error — ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
