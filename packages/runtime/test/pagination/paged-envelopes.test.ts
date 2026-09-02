import {
  LIMITS,
  type ProjectSummary,
  responseEnvelopeSchema,
  type SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import { describe, expect, it } from 'vitest';
import { responseWithinCap } from '../../api/http/reserved-handler.ts';
import {
  INSPECTION_PAGE_BUDGET,
  LIST_PAGE_BUDGET,
  pagedInspection,
  pagedProjectList,
} from '../../api/pagination/paged-envelopes.ts';

/**
 * The F3 protocol-typed page-builder focused legs (#235): the two
 * response shapes that carry unbounded collections — `project-list`
 * under the 64 KiB lifecycle JSON cap, `inspection` under the 32 MiB
 * inspection response cap — every page a closed `responseEnvelope`
 * (construction through the schema), every page within ITS budget AND
 * within the transport's `responseWithinCap` gate, and the completion
 * walk lossless.
 */

/** A valid routing key (26 lowercase Base32 chars, the protocol's shape). */
const KEY_A = 'abcdefghijklmnopqrstuvwxyz';
const SESSION: SessionRef = { runtimeEpoch: 'epoch-fixture', generation: 1 };

/** Deterministic project summaries of roughly `units` serialized bytes each. */
function projectsOf(count: number, units: number): ProjectSummary[] {
  const base32Tail = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from({ length: count }, (_unused, index) => ({
    projectKey: `${KEY_A.slice(0, 24)}${base32Tail[index % base32Tail.length]}${base32Tail[(index * 7) % base32Tail.length]}`,
    displayName: `project ${index} ${'p'.repeat(units)}`,
    availability: 'available' as const,
  }));
}

describe('pagedProjectList (the list API paginates before the lifecycle JSON cap)', () => {
  it('carries a small registry whole with a null continuation and a closed envelope', () => {
    const projects = projectsOf(3, 10);
    const page = pagedProjectList({ requestId: 'req-1', projects });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.envelope.result.kind).toBe('project-list');
    expect(responseEnvelopeSchema.parse(page.envelope)).toEqual(page.envelope);
    expect(page.items).toEqual(projects);
    expect(page.continuation).toBeNull();
    expect(page.envelopeBytes).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
    expect(responseWithinCap(JSON.stringify(page.envelope))).toBe(true);
  });

  it('invents no session on the idle registry read (ADR-0006 §7)', () => {
    const page = pagedProjectList({ requestId: 'req-1', projects: projectsOf(1, 10) });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.envelope.session).toBeUndefined();
  });

  it('paginates a registry too large for the cap — every page within it, the walk lossless', () => {
    const projects = projectsOf(600, 220);
    const collected: ProjectSummary[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = pagedProjectList({ requestId: 'req-1', projects, offset });
      expect(page.kind, `page ${pages}`).toBe('page');
      if (page.kind !== 'page') throw new Error('unreachable');
      expect(page.envelopeBytes, `page ${pages}`).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
      expect(responseWithinCap(JSON.stringify(page.envelope)), `page ${pages}`).toBe(true);
      expect(page.items.length, `page ${pages}`).toBeGreaterThan(0);
      collected.push(...page.items);
      pages += 1;
      if (page.continuation === null) break;
      offset = page.continuation;
    }
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(projects);
  });

  it('honors the server-chosen page size and clamps it under the budget', () => {
    // 40 summaries of ~3 KB cannot fit the 64 KiB cap together: the
    // requested 40 is a hint, the budget decides.
    const projects = projectsOf(40, 3000);
    const page = pagedProjectList({
      requestId: 'req-1',
      projects,
      offset: 4,
      requestedPageSize: 40,
    });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.items.length).toBeLessThan(36);
    expect(page.items).toEqual(projects.slice(4, 4 + page.items.length));
    expect(page.continuation).toBe(4 + page.items.length);
    expect(page.envelopeBytes).toBeLessThanOrEqual(LIMITS.lifecycleJsonBytes);
  });
});

describe('pagedInspection (inspection APIs paginate before the response cap)', () => {
  /** The contract-owned interior seam: a page of rules becomes the payload. */
  const payloadFor = (page: readonly string[]): { rules: readonly string[] } => ({ rules: page });

  it('builds a closed inspection envelope carrying the session and the revision', () => {
    const page = pagedInspection({
      requestId: 'req-1',
      session: SESSION,
      inspectionKind: 'styles',
      revision: 7,
      items: ['body {}'],
      payloadFor,
    });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.envelope.session).toEqual(SESSION);
    expect(page.envelope.result).toEqual({
      kind: 'inspection',
      result: { kind: 'styles', revision: 7, payload: { rules: ['body {}'] } },
    });
    expect(responseEnvelopeSchema.parse(page.envelope)).toEqual(page.envelope);
    expect(page.continuation).toBeNull();
    expect(responseWithinCap(JSON.stringify(page.envelope))).toBe(true);
  });

  it('honors the requested page size — the server-side ceiling, not the wire request', () => {
    const rules = Array.from({ length: 10 }, (_unused, index) => `rule-${index} { color: red; }`);
    const page = pagedInspection({
      requestId: 'req-1',
      session: SESSION,
      inspectionKind: 'styles',
      revision: 7,
      items: rules,
      payloadFor,
      requestedPageSize: 4,
    });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.items).toEqual(rules.slice(0, 4));
    expect(page.continuation).toBe(4);
    const next = pagedInspection({
      requestId: 'req-2',
      session: SESSION,
      inspectionKind: 'styles',
      revision: 7,
      items: rules,
      payloadFor,
      offset: 4,
      requestedPageSize: 4,
    });
    if (next.kind !== 'page') throw new Error('unreachable');
    expect(next.items).toEqual(rules.slice(4, 8));
    expect(next.continuation).toBe(8);
  });

  it('clamps a page size that would breach even the 32 MiB inspection cap', () => {
    // One ~12 MiB rule string: three of them breach the 32 MiB cap.
    const huge = `body { content: '${'x'.repeat(12 * 1024 * 1024)}'; }`;
    const page = pagedInspection({
      requestId: 'req-1',
      session: SESSION,
      inspectionKind: 'styles',
      revision: 7,
      items: [huge, huge, huge],
      payloadFor,
      requestedPageSize: 3,
    });
    expect(page.kind).toBe('page');
    if (page.kind !== 'page') return;
    expect(page.items.length).toBeLessThan(3);
    expect(page.envelopeBytes).toBeLessThanOrEqual(LIMITS.inspectionResponseBytes);
    expect(responseWithinCap(JSON.stringify(page.envelope))).toBe(true);
    expect(page.continuation).toBe(page.items.length);
  });

  it('refuses a single rule that alone breaches the cap — never truncated', () => {
    const page = pagedInspection({
      requestId: 'req-1',
      session: SESSION,
      inspectionKind: 'styles',
      revision: 7,
      items: [`body { content: '${'x'.repeat(33 * 1024 * 1024)}'; }`],
      payloadFor,
    });
    expect(page).toMatchObject({
      kind: 'refused',
      reason: 'single-item-over-budget',
      limit: INSPECTION_PAGE_BUDGET,
    });
  });
});

describe('the budget mapping (each API paginates before ITS cap)', () => {
  it('pins the two budgets to their LIMITS entries', () => {
    expect(LIST_PAGE_BUDGET).toBe('lifecycleJsonBytes');
    expect(INSPECTION_PAGE_BUDGET).toBe('inspectionResponseBytes');
    expect(LIMITS[LIST_PAGE_BUDGET]).toBe(64 * 1024);
    expect(LIMITS[INSPECTION_PAGE_BUDGET]).toBe(32 * 1024 * 1024);
  });
});
