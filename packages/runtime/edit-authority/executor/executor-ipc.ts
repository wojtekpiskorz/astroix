import type { DomainWritePlan } from '../planning/write-plans.ts';
import type { WriteExecutor } from './write-executor.ts';
import { ExecutorFencedError, type WriteOutcome, writeRejection } from './write-outcomes.ts';

/**
 * The control-plane ↔ write-executor channel (#224; the executor's
 * analogue of `private-boot/private-ipc.ts` and the project-plane
 * worker's channel): the exact forked child's private IPC channel
 * carrying ONLY typed wire messages — accepted domain write plans in,
 * correlated terminal outcomes out, one stop control, and the close
 * report. The executor's boot and lease live in `executor-child`; this
 * loop serves whatever executor it is handed.
 *
 * `serveWriteExecutor` is the child's single-shot serving loop. A
 * message outside the closed wire union is a protocol violation in the
 * spawning control plane — terminal crash (exit 76), cleanup first,
 * never guessed at. A well-formed message whose PLAN fails closed
 * structural validation is answered with the `malformed-plan` rejection
 * (it was never accepted work), not a crash. On every closing path the
 * loop drains the executor first — every accepted operation reaches a
 * terminal outcome, its reply sent when the channel still stands — and
 * only then exits: the edit-writer lease this child lifetime-holds is
 * released by that exit and nothing else.
 *
 * Wire-size limits are deliberately NOT re-enforced here: the planning
 * boundary (#223) parses every wire plan through the protocol's bounded
 * `writePlanSchema` before a domain plan exists, and this private
 * channel between the control plane and its own child is not the public
 * wire. The structural validator below is the executor's own closed
 * shape gate, hand-rolled (no zod, no protocol runtime dependency) so a
 * raw forked Node child loads it under type stripping — the
 * kernel-lease/private-boot discipline.
 */

/** sysexits.h exits for the executor child (the control-plane boot convention). */
/** Clean drained stop or disconnect; the lease releases with the exit. */
export const EXIT_OK = 0;
/** Internal crash path (EX_SOFTWARE): a serving bug or a forced crash exit. */
export const EXIT_CRASH = 70;
/** Lease contention (EX_CANTCREAT): another live process holds the edit-writer lease. */
export const EXIT_LEASE_CONTENTION = 73;
/** Boot failure or incomplete cleanup (EX_IOERR) — fail closed, never contention. */
export const EXIT_FAILURE = 74;
/** Wire protocol violation (EX_PROTOCOL): a message outside the closed union. */
export const EXIT_PROTOCOL = 76;

/**
 * The channel subset the serving loop consumes; `process` in a forked
 * child satisfies this structurally, `executorChannel()` adapts it.
 */
export interface ExecutorChannel {
  /** False once the other end closed or was disconnected. */
  readonly connected: boolean;
  /** Sends one JSON message; false/null when the channel is gone. */
  send(message: unknown): boolean | null;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  removeListener(event: 'message', listener: (message: unknown) => void): unknown;
  removeListener(event: 'disconnect', listener: () => void): unknown;
}

/**
 * Adapts this process's IPC channel (a forked child) to the seam. Throws
 * when the process has no IPC channel — a process without one was never
 * the exact executor child a control plane spawned.
 */
export function executorChannel(nativeProcess: NodeJS.Process): ExecutorChannel {
  if (typeof nativeProcess.send !== 'function') {
    throw new TypeError('this process has no write-executor IPC channel (not a spawned child)');
  }
  return nativeProcess as unknown as ExecutorChannel;
}

/** The closed inbound wire union: accepted domain write plans in, one stop control. */
export type ExecutorWireIn =
  | { readonly type: 'execute'; readonly id: number; readonly plan: unknown }
  | { readonly type: 'stop' };

/** The closed outbound wire union: boot proof, correlated outcomes, the close report. */
export type ExecutorWireOut =
  | { readonly type: 'ready' }
  | { readonly type: 'outcome'; readonly id: number; readonly outcome: WriteOutcome }
  | {
      readonly type: 'closed';
      readonly report: { readonly outcome: 'drained'; readonly settled: number };
    };

/** Whether `value` is one of the two inbound wire messages (the plan interior validates separately). */
export function isExecutorWireIn(value: unknown): value is ExecutorWireIn {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'stop') return Object.keys(record).length === 1;
  if (record.type !== 'execute') return false;
  return (
    Object.keys(record).length === 3 &&
    typeof record.id === 'number' &&
    Number.isInteger(record.id) &&
    record.id >= 0
  );
}

const RESOURCE_KINDS = ['content', 'css'] as const;
const OPERATIONS = ['replace-contents', 'splice', 'create-contents'] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Closed structural validation of one dispatched domain write plan —
 * the executor's own shape gate over the private channel. Strict: exact
 * field sets, exact literal species, and every scalar bounded by its
 * closed pattern. A shape this rejects is answered with the
 * `malformed-plan` rejection — it was never accepted work. The check is
 * hand-rolled (see the module docstring) and mirrors D4's shapes; it
 * grants nothing by itself — every authority fact is re-checked by the
 * executor core after admission.
 */
export function isDomainWritePlan(value: unknown): value is DomainWritePlan {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.operation === 'replace-contents' || record.operation === 'create-contents') {
    return (
      Object.keys(record).length === 3 &&
      isResource(record.resource) &&
      typeof record.contents === 'string'
    );
  }
  if (record.operation === 'splice') {
    return (
      Object.keys(record).length === 4 &&
      isResource(record.resource) &&
      isExactRecord(record.range, ['start', 'end']) &&
      isNonNegativeInteger((record.range as Record<string, unknown>).start) &&
      isNonNegativeInteger((record.range as Record<string, unknown>).end) &&
      typeof record.replacement === 'string'
    );
  }
  return false;
}

function isResource(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const resource = value as Record<string, unknown>;
  if (
    !isExactRecord(resource, [
      'canonicalRoot',
      'session',
      'kind',
      'operations',
      'displayPath',
      'baseline',
      'target',
    ])
  ) {
    return false;
  }
  if (typeof resource.canonicalRoot !== 'string' || resource.canonicalRoot.length === 0) {
    return false;
  }
  if (!isSessionRef(resource.session)) return false;
  if (!isOneOf(resource.kind, RESOURCE_KINDS)) return false;
  if (
    !Array.isArray(resource.operations) ||
    resource.operations.length === 0 ||
    !resource.operations.every((operation) => isOneOf(operation, OPERATIONS))
  ) {
    return false;
  }
  if (typeof resource.displayPath !== 'string') return false;
  if (typeof resource.baseline !== 'object' || resource.baseline === null) return false;
  const baseline = resource.baseline as Record<string, unknown>;
  if (baseline.type === 'sha256') {
    if (Object.keys(baseline).length !== 2 || typeof baseline.sha256 !== 'string') return false;
    if (!SHA256_PATTERN.test(baseline.sha256)) return false;
  } else if (baseline.type !== 'expected-absent' || Object.keys(baseline).length !== 1) {
    return false;
  }
  return isTarget(resource.target);
}

function isTarget(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  // Key counts include the discriminator: existing = {type, canonicalPath},
  // creation = {type, canonicalParent, fileName} — exact sets, nothing more.
  if (target.type === 'existing') {
    return Object.keys(target).length === 2 && typeof target.canonicalPath === 'string';
  }
  if (target.type === 'creation') {
    return (
      Object.keys(target).length === 3 &&
      typeof target.canonicalParent === 'string' &&
      typeof target.fileName === 'string' &&
      isFileNameSegment(target.fileName)
    );
  }
  return false;
}

function isSessionRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isExactRecord(ref, ['runtimeEpoch', 'generation']) &&
    typeof ref.runtimeEpoch === 'string' &&
    ref.runtimeEpoch.length > 0 &&
    isNonNegativeInteger(ref.generation) &&
    (ref.generation as number) > 0
  );
}

/** A creation file name is exactly one path segment — never traversal, separators, or dot names. */
function isFileNameSegment(fileName: string): boolean {
  return (
    fileName.length > 0 &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !fileName.includes('\0') &&
    fileName !== '.' &&
    fileName !== '..'
  );
}

function isExactRecord(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function isOneOf<T extends string>(value: unknown, kinds: readonly T[]): value is T {
  return typeof value === 'string' && (kinds as readonly string[]).includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export interface ServeWriteExecutorInput {
  readonly channel: ExecutorChannel;
  readonly executor: WriteExecutor;
  /** The exit transition; defaults to `process.exit`. Injected by in-process tests only. */
  readonly exitProcess?: (exitCode: number) => void;
}

/**
 * Serves the executor over its private channel until the terminal exit.
 * Every close path funnels through the executor's single drain: stop
 * control → drain → close report → exit 0; channel disconnect → the
 * same drain (accepted work still reaches terminal — its replies have
 * nowhere to go, but the writes' atomicity is not abandoned mid-flight),
 * then exit 0; wire violation → drain, then the forced 76. After the
 * exit the loop is dead — nothing re-boots, and the kernel lease is
 * released by exactly this process exit.
 */
export function serveWriteExecutor(input: ServeWriteExecutorInput): void {
  const exitProcess = input.exitProcess ?? ((exitCode: number) => process.exit(exitCode));
  let exited = false;
  let forcedExitCode: number | null = null;

  const exitOnce = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    exitProcess(exitCode);
  };

  const send = (message: ExecutorWireOut): void => {
    if (exited || !input.channel.connected) return;
    input.channel.send(message);
  };

  input.executor.closed.then((report) => {
    send({ type: 'closed', report });
    exitOnce(forcedExitCode ?? EXIT_OK);
  });

  const terminate = (forcedCode: number | null): void => {
    if (exited) return;
    forcedExitCode ??= forcedCode;
    void input.executor.stop();
  };

  const serveExecute = async (id: number, plan: unknown): Promise<void> => {
    if (!isDomainWritePlan(plan)) {
      // A plan outside the closed domain shape is a control-plane bug at
      // the dispatching seam: answered, never crashed on — the work was
      // never accepted, so it has no outcome beyond this rejection.
      send({ type: 'outcome', id, outcome: writeRejection('malformed-plan') });
      return;
    }
    try {
      send({ type: 'outcome', id, outcome: await input.executor.execute(plan) });
    } catch (error) {
      if (error instanceof ExecutorFencedError) {
        send({ type: 'outcome', id, outcome: writeRejection('fenced') });
        return;
      }
      // execute maps every failure; an unstructured rejection here is a
      // serving bug — the parent gets its answer, then the child dies.
      send({ type: 'outcome', id, outcome: unexpectedFailure() });
      terminate(EXIT_CRASH);
    }
  };

  const onMessage = (message: unknown): void => {
    if (exited) return;
    if (!isExecutorWireIn(message)) {
      // A message outside the closed wire union is a protocol drift in
      // the spawning control plane — terminal, never guessed at.
      terminate(EXIT_PROTOCOL);
      return;
    }
    if (message.type === 'stop') {
      terminate(null);
      return;
    }
    void serveExecute(message.id, message.plan);
  };

  const onDisconnect = (): void => {
    // The control plane is gone: drain the accepted work to terminal
    // (completing an atomic sequence beats abandoning it), then exit —
    // the lease releases with the process, never before.
    terminate(null);
  };

  input.channel.on('message', onMessage);
  input.channel.on('disconnect', onDisconnect);
  if (!input.channel.connected) onDisconnect();

  send({ type: 'ready' });
}

/** The serving-bug failure: an unstructured execute rejection — honest failure, then the crash exit. */
function unexpectedFailure(): WriteOutcome {
  return { type: 'failed', code: 'write-failed', message: 'the operation failed unexpectedly' };
}
