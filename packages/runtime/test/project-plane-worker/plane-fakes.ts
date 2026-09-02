import type { AdapterErrorDetails } from '../../astro-project-adapter/adapter-error.ts';
import { AdapterError } from '../../astro-project-adapter/adapter-error.ts';
import type { ContentInspectionResult } from '../../astro-project-adapter/content/content-result.ts';
import type { RoutesInspectionResult } from '../../astro-project-adapter/routes/routes-inspection.ts';
import type {
  ConvergedStylesPayload,
  StylesInspectionInput,
  StylesInspectionOutcome,
} from '../../astro-project-adapter/styles/convergence/converged-styles-inspection.ts';
import type { StylesInvalidation } from '../../astro-project-adapter/styles/convergence/invalidation-source.ts';
import type {
  InspectionBranches,
  ProjectDescriptor,
  ProjectWorkerPlane,
  RawInvalidationSource,
} from '../../project-plane/worker/inspection-branches.ts';

/**
 * The #230 focused-test stand-in, at the sanctioned level: a fake at
 * the worker's TYPED DISPATCH BOUNDARY (the four inspection branches +
 * the raw invalidation stream + the plane close) — NOT a third fake
 * composition/runner pair (the E4/E5 harnesses own that idiom at the
 * seam layer; the recorded advisory note rules the worker lane fakes
 * here). Every recorded call, captured signal, and behavior knob below
 * exists to prove a worker contract, never adapter behavior.
 */

/** What a branch does when called. */
export type BranchBehavior =
  | 'ok'
  /** Rejects with a seam-rejected AdapterError (the sanitized failure carrier). */
  | 'adapter'
  /** Rejects with a raw error whose message would leak if forwarded. */
  | 'raw-throw'
  /** Never settles; abortable through the signal the worker passes (styles/routes). */
  | 'hang'
  /** Never settles and IGNORES the signal — a pathological pass only the stop bound can outlive. */
  | 'hang-deaf';

export interface FakePlane {
  plane: ProjectWorkerPlane;
  /** What each branch does; flip freely between calls. */
  readonly behaviors: {
    project: BranchBehavior;
    styles: BranchBehavior;
    content: BranchBehavior;
    routes: BranchBehavior;
  };
  /** The payload knobs for 'ok' behavior. */
  readonly payloads: {
    project: ProjectDescriptor;
    styles: ConvergedStylesPayload;
    content: ContentInspectionResult;
    routes: RoutesInspectionResult;
  };
  /** The styles outcome knob: 'ok' serves `payloads.styles`; these force an unfinished outcome. */
  stylesOutcomeOverride: 'mismatch' | 'raced' | null;
  /** Recorded branch calls. */
  readonly calls: {
    project: number;
    content: number;
    styles: StylesInspectionInput[];
    routes: Array<{ signal?: AbortSignal }>;
  };
  /** Every signal the styles branch observed (merged lifecycle/caller). */
  readonly stylesSignals: Array<AbortSignal | undefined>;
  /** Every signal the routes branch observed. */
  readonly routesSignals: Array<AbortSignal | undefined>;
  /** Resolve to release a 'hang' branch (the hang also releases on its signal's abort). */
  readonly release: {
    project: () => void;
    content: () => void;
    styles: () => void;
    routes: () => void;
  };
  /** How many times `plane.close()` ran, and whether it rejects. */
  readonly close: { calls: number; behavior: 'ok' | 'fail' };
  /** The raw invalidation stream's live listener count (subscription accounting). */
  readonly sourceListenerCount: () => number;
  /** Fires one raw invalidation event for a project-relative file, minting the next revision. */
  fireInvalidation(file: string): void;
}

/** A never-settling pass that rejects on its signal's abort and resolves when its release knob fires. */
function hanging<T>(
  signal: AbortSignal | undefined,
  releaseKey: string,
  releases: Record<string, () => void>,
  ok: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
    releases[releaseKey] = () => resolve(ok());
  });
}

/** The seam-rejection the 'adapter' behavior rejects with (sanitized by the adapter's own guard). */
export function adapterSeamRejection(): AdapterError {
  const details: AdapterErrorDetails = {
    seam: 'vite root export createServer()',
    seamClass: 'public',
    expected: 'a function createServer',
    observed: 'typeof undefined',
  };
  return new AdapterError(
    'seam-rejected',
    'AstroProjectAdapter seam rejection at vite root export createServer(): expected a function createServer; observed typeof undefined',
    details,
  );
}

export function fakePlane(): FakePlane {
  const sourceListeners = new Set<(event: StylesInvalidation) => void>();
  let revision = 0;
  let stylesRevision = 0;

  const calls: FakePlane['calls'] = {
    project: 0,
    content: 0,
    styles: [],
    routes: [],
  };
  const stylesSignals: Array<AbortSignal | undefined> = [];
  const routesSignals: Array<AbortSignal | undefined> = [];
  const close: FakePlane['close'] = { calls: 0, behavior: 'ok' };

  const releases = {
    project: () => {},
    content: () => {},
    styles: () => {},
    routes: () => {},
  } as Record<string, () => void>;

  const fake: FakePlane = {
    plane: undefined as unknown as ProjectWorkerPlane,
    behaviors: { project: 'ok', styles: 'ok', content: 'ok', routes: 'ok' },
    payloads: {
      project: { certified: { astro: '7.2.10', vite: '8.2.2' } },
      styles: { revision: 1, invalidationRevision: 0, records: [] },
      content: { collections: [], diagnostics: [], revision: 'sha-content-truth' },
      routes: { revision: 1, routes: [] },
    },
    stylesOutcomeOverride: null,
    calls,
    stylesSignals,
    routesSignals,
    release: {
      project: () => releases.project?.(),
      content: () => releases.content?.(),
      styles: () => releases.styles?.(),
      routes: () => releases.routes?.(),
    },
    close,
    sourceListenerCount: () => sourceListeners.size,
    fireInvalidation: (file: string) => {
      revision += 1;
      const event: StylesInvalidation = { revision, file };
      for (const listener of sourceListeners) listener(event);
    },
  };

  const runBehavior = async <T>(
    behavior: BranchBehavior,
    signal: AbortSignal | undefined,
    releaseKey: string,
    ok: () => T,
  ): Promise<T> => {
    if (behavior === 'adapter') throw adapterSeamRejection();
    if (behavior === 'raw-throw') {
      // A raw failure whose message would be a disclosure if forwarded.
      throw new Error('boom at /Users/secret/project-root (pid 4242)');
    }
    if (behavior === 'hang') {
      return await hanging<T>(signal, releaseKey, releases, ok);
    }
    if (behavior === 'hang-deaf') {
      return await new Promise<T>((resolve) => {
        releases[releaseKey] = () => resolve(ok());
      });
    }
    return ok();
  };

  const branches: InspectionBranches = {
    project: () => {
      calls.project += 1;
      return runBehavior(fake.behaviors.project, undefined, 'project', () => fake.payloads.project);
    },
    styles: (input: StylesInspectionInput) => {
      calls.styles.push(input);
      stylesSignals.push(input.signal);
      return runBehavior(fake.behaviors.styles, input.signal, 'styles', () => {
        if (fake.stylesOutcomeOverride === 'mismatch') {
          const outcome: StylesInspectionOutcome = {
            outcome: 'mismatch',
            mismatch: {
              category: 'module-presence',
              expected: 'the route compiled-CSS set',
              observed: 'a module import rejection',
            },
            invalidationRevision: 3,
            evidence: [],
          };
          return outcome;
        }
        if (fake.stylesOutcomeOverride === 'raced') {
          const outcome: StylesInspectionOutcome = {
            outcome: 'raced',
            invalidationRevision: 4,
            evidence: [],
          };
          return outcome;
        }
        stylesRevision += 1;
        const outcome: StylesInspectionOutcome = {
          outcome: 'converged',
          payload: { ...fake.payloads.styles, revision: stylesRevision },
          evidence: [],
        };
        return outcome;
      });
    },
    content: () => {
      calls.content += 1;
      return runBehavior(fake.behaviors.content, undefined, 'content', () => fake.payloads.content);
    },
    routes: (input: { signal?: AbortSignal }) => {
      calls.routes.push(input);
      routesSignals.push(input.signal);
      return runBehavior(fake.behaviors.routes, input.signal, 'routes', () => {
        const payload = fake.payloads.routes;
        return { ...payload, revision: calls.routes.length };
      });
    },
  };

  const invalidations: RawInvalidationSource = {
    get revision() {
      return revision;
    },
    subscribe(listener: (event: StylesInvalidation) => void): () => void {
      sourceListeners.add(listener);
      return () => {
        sourceListeners.delete(listener);
      };
    },
  };

  const plane: ProjectWorkerPlane = {
    inspections: branches,
    invalidations,
    close: async () => {
      close.calls += 1;
      if (close.behavior === 'fail') throw new Error('plane close failed');
    },
  };
  fake.plane = plane;
  return fake;
}
