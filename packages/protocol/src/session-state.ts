import { z } from 'zod';
import { projectKeySchema } from './registry';
import { sanitizedTextSchema } from './sanitization';
import { sessionRefSchema } from './session';

/**
 * The session snapshot (ADR-0006 §4 "Session state and activation
 * transaction"): the source of truth is the snapshot, not a flat enum —
 * the launcher may derive the familiar labels, and `sessionLabel` below
 * is that canonical derivation.
 *
 * ```ts
 * type SessionSnapshot = {
 *   active?: ActiveSessionSnapshot;      // ready or stopping
 *   attempt?: ActivationAttemptSnapshot; // starting or committing
 *   lastFailure?: SessionFailure;
 * };
 * ```
 */

/**
 * Sanitized failure categories, each a path ADR-0006 §4/§8 or ADR-0005
 * names: candidate startup failure, the 30 s startup deadline, an
 * uncertified Astro/Vite pair (ADR-0005 compatibility contract), a drain
 * conflict or drain timeout, an incomplete forced reap (the tombstone
 * path), a post-revocation commit failure (irreversible), or a plane
 * crash. `unknown` keeps the set honest when a new path appears without
 * a ruling yet. A close report's cleanup-failure categories are the
 * runtime's own sanitized vocabulary (ADR-0006 §8), reported alongside —
 * never inside — this snapshot.
 */
export const sessionFailureCategorySchema = z.enum([
  'startup',
  'startup-timeout',
  'certification',
  'drain-conflict',
  'drain-timeout',
  'incomplete-reap',
  'revocation',
  'crash',
  'unknown',
]);

/** A sanitized failure: category + human-facing summary. No PIDs, paths, or stacks. */
export const sessionFailureSchema = z.strictObject({
  category: sessionFailureCategorySchema,
  message: sanitizedTextSchema,
});

/** The one committed, authority-bearing run: ready, or stopping (authority revoked). */
export const activeSessionSnapshotSchema = z.strictObject({
  ref: sessionRefSchema,
  projectKey: projectKeySchema,
  state: z.enum(['ready', 'stopping']),
});

/** The staged transaction that may commit a candidate or roll it back. */
export const activationAttemptSnapshotSchema = z.strictObject({
  ref: sessionRefSchema,
  projectKey: projectKeySchema,
  state: z.enum(['starting', 'committing']),
});

export const sessionSnapshotSchema = z.strictObject({
  active: activeSessionSnapshotSchema.optional(),
  attempt: activationAttemptSnapshotSchema.optional(),
  lastFailure: sessionFailureSchema.optional(),
});

/** The launcher's familiar labels, derived from the snapshot (ADR-0006 §4). */
export const SESSION_LABELS = ['idle', 'starting', 'ready', 'stopping', 'failed'] as const;
export type SessionLabel = (typeof SESSION_LABELS)[number];

/**
 * The canonical label derivation (ADR-0006 §4): an active session wins —
 * a staged-candidate failure while an old project is ready is a
 * notification, not the global state; an attempt reads as `starting`
 * (candidate startup and commit are both "not yet authoritative");
 * `failed` means no active authority remains *and* the latest attempt
 * failed; otherwise `idle`.
 */
export function sessionLabel(snapshot: SessionSnapshot): SessionLabel {
  if (snapshot.active !== undefined)
    return snapshot.active.state === 'stopping' ? 'stopping' : 'ready';
  if (snapshot.attempt !== undefined) return 'starting';
  if (snapshot.lastFailure !== undefined) return 'failed';
  return 'idle';
}

export type SessionFailure = z.infer<typeof sessionFailureSchema>;
export type ActiveSessionSnapshot = z.infer<typeof activeSessionSnapshotSchema>;
export type ActivationAttemptSnapshot = z.infer<typeof activationAttemptSnapshotSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
