import { z } from 'zod';

/**
 * Inspection requests and results (ADR-0005 `ProjectRuntime.inspect()`:
 * only typed `project`, `content`, `routes`, and `styles` requests; every
 * result carries a monotonic resource revision — the freshness contract
 * behind grants). No arbitrary module import, no client-selected
 * filesystem path, no raw Vite access exists on this surface. The one
 * selection a request may carry is the styles family's `route` (#370):
 * an observed canvas PATHNAME the control plane resolves to the active
 * route server-side — never a component, never a filesystem path.
 *
 * Payload interiors are deliberately opaque here (`z.unknown()`): their
 * shapes are owned by the frozen behavior contracts
 * (`e2e/behavior-contracts/`) — the corpus the replacement web host is
 * judged against (ADR-0010) — and the web-host lanes bind them to this
 * envelope. Duplicating payload schemas in this package would fork the
 * truth; the *envelope* (closed kind discriminants + revision) is what
 * protocol v1 owns (#220: closed command/result unions).
 */

/** The closed set of inspection families (ADR-0005). */
export const inspectionKindSchema = z.enum(['project', 'content', 'routes', 'styles']);
export type InspectionKind = z.infer<typeof inspectionKindSchema>;

/** Monotonic per-resource version carried by every inspection result (ADR-0005/0006 §6). */
export const resourceRevisionSchema = z.number().int().nonnegative();

/**
 * The observed canvas pathname a `styles` inspection carries as its
 * route selection (#370, the ruling's wire shape): `/`-rooted, no
 * query, no fragment, no empty segments, no whitespace, no backslash —
 * the grammar `location.pathname` produces on the project origin. This
 * is a selection INPUT, never a served value: it names a route the
 * control plane resolves; the resolved component stays behind the
 * runtime (the no-disclosure law).
 */
export function isObservedPathname(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.includes('//') &&
    !value.includes('\\') &&
    !value.includes('?') &&
    !value.includes('#') &&
    !/\s/.test(value)
  );
}

/** The wire-carried route selection: an observed canvas pathname. */
export const observedPathnameSchema = z.string().min(1).refine(isObservedPathname, {
  message: 'route must be an observed canvas pathname (/-rooted, no query, no fragment)',
});

export const inspectionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('content') }),
  z.strictObject({ kind: z.literal('routes') }),
  // The `route` selection is additive (#370 over the #351 precedent: a
  // closed envelope gains a field, never a kind): a styles request
  // without one still parses — and the executor refuses it, because a
  // styles inspection cannot be served without a selection.
  z.strictObject({ kind: z.literal('styles'), route: observedPathnameSchema.optional() }),
]);

/**
 * One inspection result: the closed family discriminant, the resource
 * revision the payload is valid at, and the family payload itself
 * (contract-owned interior, opaque at the envelope layer).
 */
export const inspectionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('project'),
    revision: resourceRevisionSchema,
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('content'),
    revision: resourceRevisionSchema,
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('routes'),
    revision: resourceRevisionSchema,
    payload: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('styles'),
    revision: resourceRevisionSchema,
    payload: z.unknown(),
  }),
]);

export type InspectionRequest = z.infer<typeof inspectionRequestSchema>;
export type InspectionResult = z.infer<typeof inspectionResultSchema>;
