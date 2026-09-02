import { z } from 'zod';
import { LIMITS } from './limits';

/**
 * Registry wire records (ADR-0006 §1 "Registered-project identity and
 * routing"): browser-visible summaries contain **only** project key,
 * display name, and sanitized availability — absolute roots and process
 * details stay in the control plane and can never parse here (the schema
 * is strict; a `root`, `path`, or `pid` field is an unknown field and is
 * rejected).
 */

/** 128 bits of entropy render as ceil(128 / 5) = 26 lowercase Base32 chars. */
export const PROJECT_KEY_LENGTH = Math.ceil(LIMITS.projectKeyBits / 5);

/**
 * The ProjectKey shape: a random 128-bit value as 26 lowercase Base32
 * (RFC 4648, lowercased: `a–z`, `2–7`) DNS-safe chars — a routing key
 * allocated at record creation, stable only for that record's lifetime,
 * never project identity and never authority (ADR-0006 §1).
 */
export const projectKeySchema = z
  .string()
  .length(PROJECT_KEY_LENGTH)
  .regex(/^[a-z2-7]+$/, 'project key must be lowercase base32 (a-z, 2-7)');

/**
 * Sanitized availability (ADR-0006 §1): a stale or temporarily unavailable
 * root stays visible until explicit removal — the summary says *whether*,
 * never *why* (no paths, no errno, no process detail).
 */
export const projectAvailabilitySchema = z.enum(['available', 'unavailable']);

/**
 * One registered project as the browser may see it. The display name is
 * separate from identity and routing (defaults to the canonical root's
 * basename; editable from the native launcher).
 */
export const projectSummarySchema = z.strictObject({
  projectKey: projectKeySchema,
  displayName: z.string().min(1),
  availability: projectAvailabilitySchema,
});

export type ProjectKey = z.infer<typeof projectKeySchema>;
export type ProjectAvailability = z.infer<typeof projectAvailabilitySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
