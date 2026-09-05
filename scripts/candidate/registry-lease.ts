import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The registry-lease leg of the candidate matrix (#259, L2): the
 * downloaded bytes' kernel-backed registry lease, observed black-box
 * through the product's own boot surface — the private boot holds the
 * `registry-writer` kernel lease (a real SQLite `BEGIN IMMEDIATE` the
 * control-plane child acquires before it reports `control-plane-booted`,
 * ADR-0006 §2/§6), and PROCESS EXIT IS THE RELEASE BOUNDARY, so a
 * SECOND successful boot over the same user data is the only same-boot
 * proof that the first holder released (#209's law, observed from
 * outside).
 *
 * Two sequential boots of the extracted app, isolated like L1's process
 * stage (temp HOME + `ASTROIX_DESKTOP_USER_DATA` + the browser-level
 * `--user-data-dir`, minimal inherited env): each must emit
 * `control-plane-booted`, the lease file must exist as a 0600 regular
 * file inside a 0700 `private-state` directory while the child lives,
 * the Apple-event quit must settle both boots, and nothing may
 * survive. The pure shaping (`leaseFindings`) is exported for the
 * focused self-tests; the launcher is macOS-only by construction
 * (osascript, .app bundles).
 */

const execFileAsync = promisify(execFile);

/** The product's public log prefix (the H1 wire the smoke kit reads). */
export const PRODUCT_LOG_PREFIX = 'astroix-desktop: ';

/** The launch-env allowlist — the #231 `minimalChildEnv` species (L1's law, shared). */
const LAUNCH_ENV_KEYS = ['PATH', 'TMPDIR', 'LANG'] as const;

export interface LeaseLegInput {
  /** The extracted application bundle (`…/Astroix.app`). */
  readonly appPath: string;
  readonly executableName: string;
  readonly bundleId: string;
  readonly stagingRoot: string;
  /** Bound for each boot's `control-plane-booted` observation. */
  readonly bootTimeoutMs: number;
  /** Bound for each quit's settlement. */
  readonly quitTimeoutMs: number;
  readonly onLog?: (line: string) => void;
}

/** One boot's observed facts. */
export interface BootFacts {
  readonly boot: 1 | 2;
  readonly booted: boolean;
  readonly exitedEarly: { readonly code: number | null; readonly signal: string | null } | null;
  readonly lease: {
    readonly present: boolean;
    readonly regularFile: boolean;
    readonly fileMode: string | null;
    readonly directoryMode: string | null;
  };
  readonly quitOutcome: string;
}

export interface LeaseLegVerdict {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly firstBoot: BootFacts;
  readonly secondBoot: BootFacts;
  readonly residuals: readonly { readonly pid: string; readonly command: string }[];
  readonly storageUnsupported: boolean;
}

/** The pure conjunction — every failure mode named. Exported for the focused self-tests. */
export function leaseFindings(input: {
  readonly firstBoot: BootFacts;
  readonly secondBoot: BootFacts;
  readonly residuals: readonly { readonly pid: string; readonly command: string }[];
}): { ok: boolean; findings: string[]; storageUnsupported: boolean } {
  const findings: string[] = [];
  for (const boot of [input.firstBoot, input.secondBoot]) {
    if (!boot.booted) {
      findings.push(
        `boot ${String(boot.boot)} never reported control-plane-booted${boot.exitedEarly !== null ? ` (early exit code ${String(boot.exitedEarly.code)} signal ${String(boot.exitedEarly.signal)})` : ''}`,
      );
      continue;
    }
    if (!boot.lease.present) {
      findings.push(`boot ${String(boot.boot)} booted without the registry-writer lease file`);
      continue;
    }
    if (!boot.lease.regularFile) {
      findings.push(`boot ${String(boot.boot)}'s lease file is not a regular file`);
    }
    if (boot.lease.fileMode !== '600') {
      findings.push(
        `boot ${String(boot.boot)}'s lease file mode is ${String(boot.lease.fileMode)}, not 600`,
      );
    }
    if (boot.lease.directoryMode !== '700') {
      findings.push(
        `boot ${String(boot.boot)}'s private-state directory mode is ${String(boot.lease.directoryMode)}, not 700`,
      );
    }
    if (boot.quitOutcome !== 'exited-on-own-quit-surface') {
      findings.push(`boot ${String(boot.boot)}'s quit did not settle (${boot.quitOutcome})`);
    }
  }
  // the second boot is the release proof — it only counts when it booted
  if (input.secondBoot.booted && !input.firstBoot.booted) {
    findings.push(
      'the lease release proof is vacuous: the second boot succeeded but the first never did',
    );
  }
  if (input.residuals.length > 0) {
    findings.push(
      `${String(input.residuals.length)} owned process(es) survived the leg: ${input.residuals.map((row) => row.command).join(' | ')}`,
    );
  }
  // storage-unsupported is the shape a lease the filesystem cannot hold produces:
  // booted app, no lease file (or early death with no boot event) — the ticket's
  // "unsupported storage" failure mode, observed black-box
  const storageUnsupported =
    (input.firstBoot.booted || input.secondBoot.booted) &&
    !input.firstBoot.lease.present &&
    !input.secondBoot.lease.present;
  if (storageUnsupported) {
    findings.push(
      'the booted app created no registry-writer lease — the private state filesystem cannot hold the lease (unsupported storage)',
    );
  }
  return { ok: findings.length === 0, findings, storageUnsupported };
}

/** Runs the two-boot lease leg. macOS-only; every phase bounded. */
export async function runRegistryLeaseLeg(input: LeaseLegInput): Promise<LeaseLegVerdict> {
  const log = (line: string): void => {
    input.onLog?.(line);
  };
  const home = join(input.stagingRoot, 'home');
  const userData = join(input.stagingRoot, 'user-data');
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  const executable = join(input.appPath, 'Contents', 'MacOS', input.executableName);

  const firstBoot = await bootAndQuit(1, executable, input, home, userData, log);
  const secondBoot = await bootAndQuit(2, executable, input, home, userData, log);
  const residuals = await processesReferencing(input.stagingRoot);
  if (residuals.length > 0) {
    for (const row of residuals) {
      log(`registry-lease: residual pid ${row.pid} :: ${row.command}`);
    }
    for (const row of residuals) {
      try {
        process.kill(Number(row.pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  const shaped = leaseFindings({ firstBoot, secondBoot, residuals });
  return { ...shaped, firstBoot, secondBoot, residuals };
}

/** One boot: launch, wait for the boot event, observe the lease, quit, settle. */
async function bootAndQuit(
  boot: 1 | 2,
  executable: string,
  input: LeaseLegInput,
  home: string,
  userData: string,
  log: (line: string) => void,
): Promise<BootFacts> {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    ASTROIX_DESKTOP_USER_DATA: userData,
    ELECTRON_ENABLE_LOGGING: '0',
  };
  for (const key of LAUNCH_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  const state: {
    child: ChildProcess | null;
    spawnError: string | null;
    lines: string[];
    booted: boolean;
  } = { child: null, spawnError: null, lines: [], booted: false };
  try {
    state.child = spawn(executable, [`--user-data-dir=${userData}`], {
      cwd: input.stagingRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    state.spawnError = error instanceof Error ? error.message : String(error);
  }
  const exitedEarly = (): { code: number | null; signal: string | null } | null =>
    state.child !== null && (state.child.exitCode !== null || state.child.signalCode !== null)
      ? { code: state.child.exitCode, signal: state.child.signalCode }
      : null;

  state.child?.stdout?.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.trim();
      if (line.length === 0) continue;
      state.lines.push(line);
      if (line.startsWith(PRODUCT_LOG_PREFIX)) {
        const payload = line.slice(PRODUCT_LOG_PREFIX.length);
        try {
          const event = JSON.parse(payload) as { kind?: unknown };
          if (event.kind === 'control-plane-booted') state.booted = true;
        } catch {
          // a non-JSON product line is not this leg's subject
        }
      }
    }
  });
  state.child?.stderr?.on('data', () => {
    // stderr is not this leg's subject (L1 and the smoke battery audit it)
  });
  state.child?.on('error', (error: Error) => {
    if (state.spawnError === null) state.spawnError = error.message;
  });

  // ——— wait for the boot event, bounded ———
  const deadline = Date.now() + input.bootTimeoutMs;
  while (
    !state.booted &&
    state.spawnError === null &&
    exitedEarly() === null &&
    Date.now() < deadline
  ) {
    await delay(250);
  }
  const lease = await observeLease(userData);
  log(
    `registry-lease: boot ${String(boot)} — booted=${String(state.booted)} lease.present=${String(lease.present)} lease.mode=${String(lease.fileMode)} dir.mode=${String(lease.directoryMode)}`,
  );

  // ——— quit through the app's own surface ———
  let quitOutcome = 'not-attempted';
  if (state.spawnError !== null) {
    quitOutcome = 'spawn-error';
  } else if (exitedEarly() !== null) {
    quitOutcome = 'early-exit';
  } else {
    try {
      await execFileAsync('osascript', ['-e', `tell application id "${input.bundleId}" to quit`], {
        timeout: input.quitTimeoutMs,
      });
    } catch {
      // fall through to the signal escalation — the outcome records it
    }
    const exit = await awaitExit(state.child, input.quitTimeoutMs);
    if (exit !== null) {
      quitOutcome = 'exited-on-own-quit-surface';
    } else {
      state.child?.kill('SIGTERM');
      const afterTerm = await awaitExit(state.child, 10_000);
      if (afterTerm === null) {
        for (const row of await processesReferencing(input.stagingRoot)) {
          try {
            process.kill(Number(row.pid), 'SIGKILL');
          } catch {
            // already gone
          }
        }
        state.child?.kill('SIGKILL');
        await awaitExit(state.child, 5_000);
      }
      quitOutcome = 'forced';
    }
  }
  return {
    boot,
    booted: state.booted,
    exitedEarly: exitedEarly(),
    lease,
    quitOutcome,
  };
}

/** The lease observation: presence, type, and the enforced modes (0600 file in a 0700 directory). */
async function observeLease(userData: string): Promise<BootFacts['lease']> {
  const privateState = join(userData, 'private-state');
  const leasePath = join(privateState, 'registry-writer.sqlite');
  try {
    const leaf = await stat(leasePath);
    const directory = await stat(privateState);
    return {
      present: true,
      regularFile: leaf.isFile(),
      fileMode: (leaf.mode & 0o777).toString(8),
      directoryMode: (directory.mode & 0o777).toString(8),
    };
  } catch {
    return { present: false, regularFile: false, fileMode: null, directoryMode: null };
  }
}

/** The live process tree referencing `root` (L1's `pgrep` + `ps` law). */
async function processesReferencing(root: string): Promise<{ pid: string; command: string }[]> {
  const pattern = root.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
  let pids: string;
  try {
    const result = await execFileAsync('pgrep', ['-f', pattern], { timeout: 30_000 });
    pids = result.stdout;
  } catch {
    return [];
  }
  const list = pids
    .split('\n')
    .map((pid) => pid.trim())
    .filter((pid) => pid.length > 0)
    .filter((pid) => pid !== String(process.pid));
  if (list.length === 0) return [];
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,command=', '-p', list.join(',')], {
      timeout: 30_000,
    });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => ({
        pid: line.split(/\s+/)[0] ?? '?',
        command: line.split(/\s+/).slice(1).join(' '),
      }));
  } catch {
    return [];
  }
}

function awaitExit(
  child: ChildProcess | null,
  boundMs: number,
): Promise<{ code: number | null; signal: string | null } | null> {
  return new Promise((resolve) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      resolve(child === null ? null : { code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(null);
    }, boundMs);
    const onExit = (code: number | null, signal: string | null): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the extracted app's build manifest (the manifest inventory's node hash is the fixture's provenance anchor). */
export async function readAppBuildManifest(appPath: string): Promise<{
  node: string;
  nodeExecutableSha256: string | null;
}> {
  const manifest = JSON.parse(
    await readFile(
      join(appPath, 'Contents', 'Resources', 'astroix-runtime', 'build-manifest.json'),
      'utf8',
    ),
  ) as {
    node?: unknown;
    resources?: Array<{ path?: unknown; sha256?: unknown }>;
  };
  const nodeResource = (manifest.resources ?? []).find(
    (resource) => resource.path === 'node/bin/node',
  );
  return {
    node: typeof manifest.node === 'string' ? manifest.node : '',
    nodeExecutableSha256:
      typeof nodeResource?.sha256 === 'string' ? (nodeResource.sha256 as string) : null,
  };
}

/** Removes a staging root — the workflow-cleanup leg's subject. */
export async function removeStaging(root: string): Promise<boolean> {
  try {
    await rm(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
