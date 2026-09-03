import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

/**
 * The shared real-Electron harness kit of the `e2e/desktop` lanes: one
 * `HarnessRun` (spawn the real Electron binary over a lane-built
 * harness main; drive it over a line protocol on stdin/stdout) and the
 * shared vite bundling of a harness entry. Born at the second consumer
 * (#247's service-worker lane over #246's document-authority lane —
 * the house rule: a shared helper is born when the second consumer
 * appears, and stays as small as its job) and grown at the third
 * (#248's packaged lane): `PackagedAppRun` (early-package-kit.ts)
 * subclasses this run over the REAL packaged-app executable with an
 * injected env/cwd — the pump, the waiter registry, the stderr bound,
 * and the quit-then-SIGKILL stop live HERE, one law for every lane.
 *
 * The kit also carries the one behavioral fix the duplicated copies
 * hid: stdout is LINE-BUFFERED — a report line split across two `data`
 * chunk boundaries is accumulated and emitted only once complete. The
 * per-chunk parsers both lanes carried would silently drop such a
 * fragment and surface it as a 30-second timeout (a latent flake under
 * backpressure; fixed here once, for every lane).
 *
 * Lane gates only — this file exists for real-Electron spec files run
 * behind `npm run test:desktop`; never release evidence (ADR-0008).
 */

/** The repository root (the spec files and this kit live under `e2e/desktop`). */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The workspace's pinned Electron binary (ADR-0008: exactly 44.1.0). */
export const ELECTRON = join(REPO, 'node_modules', '.bin', 'electron');

/** One protocol event off a harness main: a `kind` plus open fields. */
export interface HarnessEvent {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** What one lane parameterizes: its bundle or executable, its report-line prefix, extra argv. */
export interface HarnessRunOptions {
  /**
   * The lane-built harness main (see `buildHarnessMain`) — the default
   * Electron launch's single argument. Optional only for a lane that
   * supplies its own `executable` (the packaged lane runs the real app
   * binary with its own argv).
   */
  readonly bundle?: string;
  /** The executable to launch — the workspace Electron binary by default; the packaged lane overrides it with the real app binary. */
  readonly executable?: string;
  /** Extra argv after the bundle (e.g. a JSON config argument, or the packaged lane's browser switches). */
  readonly argv?: readonly string[];
  /** The full launch environment — when absent, the harness default (the parent env plus logging quiet). Lanes that must PRUNE the parent env (the packaged laws) compose their own. */
  readonly env?: NodeJS.ProcessEnv;
  /** The launch cwd — the repository root by default. */
  readonly cwd?: string;
  /** The stdout prefix one lane's reports carry (`astroix-…-harness: `). */
  readonly reportPrefix: string;
}

/** One spawned harness run: the line protocol over the real Electron main. */
export class HarnessRun {
  readonly child: ChildProcess;
  readonly events: HarnessEvent[] = [];
  /**
   * Every complete stdout line, tail-bounded (the runaway guard — the
   * #129 bounded-evidence law; the lanes' mains emit a handful of lines,
   * and the packaged lane's sanitization audit scans exactly these).
   */
  readonly stdoutLines: string[] = [];
  /** The child's stderr tail, bounded — a harness crash must surface as error text, never an opaque timeout (#129's law: keep the error text; truncation ate the one unexplained red). */
  readonly stderrLines: string[] = [];
  private readonly reportPrefix: string;
  /** The trailing partial stdout line, carried until its `\n` arrives. */
  private stdoutRemainder = '';
  private readonly waiters: {
    match: (event: HarnessEvent, seq: number) => boolean;
    resolve: (event: HarnessEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private exitSettled?: Promise<{ code: number | null; signal: string | null }>;
  private static readonly MAX_LINES = 500;

  constructor(options: HarnessRunOptions) {
    if (options.bundle === undefined && options.executable === undefined) {
      throw new Error(
        'harness-kit: a run needs a bundle (the Electron default) or its own executable',
      );
    }
    this.reportPrefix = options.reportPrefix;
    const args =
      options.bundle === undefined
        ? [...(options.argv ?? [])]
        : [options.bundle, ...(options.argv ?? [])];
    this.child = spawn(options.executable ?? ELECTRON, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.pump(chunk);
    });
    // Capture the full stderr, tail-bounded — the red-run diagnosis law.
    this.child.stderr?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.trim();
        if (line.length > 0) this.stderrLines.push(line);
      }
      while (this.stderrLines.length > 50) this.stderrLines.shift();
    });
    // The quit write can race the child's own exit (a destroyed-target
    // leg leaves no windows and Electron can quit with it): a dead-pipe
    // write must stay a swallowed event, never an unhandled EPIPE.
    this.child.stdin?.on('error', () => {});
  }

  /**
   * One stdout chunk: the carried remainder plus the chunk splits into
   * COMPLETE lines only — the last, possibly incomplete fragment is
   * carried forward, so a report line split across chunk boundaries is
   * parsed exactly once, never as two droppable fragments.
   */
  private pump(chunk: Buffer): void {
    const text = this.stdoutRemainder + chunk.toString('utf8');
    const lines = text.split('\n');
    this.stdoutRemainder = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length === 0) continue;
      this.stdoutLines.push(line);
      while (this.stdoutLines.length > HarnessRun.MAX_LINES) this.stdoutLines.shift();
      if (!line.startsWith(this.reportPrefix)) continue;
      let event: HarnessEvent;
      try {
        event = JSON.parse(line.slice(this.reportPrefix.length)) as HarnessEvent;
      } catch {
        continue;
      }
      const seq = this.events.length;
      this.events.push(event);
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        if (waiter?.match(event, seq)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(index, 1);
          waiter.resolve(event);
          index -= 1;
        }
      }
    }
  }

  /**
   * True when the child has SETTLED — exited by code or killed by
   * signal. The ONE settled predicate (`exitCode === null` alone is the
   * signal-death hole: a signal-killed child keeps `exitCode` null and
   * carries the signal in `signalCode`, and cleanup that gates on
   * `exitCode` then awaits a fresh `once('exit')` listener can never
   * resolve — the hook-timeout hang). Shared by `exit` and `stop`.
   */
  private get settled(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** The exit settlement (idempotent; safe to await from many legs). */
  get exit(): Promise<{ code: number | null; signal: string | null }> {
    this.exitSettled ??= new Promise((resolve) => {
      if (this.settled) {
        resolve({ code: this.child.exitCode, signal: this.child.signalCode });
        return;
      }
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return this.exitSettled;
  }

  private timeoutError(what: string): Error {
    return new Error(
      `timed out waiting for ${what}; events so far:\n${JSON.stringify(this.events)}` +
        `\nchild stderr tail:\n${this.stderrLines.slice(-20).join('\n') || '(empty)'}`,
    );
  }

  send(command: Record<string, unknown>): void {
    if (this.child.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  }

  /**
   * Waits for the first event matching `match` — already-seen events included.
   * The timeout bound is the lane's to set (30 s default; the packaged
   * lane's real-GUI legs need the longer bound).
   */
  waitFor(
    match: (event: HarnessEvent) => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<HarnessEvent> {
    const already = this.events.find(match);
    if (already !== undefined) return Promise.resolve(already);
    return this.waitForNext((event) => match(event), what, timeoutMs);
  }

  /**
   * Waits for a strictly FUTURE event (`seq` is the event's index, so a
   * caller that snapshots `events.length` before sending can demand its
   * own response — never a stale earlier one).
   */
  waitForNext(
    match: (event: HarnessEvent, seq: number) => boolean,
    what: string,
    timeoutMs = 30_000,
  ): Promise<HarnessEvent> {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          reject(this.timeoutError(what));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * The ordered stop: quit op (a lane whose main ignores stdin just
   * never reads it), bounded graceful wait, SIGKILL, and a BOUNDED
   * post-kill wait — cleanup can never hang. Already-settled children
   * (code OR signal) return immediately: the settlement promise, never
   * a fresh `once('exit')` listener that an already-exited child can
   * never fire.
   */
  async stop(): Promise<void> {
    if (this.settled) return;
    this.send({ op: 'quit' });
    await Promise.race([this.exit, sleep(5000)]);
    if (!this.settled) {
      this.child.kill('SIGKILL');
      // Bounded even against an unkillable child — the 180 s
      // hook-timeout hang class dies here.
      await Promise.race([this.exit, sleep(2000)]);
    }
  }
}

/** One bounded sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bundles one lane's harness main with the shared rules (the
 * workspace's own toolchain; only `electron` and the node builtins
 * stay external) and returns the bundle path.
 */
export async function buildHarnessMain(entry: string, outDir: string): Promise<string> {
  await build({
    root: REPO,
    configFile: false,
    logLevel: 'silent',
    build: {
      target: 'node20',
      outDir,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry,
        formats: ['es'],
        fileName: () => 'harness.js',
      },
      rollupOptions: {
        external: (id) => id === 'electron' || id.startsWith('node:'),
        output: { entryFileNames: 'harness.js' },
      },
    },
  });
  return join(outDir, 'harness.js');
}
