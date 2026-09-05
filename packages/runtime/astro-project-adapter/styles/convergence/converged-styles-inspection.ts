import { buildCssIndex } from '@wojciechpiskorz/astroix-core';
import type { ProjectRuntimeSeams } from '../../composition';
import type { RunnerCleanupEvidence } from '../../fresh-runner';
import { withFreshRunner } from '../../fresh-runner';
import type { DevCssSeamEntry, ModuleRunnerLike, ViteServerLike } from '../../seam-readers';
import { readDevCssEntries } from '../../seam-readers';
import { transformScopedStyleModules } from '../join/client-scoped-css';
import {
  type EffectiveSelectorRecord,
  joinEffectiveSelectors,
} from '../join/effective-selector-join';
import { readProjectCssSources } from '../join/project-css-sources';
import { createRawInvalidationSource, type RawInvalidationSource } from './invalidation-source';
import type { StylesMismatch } from './parity';
import { verifyJoinedPayload, verifyStylesParity } from './parity';

/**
 * The styles convergence inspection (#227, ADR-0005's `styles` request
 * behind the freshness contract): one inspection is one or more complete
 * FRESH passes — each pass borrows a brand-new server module runner
 * (closed in `finally` with the #206 cleanup proof on every exit path),
 * reads the static truth from disk, transforms the compiled truth in the
 * client environment, and verifies strict parity between the two. Only a
 * pass whose truths agree AND whose invalidation revision held steady
 * across the pass publishes a payload; everything else fails closed with
 * no payload and no revision advance.
 *
 * Disk source truth can advance before transformed graph truth (the B2
 * lesson, #217: after a write the static index updates immediately, but
 * some platforms' vite watchers never re-serve the transformed style
 * module — watcher liveness never implies convergence). So the protocol
 * treats transformed-graph truth as verifiable per pass, never assumed:
 * a classified mismatch (`parity.ts`) is rejected rather than served or
 * synthesized, and the retry is ALWAYS a later fresh inspection — a
 * transient mismatch can never silently downgrade selector or
 * source-range accuracy, because no data at all is published until the
 * join verifies over a converged world.
 *
 * The pass composes the #226 join's landed legs unchanged (the source
 * walk, the client transforms, the pure join) and adds the convergence
 * invariants around them: the fresh-runner lifetime spans the pass (the
 * #226 joiner closes its runner after the dev-css import leg; here the
 * evidence belongs to the whole pass), parity runs BEFORE the join so
 * disagreements classify instead of surfacing as bare seam rejections,
 * and the joined payload is proven a no-downgrade extension of the
 * static index. A parity pass followed by a join rejection is a
 * compatibility event — the join's own fail-closed rejection propagates.
 *
 * Runner discipline (#227 migration policy): no shared module-runner
 * cache across requests — the inspector holds no runner between calls;
 * every pass constructs, uses, and closes its own. Retry policy: no
 * timers, no stale-result acceptance — `attempts` bounds the immediate
 * fresh re-passes (each fully verified), and exhaustion returns the last
 * unfinished outcome for the caller's later retry.
 *
 * The payload also publishes the static walk's per-file digests (#405)
 * under the SAME freshness discipline — one read inside the pass, so a
 * published digest is the indexed truth's own, and the pass-level
 * invalidation race check guards it exactly as it guards the records.
 */

/** The converged styles payload — plain data only, stamped at an invalidation epoch. */
export interface ConvergedStylesPayload {
  /** Monotonic styles-resource revision — advances only on published (converged) passes. */
  readonly revision: number;
  /** The invalidation revision this payload converged at — valid until the source advances past it. */
  readonly invalidationRevision: number;
  readonly records: readonly EffectiveSelectorRecord[];
  /**
   * Per project-relative file: SHA-256 hex over the static walk's exact
   * bytes at this pass (#405) — the indexed truth's own digest. The
   * write enrichment re-verifies a later disk read against it, closing
   * the same-length drift window length-fit alone could not see: a
   * mismatch serves the file un-enriched, never a fresh grant over
   * stale records. JSON-safe by construction (worker IPC + the wire).
   */
  readonly fileDigests: Readonly<Record<string, string>>;
}

/** One styles inspection outcome — converged data, a classified mismatch, or an invalidation race. */
export type StylesInspectionOutcome =
  | {
      readonly outcome: 'converged';
      readonly payload: ConvergedStylesPayload;
      /** The fresh-runner cleanup proof, one entry per pass — closed and listener-restored every time. */
      readonly evidence: readonly RunnerCleanupEvidence[];
    }
  | {
      readonly outcome: 'mismatch';
      readonly mismatch: StylesMismatch;
      readonly invalidationRevision: number;
      readonly evidence: readonly RunnerCleanupEvidence[];
    }
  | {
      readonly outcome: 'raced';
      readonly invalidationRevision: number;
      readonly evidence: readonly RunnerCleanupEvidence[];
    };

/** One styles inspection request: the active route, lifecycle bounds, and the immediate-retry bound. */
export interface StylesInspectionInput {
  /** The active route's component (`src/pages/…`). */
  readonly routeComponent: string;
  /** Rejects the inspection with the caller's reason at pass and leg boundaries. */
  readonly signal?: AbortSignal;
  /**
   * Total passes per inspection (default 1: one pass, zero re-passes).
   * Each attempt is a complete fresh-runner pass with full verification —
   * a mismatch or race discards the attempt; only strict parity publishes.
   */
  readonly attempts?: number;
}

/** The converged styles inspector — many fresh passes over one composition. */
export interface ConvergedStylesInspector {
  inspect(input: StylesInspectionInput): Promise<StylesInspectionOutcome>;
  /** The revisioned invalidation source the inspector converges against. */
  readonly invalidations: RawInvalidationSource;
}

/** The unfinished outcomes an exhausted attempt bound returns — never a payload. */
type UnfinishedPass =
  | {
      readonly outcome: 'mismatch';
      readonly mismatch: StylesMismatch;
      readonly invalidationRevision: number;
    }
  | { readonly outcome: 'raced'; readonly invalidationRevision: number };

/** What one pass body produced: classified mismatch data, or the joined records with the walk's digests. */
type PassData =
  | { readonly kind: 'mismatch'; readonly mismatch: StylesMismatch }
  | {
      readonly kind: 'records';
      readonly records: readonly EffectiveSelectorRecord[];
      readonly fileDigests: Readonly<Record<string, string>>;
    };

/**
 * Creates the inspector over a composition server's seams. The
 * composition, its watcher, and the invalidation source are borrowed,
 * never owned — their teardown stays with the runtime lifecycle that
 * booted them (ADR-0005 normal stop).
 */
export function createConvergedStylesInspection(input: {
  readonly server: ViteServerLike;
  readonly seams: ProjectRuntimeSeams;
  /** An invalidation source built by the caller (tests, or a shared worker seam); defaults to one over the composition watcher. */
  readonly invalidations?: RawInvalidationSource;
}): ConvergedStylesInspector {
  const invalidations =
    input.invalidations ?? createRawInvalidationSource(input.server, input.seams.projectRoot);
  let revision = 0;
  return {
    invalidations,
    inspect: async ({ routeComponent, signal, attempts }) => {
      const requested = Math.trunc(attempts ?? 1);
      const maxAttempts = Number.isFinite(requested) ? Math.max(1, requested) : 1;
      const evidence: RunnerCleanupEvidence[] = [];
      let unfinished: UnfinishedPass | undefined;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        const passRevision = invalidations.revision;
        const pass = await withFreshRunner(
          {
            createServerModuleRunner: input.seams.vite.createServerModuleRunner,
            ssrEnvironment: input.server.environments.ssr,
          },
          (runner) => runPass(runner, input, routeComponent, signal),
        );
        evidence.push(pass.evidence);
        const endRevision = invalidations.revision;
        if (pass.result.kind === 'mismatch') {
          unfinished = {
            outcome: 'mismatch',
            mismatch: pass.result.mismatch,
            invalidationRevision: endRevision,
          };
          continue;
        }
        // A pass that raced a watcher invalidation observed a torn world —
        // its records may be pre- or post-edit, so they are never served;
        // the retry is the next fresh pass (this one or a later inspection).
        if (endRevision !== passRevision) {
          unfinished = { outcome: 'raced', invalidationRevision: endRevision };
          continue;
        }
        revision += 1;
        return {
          outcome: 'converged',
          payload: {
            revision,
            invalidationRevision: passRevision,
            records: pass.result.records,
            fileDigests: pass.result.fileDigests,
          },
          evidence,
        };
      }
      // maxAttempts >= 1 means the loop ran and every path through it
      // either returned a converged outcome or assigned unfinished.
      if (unfinished === undefined) {
        throw new Error(
          'the attempt loop ended without an outcome (a programming invariant break)',
        );
      }
      return { ...unfinished, evidence };
    },
  };
}

/** One complete pass body — everything inside the fresh runner's lifetime. */
async function runPass(
  runner: ModuleRunnerLike,
  input: { readonly server: ViteServerLike; readonly seams: ProjectRuntimeSeams },
  routeComponent: string,
  signal: AbortSignal | undefined,
): Promise<PassData> {
  signal?.throwIfAborted();
  const cssSet = await importRouteCssSet(runner, input.seams, routeComponent, signal);
  if (cssSet.kind === 'mismatch') return cssSet;
  const compiled = await transformScopedStyleModules(
    input.server.environments.client,
    cssSet.entries,
    { routeComponent },
  );
  signal?.throwIfAborted();
  // One walk: the sources for the static index AND the per-file digests
  // the payload publishes (#405) come from the same single read — the
  // digest is the indexed truth's own, never a second read's.
  const walk = await readProjectCssSources(input.seams.projectRoot);
  const staticRecords = buildCssIndex(walk.sources);
  signal?.throwIfAborted();
  const mismatch = verifyStylesParity(staticRecords, compiled, {
    requiredScopedFiles: [routeComponent],
  });
  if (mismatch !== null) return { kind: 'mismatch', mismatch };
  const records = joinEffectiveSelectors(staticRecords, compiled, {
    requiredScopedFiles: [routeComponent],
  });
  verifyJoinedPayload(staticRecords, compiled, records);
  return { kind: 'records', records, fileDigests: walk.fileDigests };
}

/**
 * The route CSS set leg with transient classification: a dev-css import
 * rejection means the route's compiled-CSS set is unavailable — a
 * `module-presence` mismatch (retryable; the cause is preserved for the
 * runtime plane's logs), while the export-shape check stays the
 * fail-closed seam probe it is in #226. Cancellation is the caller's
 * (E5's idiom, routes-inspection.ts): an import rejection observed while
 * the signal fired is the abort, not a transient — the caller's reason
 * rejects the pass instead of burning attempts on a mismatch outcome for
 * an inspection the caller already abandoned.
 */
async function importRouteCssSet(
  runner: ModuleRunnerLike,
  seams: ProjectRuntimeSeams,
  routeComponent: string,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly kind: 'entries'; readonly entries: readonly DevCssSeamEntry[] }
  | { readonly kind: 'mismatch'; readonly mismatch: StylesMismatch }
> {
  let moduleExports: unknown;
  try {
    moduleExports = await runner.import(seams.getDevCSSModuleName(routeComponent));
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    return {
      kind: 'mismatch',
      mismatch: {
        category: 'module-presence',
        expected:
          'the active route component dev-css virtual module to import (the route compiled-CSS set)',
        observed: 'a module import rejection for the active route component',
        cause,
      },
    };
  }
  return { kind: 'entries', entries: readDevCssEntries(moduleExports) };
}
