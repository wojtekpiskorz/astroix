import { z } from 'zod';

/**
 * Inspection requests and results (ADR-0005 `ProjectRuntime.inspect()`:
 * only typed `project`, `content`, `routes`, and `styles` requests; every
 * result carries a monotonic resource revision — the freshness contract
 * behind grants). No arbitrary module import, no client-selected
 * filesystem path, no raw Vite access exists on this surface.
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

export const inspectionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('content') }),
  z.strictObject({ kind: z.literal('routes') }),
  z.strictObject({ kind: z.literal('styles') }),
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
