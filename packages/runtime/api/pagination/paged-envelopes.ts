import {
  type ByteLimitName,
  type InspectionKind,
  type ProjectSummary,
  type ResponseEnvelope,
  responseEnvelopeSchema,
  type SessionRef,
} from '@wojciechpiskorz/astroix-protocol';
import { type BoundedPageRefusal, boundedPage } from './page-contract.ts';

/**
 * Protocol-typed page builders (#235, F3; ADR-0006 §7 "Per-resource,
 * per-response, per-event limits — list and inspection APIs paginate
 * before their cap"): the two response shapes that carry unbounded
 * collections — the registry's project list and the inspection results
 * — assembled page by page so the serialized response envelope NEVER
 * breaches its cap, by construction rather than by the transport's
 * final refusal gate. Each budget is the LIMITS entry the ADR names for
 * that API: `lifecycleJsonBytes` (64 KiB) for the registry/lifecycle
 * JSON of `list-projects`, `inspectionResponseBytes` (32 MiB) for an
 * inspection response — "paginate before THEIR cap".
 *
 * The envelope is constructed THROUGH the protocol's closed
 * `responseEnvelopeSchema` (the `buildErrorEnvelope` idiom: closure at
 * construction), and the page math (`./page-contract.ts`) counts UTF-8
 * bytes over the serialized envelope (the `envelopeBytes` unit). The
 * continuation is an offset cursor the CALLER owns: protocol v1's
 * closed request envelopes carry no page parameters, so page size and
 * cursor are server-side composition choices, and payload interiors —
 * where a contract may surface a cursor — stay contract-owned
 * (`packages/protocol/src/inspection.ts`: interiors are deliberately
 * opaque here).
 */

/**
 * The budget each list API paginates under — the registry/lifecycle
 * JSON cap (ADR-0006 §7: 64 KiB for `list-projects` and registry
 * reads).
 */
export const LIST_PAGE_BUDGET: ByteLimitName = 'lifecycleJsonBytes';

/**
 * The budget inspection APIs paginate under — the inspection response
 * cap (ADR-0006 §7: 32 MiB per inspection response).
 */
export const INSPECTION_PAGE_BUDGET: ByteLimitName = 'inspectionResponseBytes';

/** One materialized page: the wire-ready envelope plus its slice and continuation — or the honest refusal. */
export type PagedEnvelope<T> =
  | {
      readonly kind: 'page';
      readonly envelope: ResponseEnvelope;
      readonly envelopeBytes: number;
      readonly items: readonly T[];
      readonly continuation: number | null;
    }
  | BoundedPageRefusal;

/** Assembles one `project-list` response page under the lifecycle JSON cap — the idle read; no session invented (ADR-0006 §7). */
export function pagedProjectList(input: {
  readonly requestId: string;
  readonly projects: readonly ProjectSummary[];
  readonly offset?: number;
  readonly requestedPageSize?: number;
}): PagedEnvelope<ProjectSummary> {
  return buildPage(
    LIST_PAGE_BUDGET,
    { items: input.projects, offset: input.offset, requestedPageSize: input.requestedPageSize },
    (page) => ({
      protocolVersion: 1,
      requestId: input.requestId,
      result: { kind: 'project-list', projects: page },
    }),
  );
}

/**
 * Assembles one `inspection` response page under the inspection
 * response cap. `payloadFor` owns how a page becomes the payload
 * interior — the contract-owned seam (`packages/protocol/src/inspection.ts`);
 * `items` is whatever collection the caller pages over.
 */
export function pagedInspection<T>(input: {
  readonly requestId: string;
  readonly session: SessionRef;
  readonly inspectionKind: InspectionKind;
  readonly revision: number;
  readonly items: readonly T[];
  readonly payloadFor: (page: readonly T[]) => unknown;
  readonly offset?: number;
  readonly requestedPageSize?: number;
}): PagedEnvelope<T> {
  return buildPage(INSPECTION_PAGE_BUDGET, input, (page) => ({
    protocolVersion: 1,
    requestId: input.requestId,
    session: input.session,
    result: {
      kind: 'inspection',
      result: {
        kind: input.inspectionKind,
        revision: input.revision,
        payload: input.payloadFor(page),
      },
    },
  }));
}

/** Runs the page math over the raw envelope object, then closes the winning page through the protocol's schema. */
function buildPage<T>(
  budget: ByteLimitName,
  input: {
    readonly items: readonly T[];
    readonly offset?: number;
    readonly requestedPageSize?: number;
  },
  envelopeFor: (page: readonly T[]) => unknown,
): PagedEnvelope<T> {
  const page = boundedPage({
    items: input.items,
    offset: input.offset ?? 0,
    ...(input.requestedPageSize !== undefined
      ? { requestedPageSize: input.requestedPageSize }
      : {}),
    budget,
    envelopeFor,
  });
  if (page.kind === 'refused') {
    return page;
  }
  return {
    kind: 'page',
    envelope: responseEnvelopeSchema.parse(envelopeFor(page.items)),
    envelopeBytes: page.pageBytes,
    items: page.items,
    continuation: page.continuation,
  };
}
