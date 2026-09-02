import { z } from 'zod';
import { byteLength, LIMITS } from './limits';

/**
 * Edit authority on the wire (ADR-0006 §6): the server issues opaque,
 * random, per-activation **resource grants** from its own Content and
 * style discovery — the browser never asks the server to bless an
 * arbitrary path. A grant binds (server-side) the canonical project
 * identity, `SessionRef`, resource kind, allowed operations, canonical
 * target, and revision contract; the wire representation is opaque
 * (ADR-0006 §9). A project-relative display path may be returned for UI
 * only and is never accepted back as authority.
 */

/** sha256 hex — the optimistic-concurrency currency of text resources (ADR-0006 §6). */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase sha256 hex');

/**
 * A project-relative posix display path — the confinement shape shared
 * with the frozen contracts' style. UI-only metadata: absolute paths,
 * traversal, and schemes can never parse.
 */
export const projectRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes('://') &&
      !path.split('/').includes('..'),
    { message: 'display path must be a project-relative posix path' },
  );

/** The resource kinds Astroix's own discovery issues grants for (ADR-0006 §6). */
export const resourceKindSchema = z.enum(['content', 'css']);

/** The write primitives: whole-resource replacement, an in-place splice, or creation. */
export const editOperationKindSchema = z.enum(['replace-contents', 'splice', 'create-contents']);

/**
 * The revision contract a grant is bound to (ADR-0006 §6): an existing
 * text resource requires its exact SHA-256 baseline; creation requires
 * an explicit expected-absent baseline (race-safe through exclusive
 * creation).
 */
export const revisionContractSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('sha256'), sha256: sha256HexSchema }),
  z.strictObject({ type: z.literal('expected-absent') }),
]);

/**
 * The wire shape of a resource grant: the opaque authority token plus the
 * non-authoritative metadata the UI renders. What it authorizes is
 * decided by the issuing edit authority re-validating the full server-side
 * grant table at execution time — this object is a claim, not the check.
 */
export const resourceGrantSchema = z.strictObject({
  /** Opaque, random, per-activation token — the only write authority the browser holds. */
  token: z.string().min(1),
  kind: resourceKindSchema,
  /** The allowed operations for this grant (a subset of what the kind permits). */
  operations: z.array(editOperationKindSchema).min(1),
  /** Project-relative display path — UI only, never accepted back as authority. */
  displayPath: projectRelativePathSchema,
  /** The freshness precondition every execution of this grant re-checks. */
  baseline: revisionContractSchema,
});

/**
 * Offsets into the resource's current **string contents** — JavaScript
 * string indices (UTF-16 code units), end-exclusive; start precedes end.
 * The unit matches the frozen splice-window contract exactly
 * (`e2e/behavior-contracts` `sourceRange` over the file's string content,
 * re-derived by `packages/core`'s splice-writer): not UTF-8 byte offsets,
 * which the envelope caps count in a different space.
 */
export const sourceRangeSchema = z
  .strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((range) => range.start < range.end, {
    message: 'range.start must precede range.end',
  });

/** Editable text bounded by the per-resource cap (ADR-0006 §7: 8 MiB per editable text resource). */
const editableTextSchema = z.string().superRefine((text, ctx) => {
  if (byteLength(text) > LIMITS.editableResourceBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `editable text exceeds the ${LIMITS.editableResourceBytes}-byte per-resource limit (ADR-0006 §7)`,
    });
  }
});

/**
 * A write plan: the grant that authorizes it, the operation, and the
 * payload. The grant's baseline and the operation's shape are validated
 * together by the issuing authority at execution time — a stale, revoked,
 * mismatched, cross-session, or changed-at-final-validation grant fails
 * **without writing** (ADR-0006 §6).
 */
export const writePlanSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('replace-contents'),
    grant: resourceGrantSchema,
    contents: editableTextSchema,
  }),
  z.strictObject({
    operation: z.literal('splice'),
    grant: resourceGrantSchema,
    range: sourceRangeSchema,
    replacement: editableTextSchema,
  }),
  z.strictObject({
    operation: z.literal('create-contents'),
    grant: resourceGrantSchema,
    contents: editableTextSchema,
  }),
]);

/**
 * A successful write: the resulting resource revision plus — where another
 * edit is allowed — a follow-on grant bound to that new revision
 * (ADR-0006 §6).
 */
export const editResultSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  nextGrant: resourceGrantSchema.optional(),
});

export type Sha256Hex = z.infer<typeof sha256HexSchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type EditOperationKind = z.infer<typeof editOperationKindSchema>;
export type RevisionContract = z.infer<typeof revisionContractSchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type WritePlan = z.infer<typeof writePlanSchema>;
export type EditResult = z.infer<typeof editResultSchema>;
