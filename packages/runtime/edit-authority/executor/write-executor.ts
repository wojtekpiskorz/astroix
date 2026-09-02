import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { sameSession, sha256Hex } from '../grants/canonical-bounds.ts';
import type { DomainWritePlan } from '../planning/write-plans.ts';
import { CommitError, createExclusive, replaceExisting } from './commit.ts';
import {
  type FinalValidation,
  validateCreationTarget,
  validateExistingTarget,
} from './final-validation.ts';
import {
  type ExecutorCloseReport,
  ExecutorFencedError,
  type WriteOutcome,
  writeFailure,
  writeRejection,
} from './write-outcomes.ts';

/**
 * The serialized write executor core (#224, ADR-0006 §6): the exact,
 * disposable executor one project session owns. Work is admitted only
 * from its own process boundary (in production the private control-plane
 * channel — nothing browser-reachable exists here), strictly serialized
 * in admission order, and each accepted operation runs the full
 * pipeline: the session/grant/operation fact checks, the
 * immediate-before-commit world recheck (realpath/lstat, containment,
 * revision, link — `final-validation`), byte production, and the commit
 * discipline (`commit`). Every accepted operation settles into exactly
 * one terminal outcome; `unknown` is never produced here — a live
 * executor always knows whether its own atomic replacement resolved, and
 * only the spawner side of the seam, observing a forced exit, can honestly
 * report it (ADR-0006 §4).
 *
 * The core holds no lease: the kernel edit-writer lease is
 * process-lifetime machinery and belongs to the child composition
 * (`executor-child`), which acquires it before this core is ever built
 * and releases it — the only release there is — by exiting after every
 * accepted operation is terminal. Draining is unbounded here by design:
 * the five-second drain deadline and the force path are the fence/drain
 * lane's (F5, ADR-0006 §4); this core's `stop` simply fences admission
 * and settles `closed` when the last accepted operation has.
 *
 * Domain serialization stays domain-specific (#223): entry and css
 * `replace-contents`/`create-contents` plans arrive with their final
 * text already serialized by the vertical; the only byte production here
 * is the splice window — the frozen splice contract's string-index
 * arithmetic (UTF-16 code units, end-exclusive), re-checked against the
 * verified bytes so a plan built against different text can never splice.
 * Like the kernel-lease/private-boot seams, this module keeps no runtime
 * dependency on the workspace packages (protocol is type-only) so a raw
 * forked Node child loads it under type stripping.
 */

export type WriteExecutorState = 'running' | 'stopping' | 'closed';

export interface WriteExecutor {
  readonly state: WriteExecutorState;
  /**
   * Submits one accepted domain write plan. Resolves with its terminal
   * outcome (never `unknown` — see the module docstring). Throws
   * `ExecutorFencedError` when the executor is stopping or closed: the
   * work was never accepted, so it has no outcome at all.
   */
  execute(plan: DomainWritePlan): Promise<WriteOutcome>;
  /**
   * Fences admission and begins the drain. Idempotent; resolves with the
   * close report once every accepted operation is terminal.
   */
  stop(): Promise<ExecutorCloseReport>;
  /** Settles with the close report after the drain completes. */
  readonly closed: Promise<ExecutorCloseReport>;
}

export interface WriteExecutorOptions {
  /** The canonical project root (the grant table's realpath'd root identity). */
  readonly canonicalRoot: string;
  /** The one session this executor serves; every plan's bound session must be exactly it. */
  readonly session: SessionRef;
}

interface AcceptedOperation {
  readonly plan: DomainWritePlan;
  readonly resolve: (outcome: WriteOutcome) => void;
}

export function createWriteExecutor(options: WriteExecutorOptions): WriteExecutor {
  const accepted: AcceptedOperation[] = [];
  let settled = 0;
  let state: WriteExecutorState = 'running';
  let draining = false;

  let resolveClosed: ((report: ExecutorCloseReport) => void) | undefined;
  const closed = new Promise<ExecutorCloseReport>((resolve) => {
    resolveClosed = resolve;
  });

  /** Strict serialization: exactly one operation is in flight; the next starts only after it settles. */
  const pump = (): void => {
    if (draining || accepted.length === 0) return;
    const next = accepted.shift();
    if (next === undefined) return;
    draining = true;
    void runOperation(next.plan)
      .then((outcome) => {
        settled += 1;
        next.resolve(outcome);
      })
      .catch(() => {
        // runOperation maps every classified failure onto an outcome;
        // reaching here is an executor bug — the operation still settles,
        // honestly failed, never pending forever.
        settled += 1;
        next.resolve(writeFailure('write-failed'));
      })
      .finally(() => {
        draining = false;
        if (state !== 'running' && accepted.length === 0) {
          state = 'closed';
          resolveClosed?.({ outcome: 'drained', settled });
          return;
        }
        pump();
      });
  };

  async function runOperation(plan: DomainWritePlan): Promise<WriteOutcome> {
    // ——— the fact checks: session, grant, operation, coherence ———
    const admission = checkFacts(options, plan);
    if (admission !== null) return admission;
    const resource = plan.resource;

    // ——— the immediate-before-commit world recheck ———
    let world: FinalValidation;
    try {
      world =
        resource.target.type === 'existing'
          ? await validateExistingTarget(resource)
          : await validateCreationTarget(resource);
    } catch {
      // A filesystem error the recheck itself could not classify: the
      // operation is honestly failed, and no byte was produced or written.
      return writeFailure('read-failed');
    }
    if (!world.ok) return writeRejection(world.code);

    // ——— byte production ———
    let nextText: string;
    if (plan.operation === 'splice') {
      // The frozen splice-window contract as the protocol bounds it
      // (edits.ts sourceRange, mirrored by the wire gate): UTF-16 string
      // indices, end-exclusive, non-negative and ORDERED (`start < end`),
      // with end inside the bytes final validation just proved. An
      // inverted range would silently duplicate bytes — it rejects, never
      // splices; in-process callers get the same fence the wire gate gives.
      if (
        world.kind !== 'existing' ||
        plan.range.start < 0 ||
        plan.range.start >= plan.range.end ||
        plan.range.end > world.text.length
      ) {
        return writeRejection('range-outside-baseline');
      }
      nextText =
        world.text.slice(0, plan.range.start) + plan.replacement + world.text.slice(plan.range.end);
    } else {
      nextText = plan.contents;
    }

    // ——— the commit discipline ———
    // Binding to what validation PROVED, never a re-reading of the plan's
    // target: checkFacts already established the operation/target species
    // coherence, the validation dispatch ran the matching world check,
    // and FinalValidation carries the exact canonical target (path or
    // parent+name) the checks proved — so the commit discriminates on the
    // proven kind alone and there is no second coherence branch here.
    try {
      if (world.kind === 'creation') {
        await createExclusive(world.canonicalParent, world.fileName, nextText);
      } else {
        await replaceExisting(world.canonicalPath, nextText, world.mode);
      }
    } catch (error) {
      if (error instanceof CommitError) return writeFailure(error.code);
      // An unexpected filesystem error is honestly failed, never guessed:
      // before the rename the original is intact by construction, and a
      // raw error here never carried an outcome across the rename.
      return writeFailure('write-failed');
    }
    return { type: 'committed', revision: sha256Hex(Buffer.from(nextText, 'utf8')) };
  }

  return {
    get state(): WriteExecutorState {
      return state;
    },
    execute: (plan) =>
      new Promise<WriteOutcome>((resolve, reject) => {
        if (state !== 'running') {
          reject(new ExecutorFencedError());
          return;
        }
        accepted.push({ plan, resolve });
        pump();
      }),
    stop: () => {
      if (state === 'running') state = 'stopping';
      if (state === 'stopping' && !draining && accepted.length === 0) {
        state = 'closed';
        resolveClosed?.({ outcome: 'drained', settled });
      }
      return closed;
    },
    closed,
  };
}

/**
 * The session/grant/operation fact checks every accepted plan repeats
 * before its world recheck: the plan's bound session must be exactly this
 * executor's session (a cross-session plan never writes — the replay
 * fence the grant table enforces at planning, held here at execution),
 * the grant's canonical root must be exactly this executor's root, the
 * operation must be among the grant's allowed set, and the
 * operation/target/baseline species must be coherent (a replace needs an
 * existing target under its exact SHA-256 contract, a creation needs a
 * creation target under expected-absent). Returns the rejection outcome,
 * or null when the facts hold.
 */
function checkFacts(options: WriteExecutorOptions, plan: DomainWritePlan): WriteOutcome | null {
  const resource = plan.resource;
  if (!sameSession(resource.session, options.session)) return writeRejection('cross-session');
  if (resource.canonicalRoot !== options.canonicalRoot) return writeRejection('wrong-root');
  if (!resource.operations.includes(plan.operation)) {
    return writeRejection('operation-not-allowed');
  }
  const speciesOk =
    plan.operation === 'create-contents'
      ? resource.target.type === 'creation' && resource.baseline.type === 'expected-absent'
      : plan.operation === 'replace-contents' || plan.operation === 'splice'
        ? resource.target.type === 'existing' && resource.baseline.type === 'sha256'
        : false;
  if (!speciesOk) return writeRejection('operation-target-mismatch');
  return null;
}
