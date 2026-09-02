import { z } from 'zod';
import { sha256HexSchema } from './edits';
import { BYTE_LIMIT_NAMES } from './limits';
import { sanitizedTextSchema } from './sanitization';

/**
 * Public errors (ADR-0006 §7): a stable envelope (`protocolVersion`,
 * `requestId`, optional `session`, `error.code/message/retryable/details?`)
 * over a **closed** code set, where `details` is a code-specific union of
 * sanitized fields — omitted entirely for codes without an approved
 * schema. Public errors never disclose roots, ports, PIDs, environment
 * values, capabilities, or stacks: the code set and the per-code detail
 * schemas below are the approved surface, all free text passes the
 * disclosure guard (`sanitization.ts`), and the strict object shapes
 * reject any field outside the union.
 *
 * The 409/421 semantics of ADR-0006: `concurrent-activation` is the §4
 * "a concurrent activation fails 409" answer; `misdirected-request` is
 * the §5 "a retired project host returns 421 Misdirected Request" answer.
 */

/** The closed public error code set. */
export const PUBLIC_ERROR_CODES = [
  /** Unknown JSON field, malformed discriminant, bad shape, ambiguous encoding (ADR-0006 §7). */
  'malformed-request',
  /** `protocolVersion` other than 1 (ADR-0006 §7: reject unsupported protocol versions). */
  'unsupported-protocol-version',
  /** An envelope exceeded its ADR-0006 §7 byte limit. */
  'payload-too-large',
  /** Missing/wrong host capability or client role (ADR-0006 §7; ADR-0007 boundary). */
  'unauthorized',
  /** Unknown project key or reserved route (ADR-0007 listener/routing). */
  'resource-not-found',
  /** 421: the host/route no longer serves the referenced session (ADR-0006 §5). */
  'misdirected-request',
  /** The command's SessionRef is not the current pair (ADR-0006 §3/§5). */
  'stale-session',
  /** 409: a concurrent activation is in flight (ADR-0006 §4 step 1). */
  'concurrent-activation',
  /** A grant failed validation without writing (ADR-0006 §6). */
  'grant-rejected',
  /** 409: expected SHA-256 or expected-absent precondition failed (ADR-0006 §6). */
  'revision-conflict',
  /** Catch-all; details have no approved schema by construction. */
  'internal-error',
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

// --- the approved per-code detail schemas (closed, sanitized) ---

export const malformedRequestDetailsSchema = z.strictObject({
  issue: z.enum(['unknown-field', 'invalid-discriminant', 'invalid-shape', 'ambiguous-encoding']),
  /** JSON-pointer-style location, e.g. `command` or `plan.grant` — never a filesystem path. */
  pointer: z
    .string()
    .min(1)
    .refine((pointer) => !pointer.startsWith('/'), {
      message: 'pointer is a field path into the JSON envelope, not an absolute path',
    })
    .optional(),
});

export const unsupportedProtocolVersionDetailsSchema = z.strictObject({
  /** The rejected `protocolVersion` value. */
  received: z.number(),
});

export const payloadTooLargeDetailsSchema = z.strictObject({
  /**
   * Which ADR-0006 §7 limit was exceeded — derived from `LIMITS`
   * (`BYTE_LIMIT_NAMES`), so a new byte cap extends this enum with the
   * constant instead of drifting from it.
   */
  limit: z.enum(BYTE_LIMIT_NAMES),
  receivedBytes: z.number().int().nonnegative(),
});

export const resourceNotFoundDetailsSchema = z.strictObject({
  what: z.enum(['project', 'route', 'resource']),
});

export const grantRejectedDetailsSchema = z.strictObject({
  /** Why the grant failed — policy categories, not filesystem facts (ADR-0006 §6). */
  reason: z.enum([
    'revoked',
    'cross-session',
    'kind-mismatch',
    'operation-not-allowed',
    'hard-link',
    'external-symlink',
  ]),
});

export const revisionConflictDetailsSchema = z.strictObject({
  /** The resource's current baseline the next attempt must serialize against (ADR-0006 §6). */
  currentSha256: sha256HexSchema,
});

/**
 * The public error body: a discriminated union over `code`, so the details
 * shape is closed by construction — a `details` payload for a code without
 * an approved schema (`unauthorized`, `misdirected-request`,
 * `stale-session`, `concurrent-activation`, `internal-error`) cannot
 * parse, and an approved code's details reject unknown fields.
 */
export const publicErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('malformed-request'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: malformedRequestDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('unsupported-protocol-version'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: unsupportedProtocolVersionDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('payload-too-large'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: payloadTooLargeDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('unauthorized'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
  }),
  z.strictObject({
    code: z.literal('resource-not-found'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: resourceNotFoundDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('misdirected-request'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
  }),
  z.strictObject({
    code: z.literal('stale-session'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
  }),
  z.strictObject({
    code: z.literal('concurrent-activation'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
  }),
  z.strictObject({
    code: z.literal('grant-rejected'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: grantRejectedDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('revision-conflict'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
    details: revisionConflictDetailsSchema.optional(),
  }),
  z.strictObject({
    code: z.literal('internal-error'),
    message: sanitizedTextSchema,
    retryable: z.boolean(),
  }),
]);

/** The HTTP status each code answers with — wire semantics for the future transport. */
export const ERROR_HTTP_STATUS: Record<PublicErrorCode, number> = {
  'malformed-request': 400,
  'unsupported-protocol-version': 400,
  'payload-too-large': 413,
  unauthorized: 403,
  'resource-not-found': 404,
  'misdirected-request': 421,
  'stale-session': 409,
  'concurrent-activation': 409,
  'grant-rejected': 403,
  'revision-conflict': 409,
  'internal-error': 500,
};

export type PublicError = z.infer<typeof publicErrorSchema>;
export type MalformedRequestDetails = z.infer<typeof malformedRequestDetailsSchema>;
export type UnsupportedProtocolVersionDetails = z.infer<
  typeof unsupportedProtocolVersionDetailsSchema
>;
export type PayloadTooLargeDetails = z.infer<typeof payloadTooLargeDetailsSchema>;
export type ResourceNotFoundDetails = z.infer<typeof resourceNotFoundDetailsSchema>;
export type GrantRejectedDetails = z.infer<typeof grantRejectedDetailsSchema>;
export type RevisionConflictDetails = z.infer<typeof revisionConflictDetailsSchema>;
