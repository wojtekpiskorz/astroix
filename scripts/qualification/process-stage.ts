import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The process stage of the qualification harness (#258, L1): launch the
 * packaged app from its extracted bytes, observe it alive, terminate
 * it through its own quit surface, and audit that NOTHING it owned
 * survives — bounded at every step, so a hostile or broken artifact can
 * never hang the harness.
 *
 * Translated from the early packaged smoke's run idioms (#248, H6, and
 * the #361 smoke-harness laws): the isolated temp HOME plus the
 * product's user-data override and the browser-level `--user-data-dir`
 * switch (every process of the tree, first to last, isolated from the
 * real account home), the process-tree observation over `pgrep -f` +
 * `ps`, the listening-socket evidence, the Apple-event quit (the event
 * Cmd+Q sends — the app's own quit surface, the one H6 proved reaps
 * the whole plane), and the line-buffered, tail-bounded stdout/stderr
 * capture.
 *
 * The launch environment is the #231 whitelisted-env law
 * (`minimalChildEnv`'s species): a MINIMAL ALLOWLIST is inherited from
 * the harness host and nothing else — a dev machine's `NODE_OPTIONS`,
 * `ELECTRON_*`, and secrets can never flow into the app under
 * qualification (review round 1 on #373: the full-env spread let the
 * harness's own environment coach the artifact it was judging).
 *
 * The stage is artifact-shaped, not feature-shaped: it knows where a
 * packaged app keeps its executable and how a macOS app is asked to
 * quit — never a product route, menu, or document.
 */

const execFileAsync = promisify(execFile);

/** The product's packaged user-data override (the H1/#361 isolation law, translated). */
export const USER_DATA_ENV_VAR = 'ASTROIX_DESKTOP_USER_DATA';
/**
 * Keys the launch environment may carry from the harness host —
 * everything else is dropped, never inherited (the #231
 * `minimalChildEnv` species; review round 1 on #373).
 */
const LAUNCH_ENV_KEYS = ['PATH', 'TMPDIR', 'LANG'] as const;

/** One observed process row (the H6 audit shape). */
export interface ProcessRow {
  readonly pid: string;
  readonly ppid: string;
  readonly command: string;
}

/** One termination step, recorded as taken. */
export interface TerminationStep {
  readonly step: 'apple-event-quit' | 'SIGTERM' | 'SIGKILL-tree';
  readonly detail: string;
}

/** How the termination concluded. */
export type TerminationOutcome =
  | 'exited-on-own-quit-surface'
  | 'exited-before-termination'
  | 'exited-after-signal'
  | 'termination-forced'
  | 'quit-surface-unavailable'
  | 'spawn-error'
  | 'launch-failed';

/** The whole process-stage record — the evidence artifact `process-audit.json` carries. */
export interface ProcessStageRecord {
  readonly executable: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: {
    readonly home: string;
    readonly userData: string;
    readonly userDataEnvVar: string;
    /** The allowlist keys inherited from the harness host — the whole launch env policy. */
    readonly inheritedKeys: readonly string[];
  };
  readonly pid: number | null;
  readonly spawnError: string | null;
  readonly settle: {
    readonly settleMs: number;
    readonly aliveAtSettle: boolean;
    readonly earlyExit: { readonly code: number | null; readonly signal: string | null } | null;
  };
  readonly treeAtSettle: readonly ProcessRow[];
  readonly listeningSockets: readonly string[];
  readonly termination: {
    readonly mode: 'apple-event' | 'signal-only';
    readonly steps: readonly TerminationStep[];
    readonly outcome: TerminationOutcome;
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
  readonly residualAudit: {
    readonly pollMs: number;
    readonly polls: number;
    readonly residuals: readonly ProcessRow[];
    readonly harnessKilled: readonly string[];
    readonly postKillResiduals: readonly ProcessRow[];
  };
  readonly stdoutTail: readonly string[];
  readonly stderrTail: readonly string[];
}

/** The per-law verdicts the orchestrator records as the launch/termination/residual stages. */
export interface ProcessStageVerdicts {
  readonly launchOk: boolean;
  readonly terminationOk: boolean;
  readonly residualOk: boolean;
  readonly record: ProcessStageRecord;
}

export interface ProcessStageInput {
  /** The extracted application bundle (`…/Astroix.app`). */
  readonly appPath: string;
  /** The bundle's executable name (`CFBundleExecutable` shape — `Astroix`). */
  readonly executableName: string;
  /** The bundle identifier the Apple-event quit addresses. */
  readonly bundleId: string;
  /** The isolation root: `home/` and `user-data/` are created inside it; it is the launch cwd. */
  readonly stagingRoot: string;
  /** How long the app must stay alive to count as launched. */
  readonly settleMs: number;
  /** How long the app has to honor the Apple-event quit. */
  readonly quitTimeoutMs: number;
  /** `apple-event` (real packaged apps) or `signal-only` (stubs; tests). */
  readonly quitMode: 'apple-event' | 'signal-only';
  /** Bound for the SIGTERM escalation (default 10 s). */
  readonly termBoundMs?: number;
  /** Bound after SIGKILL before the exit is considered unresolved (default 5 s). */
  readonly killBoundMs?: number;
  /** How long to poll for owned processes to disappear (default 15 s). */
  readonly residualPollMs?: number;
}

const TAIL_LINES = 50;

/** One observed exit — code and signal, each unknown until settled. */
export type ExitFacts = { readonly code: number | null; readonly signal: string | null };

/**
 * The mutable launch state every phase reads: the async `error` event
 * can latch `spawnError` at any moment up to process exit, and the tail
 * buffers keep filling while the child lives — one shared object, never
 * a snapshot.
 */
interface LaunchState {
  child: ChildProcess | null;
  spawnError: string | null;
  readonly stdoutTail: string[];
  readonly stderrTail: string[];
}

/** Runs the whole process law: launch, settle, terminate, audit. Bounded everywhere. */
export async function launchTerminateAndAudit(
  input: ProcessStageInput,
): Promise<ProcessStageVerdicts> {
  const home = join(input.stagingRoot, 'home');
  const userData = join(input.stagingRoot, 'user-data');
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  const env = buildLaunchEnv(home, userData);
  const executable = join(input.appPath, 'Contents', 'MacOS', input.executableName);
  const argv = [`--user-data-dir=${userData}`];

  const state = spawnApp(executable, argv, input.stagingRoot, env);
  const settled = (): ExitFacts | null =>
    state.child !== null && (state.child.exitCode !== null || state.child.signalCode !== null)
      ? { code: state.child.exitCode, signal: state.child.signalCode }
      : null;
  const awaitExit = (boundMs: number): Promise<ExitFacts | null> =>
    awaitChildExit(state.child, boundMs);

  // ——— launch + settle ———
  const earlyExit = await observeSettle(state, input.settleMs, settled);
  const treeAtSettle =
    state.spawnError === null && earlyExit === null
      ? await processesReferencing(input.stagingRoot)
      : [];
  const socketsAtSettle =
    treeAtSettle.length > 0 ? await listeningSockets(treeAtSettle.map((row) => row.pid)) : [];

  // ——— termination ———
  const steps: TerminationStep[] = [];
  const termination = await terminateApp(input, state, earlyExit, steps, settled, awaitExit);

  // ——— the residual audit ———
  const residualAudit = await auditResiduals(input.stagingRoot, input.residualPollMs ?? 15_000);

  const record: ProcessStageRecord = {
    executable,
    cwd: input.stagingRoot,
    argv,
    env: {
      home,
      userData,
      userDataEnvVar: USER_DATA_ENV_VAR,
      inheritedKeys: LAUNCH_ENV_KEYS,
    },
    pid: state.child?.pid ?? null,
    spawnError: state.spawnError,
    settle: {
      settleMs: input.settleMs,
      aliveAtSettle: state.spawnError === null && earlyExit === null,
      earlyExit,
    },
    treeAtSettle,
    listeningSockets: socketsAtSettle,
    termination: {
      mode: input.quitMode,
      steps,
      outcome: termination.outcome,
      exitCode: termination.exitFacts?.code ?? null,
      signal: termination.exitFacts?.signal ?? null,
    },
    residualAudit,
    stdoutTail: state.stdoutTail,
    stderrTail: state.stderrTail,
  };
  return {
    launchOk: state.spawnError === null && earlyExit === null,
    terminationOk: termination.ok,
    residualOk: residualAudit.residuals.length === 0,
    record,
  };
}

/**
 * The launch environment: the isolation vars plus the #231 allowlist —
 * a MINIMAL allowlist inherited from the harness host and nothing else
 * (see the module law above). Exported for the candidate workflow's
 * lease leg (#259): one launch-env law, never a forked copy.
 */
export function buildLaunchEnv(home: string, userData: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    [USER_DATA_ENV_VAR]: userData,
    ELECTRON_ENABLE_LOGGING: '0',
  };
  for (const key of LAUNCH_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

/** Spawns the packaged executable, wiring the tail capture and the async error latch. */
function spawnApp(
  executable: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): LaunchState {
  const state: LaunchState = { child: null, spawnError: null, stdoutTail: [], stderrTail: [] };
  try {
    const child: ChildProcess = spawn(executable, argv, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    child.stdout?.on('data', (chunk: Buffer) => pushTail(state.stdoutTail, chunk));
    child.stderr?.on('data', (chunk: Buffer) => pushTail(state.stderrTail, chunk));
    child.stdin?.on?.('error', () => {});
    // a missing or non-executable binary surfaces HERE (the async error
    // event), not as a spawn throw — capture it or it becomes an
    // unhandled exception that leaves no record
    child.on('error', (error: Error) => {
      if (state.spawnError === null) state.spawnError = error.message;
    });
  } catch (error) {
    state.spawnError = error instanceof Error ? error.message : String(error);
  }
  return state;
}

/**
 * The settle observation: the app must stay alive through the whole
 * settle window. Returns the early exit when it didn't, null when it
 * held — the fact the launch verdict turns on.
 */
async function observeSettle(
  state: LaunchState,
  settleMs: number,
  settled: () => ExitFacts | null,
): Promise<ExitFacts | null> {
  if (state.spawnError !== null) {
    return { code: null, signal: null };
  }
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    await delay(500);
    const exit = settled();
    if (state.spawnError !== null || exit !== null) {
      return exit ?? { code: null, signal: null };
    }
  }
  return null;
}

/** The termination phase's conclusion: the outcome, the exit facts, and the per-law verdict. */
interface TerminationResult {
  readonly outcome: TerminationOutcome;
  readonly exitFacts: ExitFacts | null;
  readonly ok: boolean;
}

/**
 * The termination phase: spawn errors and early exits conclude without
 * a quit attempt; a live app is asked to quit through its own quit
 * surface (the Apple event) with the signal escalation behind it, or —
 * in signal-only mode — escalated straight away.
 */
async function terminateApp(
  input: ProcessStageInput,
  state: LaunchState,
  earlyExit: ExitFacts | null,
  steps: TerminationStep[],
  settled: () => ExitFacts | null,
  awaitExit: (boundMs: number) => Promise<ExitFacts | null>,
): Promise<TerminationResult> {
  let outcome: TerminationOutcome;
  let exitFacts: ExitFacts | null = settled();
  if (state.spawnError !== null) {
    outcome = 'spawn-error';
  } else if (earlyExit !== null) {
    outcome = 'launch-failed';
    exitFacts = settled();
  } else if (exitFacts !== null) {
    // exited by itself between settle and the quit attempt: clean only at code 0
    outcome = 'exited-before-termination';
  } else if (input.quitMode === 'apple-event') {
    const quit = await quitThroughAppleEvent(input, state.child, steps, settled, awaitExit);
    outcome = quit.outcome;
    exitFacts = quit.exitFacts;
  } else {
    const escalation = await escalateSignals(state.child, input, steps, awaitExit);
    exitFacts = settled();
    // a SIGKILLed process still "settles" — the escalation's own report,
    // not the settled flag, says whether the graceful signal sufficed
    outcome = escalation.usedKill ? 'termination-forced' : 'exited-after-signal';
  }
  const ok =
    outcome === 'exited-on-own-quit-surface' ||
    (outcome === 'exited-before-termination' && exitFacts?.code === 0) ||
    (input.quitMode === 'signal-only' && outcome === 'exited-after-signal');
  return { outcome, exitFacts, ok };
}

/**
 * The Apple-event quit path. One knob governs the whole path: the event
 * DELIVERY and the exit WAIT are each bounded by quitTimeoutMs (a
 * per-phase bound, never a second silent constant beside it — review
 * round 2 on #373). A failed or ignored quit surface falls through to
 * the signal escalation and fails the law.
 */
async function quitThroughAppleEvent(
  input: ProcessStageInput,
  child: ChildProcess | null,
  steps: TerminationStep[],
  settled: () => ExitFacts | null,
  awaitExit: (boundMs: number) => Promise<ExitFacts | null>,
): Promise<{ outcome: TerminationOutcome; exitFacts: ExitFacts | null }> {
  const sent = await appleEventQuit(input.bundleId, input.quitTimeoutMs);
  steps.push({
    step: 'apple-event-quit',
    detail: sent.ok ? 'quit event delivered' : `quit surface unavailable (${sent.error})`,
  });
  const exitFacts = await awaitExit(input.quitTimeoutMs);
  if (exitFacts !== null && sent.ok) {
    return { outcome: 'exited-on-own-quit-surface', exitFacts };
  }
  // the quit surface failed or was ignored: clean up with signals, and fail
  await escalateSignals(child, input, steps, awaitExit);
  return {
    outcome: sent.ok ? 'termination-forced' : 'quit-surface-unavailable',
    exitFacts: settled(),
  };
}

/**
 * The residual audit: poll (bounded) until every owned process is gone;
 * whatever survives is named, best-effort killed by the harness, and
 * re-checked — the run has already failed, the machine still gets
 * cleaned.
 */
async function auditResiduals(
  stagingRoot: string,
  residualPollMs: number,
): Promise<ProcessStageRecord['residualAudit']> {
  let polls = 0;
  let residuals = await processesReferencing(stagingRoot);
  const deadline = Date.now() + residualPollMs;
  while (residuals.length > 0 && Date.now() < deadline) {
    polls += 1;
    await delay(500);
    residuals = await processesReferencing(stagingRoot);
  }
  const harnessKilled: string[] = [];
  let postKillResiduals: ProcessRow[] = [];
  if (residuals.length > 0) {
    for (const row of residuals) {
      try {
        process.kill(Number(row.pid), 'SIGKILL');
        harnessKilled.push(row.pid);
      } catch {
        // already gone, or not ours to signal — the post-kill pass reports
      }
    }
    await delay(1000);
    postKillResiduals = [...(await processesReferencing(stagingRoot))];
  }
  return { pollMs: residualPollMs, polls, residuals, harnessKilled, postKillResiduals };
}

/** The graceful-then-forced signal escalation (SIGTERM, bounded; then SIGKILL the owned tree). Exported for the candidate workflow's lease leg (#259) — one escalation law. */
export async function escalateSignals(
  child: ChildProcess | null,
  input: EscalationInput,
  steps: TerminationStep[],
  awaitExit: (boundMs: number) => Promise<ExitFacts | null>,
): Promise<{ usedKill: boolean }> {
  child?.kill('SIGTERM');
  steps.push({ step: 'SIGTERM', detail: 'sent to the launched process' });
  const afterTerm = await awaitExit(input.termBoundMs ?? 10_000);
  if (afterTerm === null) {
    const owned = await processesReferencing(input.stagingRoot);
    for (const row of owned) {
      try {
        process.kill(Number(row.pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    child?.kill('SIGKILL');
    steps.push({
      step: 'SIGKILL-tree',
      detail: `SIGKILL to the launched process and ${owned.length} owned process(es)`,
    });
    await awaitExit(input.killBoundMs ?? 5_000);
    return { usedKill: true };
  }
  return { usedKill: false };
}

/** The Apple-event quit — the event Cmd+Q sends, addressed by bundle id (H6's `quitNormally`, translated). Exported for the candidate workflow's lease leg (#259) — one quit law. */
export async function appleEventQuit(
  bundleId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync('osascript', ['-e', `tell application id "${bundleId}" to quit`], {
      timeout: timeoutMs,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The live process tree referencing `root` — `pgrep -f` over an ERE-escaped path plus `ps` (H6's law, translated). */
export async function processesReferencing(root: string): Promise<ProcessRow[]> {
  const pattern = escapeEre(root);
  let pids: string;
  try {
    const result = await execFileAsync('pgrep', ['-f', pattern], { timeout: 30_000 });
    pids = result.stdout;
  } catch {
    return []; // pgrep exits 1 when nothing matches — the healthy state
  }
  const list = pids
    .split('\n')
    .map((pid) => pid.trim())
    .filter((pid) => pid.length > 0)
    .filter((pid) => pid !== String(process.pid));
  if (list.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'pid=,ppid=,command=', '-p', list.join(',')],
      {
        timeout: 30_000,
      },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parts = line.split(/\s+/);
        return { pid: parts[0] ?? '?', ppid: parts[1] ?? '?', command: parts.slice(2).join(' ') };
      });
  } catch {
    return [];
  }
}

/** The TCP listeners the given PIDs hold right now (evidence only; `lsof` exits 1 on none). */
export async function listeningSockets(pids: readonly string[]): Promise<string[]> {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(',')],
      { timeout: 30_000 },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function pushTail(tail: string[], chunk: Buffer): void {
  for (const raw of chunk.toString('utf8').split('\n')) {
    const line = raw.trim();
    if (line.length > 0) tail.push(line);
  }
  while (tail.length > TAIL_LINES) tail.shift();
}

function escapeEre(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\*]/g, '\\$&');
}

/** One termination step's escalation bounds — the structural subset of `ProcessStageInput` the escalation reads. */
export interface EscalationInput {
  /** The owned-tree root the SIGKILL sweep covers (`pgrep -f` over it). */
  readonly stagingRoot: string;
  /** Bound for the SIGTERM escalation (default 10 s). */
  readonly termBoundMs?: number;
  /** Bound after SIGKILL before the exit is considered unresolved (default 5 s). */
  readonly killBoundMs?: number;
}

/**
 * Awaits one child's exit, bounded — `null` when the bound expired
 * unresolved. Exported for the candidate workflow's lease leg (#259):
 * the one bounded-exit law, never a forked copy.
 */
export function awaitChildExit(
  child: ChildProcess | null,
  boundMs: number,
): Promise<ExitFacts | null> {
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

/** One bounded delay — the shared timer primitive (exported so the candidate workflow's lease leg runs the same law, #259). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
