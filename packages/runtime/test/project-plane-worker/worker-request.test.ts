import { findDisclosure } from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import {
  invalidationFamiliesFor,
  orderedFamilies,
} from '../../project-plane/worker/worker-events.ts';
import {
  branchFailure,
  branchFailureDiagnostic,
  cleanupDiagnostic,
  malformedRequestFailure,
  shutdownFailure,
  unconvergedFailure,
} from '../../project-plane/worker/worker-failure.ts';
import {
  isWorkerInspectionRequest,
  MAX_STYLES_ATTEMPTS,
} from '../../project-plane/worker/worker-request.ts';
import { adapterSeamRejection } from './plane-fakes.ts';

/**
 * The typed dispatch boundary (#230 focused tests): only the four closed
 * request shapes enter dispatch — the negative surface is the ticket's
 * migration policy made executable (no generic request, no extra-field
 * tolerance, no path-shaped styles input). The failure/diagnostic
 * message templates are verified against the PROTOCOL's own disclosure
 * guard from the test side: the worker keeps no runtime protocol
 * dependency (raw-forkable modules), so this is where the hygiene
 * contract is pinned.
 */

describe('isWorkerInspectionRequest', () => {
  it('accepts the three argument-less families and only them', () => {
    expect(isWorkerInspectionRequest({ kind: 'project' })).toBe(true);
    expect(isWorkerInspectionRequest({ kind: 'content' })).toBe(true);
    expect(isWorkerInspectionRequest({ kind: 'routes' })).toBe(true);
  });

  it('accepts a styles request with and without attempts', () => {
    expect(
      isWorkerInspectionRequest({ kind: 'styles', routeComponent: 'src/pages/index.astro' }),
    ).toBe(true);
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        attempts: 3,
      }),
    ).toBe(true);
  });

  it('rejects unknown kinds, non-objects, and arrays', () => {
    expect(isWorkerInspectionRequest(null)).toBe(false);
    expect(isWorkerInspectionRequest('styles')).toBe(false);
    expect(isWorkerInspectionRequest(42)).toBe(false);
    expect(isWorkerInspectionRequest([])).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'eval' })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'import', module: 'node:fs' })).toBe(false);
  });

  it('rejects over-carrying requests — no extra field ever rides a family', () => {
    expect(isWorkerInspectionRequest({ kind: 'project', path: '/etc/passwd' })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'content', vite: true })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'routes', routes: ['*'] })).toBe(false);
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        module: 'x',
      }),
    ).toBe(false);
  });

  it('rejects styles inputs outside the typed route-component contract', () => {
    expect(
      isWorkerInspectionRequest({ kind: 'styles', routeComponent: '/abs/pages/index.astro' }),
    ).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'styles', routeComponent: '../outside.astro' })).toBe(
      false,
    );
    expect(
      isWorkerInspectionRequest({ kind: 'styles', routeComponent: 'src/styles/main.css' }),
    ).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'styles', routeComponent: '' })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'styles', routeComponent: 7 })).toBe(false);
  });

  it('bounds the styles attempts knob', () => {
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        attempts: 0,
      }),
    ).toBe(false);
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        attempts: 1.5,
      }),
    ).toBe(false);
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        attempts: MAX_STYLES_ATTEMPTS + 1,
      }),
    ).toBe(false);
    expect(
      isWorkerInspectionRequest({
        kind: 'styles',
        routeComponent: 'src/pages/index.astro',
        attempts: MAX_STYLES_ATTEMPTS,
      }),
    ).toBe(true);
  });

  // #370: the control-plane-only resolution family — a /-rooted pathname
  // and nothing else; its ANSWER (the component) is the one payload-shape
  // fact this union never lets the wire carry.
  it('accepts exactly the route-selection shape: a kind and a /-rooted route', () => {
    expect(isWorkerInspectionRequest({ kind: 'route-selection', route: '/' })).toBe(true);
    expect(
      isWorkerInspectionRequest({ kind: 'route-selection', route: '/blog/hello-builder' }),
    ).toBe(true);
  });

  it('rejects route-selection inputs outside the observed-pathname contract', () => {
    expect(isWorkerInspectionRequest({ kind: 'route-selection', route: '' })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'route-selection', route: 'blog/x' })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'route-selection', route: 7 })).toBe(false);
    expect(isWorkerInspectionRequest({ kind: 'route-selection' })).toBe(false);
    expect(
      isWorkerInspectionRequest({
        kind: 'route-selection',
        route: '/',
        routeComponent: 'src/pages/index.astro',
      }),
    ).toBe(false);
  });
});

describe('invalidation family classification', () => {
  it('style-truth changes stale the styles family', () => {
    expect(invalidationFamiliesFor('src/styles/main.css')).toEqual(['styles']);
    expect(invalidationFamiliesFor('src/components/Header.astro')).toEqual(['styles']);
  });

  it('page component changes additionally stale routes — over-wide, never under', () => {
    expect(invalidationFamiliesFor('src/pages/index.astro')).toEqual(['routes', 'styles']);
    expect(invalidationFamiliesFor('src/pages/blog/[slug].astro')).toEqual(['routes', 'styles']);
  });

  // #387: a content edit used to fall into the styles-only fallback —
  // the styles-only publication the issue names. Content truth now
  // implicates its own family (and routes through the getStaticPaths
  // enumeration dependency — the same pair the write loop invalidates
  // client-side after every commit, #253 J3).
  it('content-truth changes stale the content family — and routes through the enumeration dependency', () => {
    expect(invalidationFamiliesFor('src/content/blog/hello-builder.md')).toEqual([
      'content',
      'routes',
    ]);
    expect(invalidationFamiliesFor('src/content/notes/out-of-band.md')).toEqual([
      'content',
      'routes',
    ]);
    expect(invalidationFamiliesFor('src/content.config.ts')).toEqual(['content', 'routes']);
  });

  it('a content entry ending .astro is both truths — all three families', () => {
    expect(invalidationFamiliesFor('src/content/gallery/entry.astro')).toEqual([
      'content',
      'routes',
      'styles',
    ]);
  });

  it('a file no family reads implicates nothing — the worker drops it', () => {
    expect(invalidationFamiliesFor('README.md')).toEqual([]);
    expect(invalidationFamiliesFor('src/assets/pixel.png')).toEqual([]);
  });

  it('published family order is the protocol enum order, deterministic', () => {
    expect(orderedFamilies(['styles', 'routes'])).toEqual(['routes', 'styles']);
    expect(orderedFamilies(['content', 'project', 'styles', 'routes'])).toEqual([
      'project',
      'content',
      'routes',
      'styles',
    ]);
  });
});

describe('worker failure and diagnostic hygiene (the protocol guard, test-side)', () => {
  const messages = [
    shutdownFailure().message,
    malformedRequestFailure().message,
    branchFailure('content', adapterSeamRejection()).message,
    branchFailure('content', new Error('raw text with /Users/leak and pid 1')).message,
    unconvergedFailure({
      outcome: 'mismatch',
      mismatch: { category: 'module-presence', expected: 'e', observed: 'o' },
      invalidationRevision: 2,
      evidence: [],
    }).message,
    unconvergedFailure({ outcome: 'raced', invalidationRevision: 5, evidence: [] }).message,
    branchFailureDiagnostic(branchFailure('styles', adapterSeamRejection())).message,
    cleanupDiagnostic('plane-close').message,
  ];

  it('every closed-template message passes the protocol disclosure guard', () => {
    for (const message of messages) {
      expect(findDisclosure(message), message).toBeNull();
    }
  });

  it('an unexpected branch failure never forwards the raw error text', () => {
    const failure = branchFailure('content', new Error('boom at /Users/secret (pid 4242)'));
    expect(failure.code).toBe('inspection-failed');
    if (failure.code !== 'inspection-failed') return;
    expect(failure.adapterCode).toBeNull();
    expect(failure.message).not.toContain('/Users/secret');
    expect(failure.message).not.toContain('pid');
    expect('details' in failure).toBe(false);
  });

  it('an adapter branch failure keeps the closed adapter code and sanitized details', () => {
    const failure = branchFailure('routes', adapterSeamRejection());
    if (failure.code !== 'inspection-failed') throw new Error('expected inspection-failed');
    expect(failure.adapterCode).toBe('seam-rejected');
    expect(failure.details).toEqual({
      seam: 'vite root export createServer()',
      seamClass: 'public',
      expected: 'a function createServer',
      observed: 'typeof undefined',
    });
  });
});
