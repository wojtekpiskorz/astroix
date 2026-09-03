import { projectKeySchema } from '@wojciechpiskorz/astroix-protocol';
import { z } from 'zod';

/**
 * The tombstone document (#239, F7; ADR-0006 §4 step 4 and §8): the
 * strictly versioned JSON record one incomplete forced reap persists —
 * the durable fact that cleanup of a session's write executor was never
 * observed inside the two-second forced-reap bound, and therefore that
 * no new session authority may be granted on the same machine boot
 * until exclusive edit-writer-lease acquisition proves no live executor
 * remains. The registry document (D2, #221) is the persistence model
 * this mirrors: one schema version, strict shape, corrupt or
 * unsupported-future bytes classify — never guess — and the write
 * discipline (temp + fsync + atomic rename + directory fsync, 0700/0600)
 * lives in the sibling store.
 *
 * The two laws this record's shape carries:
 *
 * - **The persisted PID is recorded evidence, never cleanup authority**
 *   (§8, the AC's law): `recordedPid` is diagnostic data for a human
 *   reading private state — nothing in this module, the machine, or the
 *   store ever reads it to decide anything, and no clearing path
 *   consults process liveness. Clearing is structural only: a boot-scope
 *   token that cannot match (a later machine boot), or the exclusive
 *   edit-writer-lease acquisition proof (the same boot). A persisted PID
 *   is explicitly NOT a kill target (the D3 ruling: "a persisted PID or
 *   ownership record is diagnostic data at most — never live ownership,
 *   never a kill target").
 * - **Honest about observed and unobserved shapes** (#326's context):
 *   the close report a record may carry is the plane supervisor's own
 *   sanitized accounting — its `workerReaped`/`managedAstroReaped`
 *   booleans are honest whichever way they read within the stated
 *   bounds, and `closeReport: null` records that no report had arrived
 *   at persist time. The record never upgrades an unobserved reap into
 *   an observed one and never invents accounting.
 *
 * Pure module: schema + classification only, no IO.
 */

/** The one schema version this layer reads and writes (migration-free v1). */
export const TOMBSTONE_SCHEMA_VERSION = 1;

/**
 * The plane supervisor's close report as the tombstone persists it — a
 * structural mirror of `SupervisionCloseReport`
 * (`project-plane/supervision/close-report.ts`, E7 read-only): sanitized
 * categories and accounting booleans only, never a PID. A drift between
 * this mirror and E7's unions classifies a stored document as corrupt —
 * fail-closed blocking, never a guess.
 */
const supervisionChildSchema = z.enum(['worker', 'managed-astro']);

const supervisionCleanupCategorySchema = z.enum([
  'worker-close-report',
  'worker-cleanup-incomplete',
  'worker-reap',
  'managed-astro-reap',
  'probe-abort',
]);

const supervisionStopReasonSchema = z.enum([
  'stopped',
  'cancelled',
  'startup-timeout',
  'worker-crash',
  'managed-astro-crash',
]);

export const supervisionCloseReportMirrorSchema = z.strictObject({
  reason: supervisionStopReasonSchema,
  outcome: z.enum(['complete', 'incomplete']),
  failures: z.array(supervisionCleanupCategorySchema),
  accounting: z.strictObject({
    workerReportReceived: z.boolean(),
    workerCleanupComplete: z.boolean(),
    workerReaped: z.boolean(),
    managedAstroReaped: z.boolean(),
    probesSettled: z.boolean(),
    killEscalations: z.array(supervisionChildSchema),
  }),
});

/** The mirrored close report's inferred shape — structurally `SupervisionCloseReport`. */
export type MirroredCloseReport = z.infer<typeof supervisionCloseReportMirrorSchema>;

/** One persisted tombstone — everything the blocking decision and a human diagnostician need. */
export const tombstoneRecordSchema = z.strictObject({
  /**
   * The machine-boot identity token the host injected when this record
   * was written. Comparison against the live boot's token is the WHOLE
   * staleness discipline: a token that cannot match means a later
   * machine boot, and the record is stale by construction — clearing is
   * structural, never time-based.
   */
  bootScope: z.string().min(1),
  /** The project whose transition failed cleanup — diagnostic routing only. */
  projectKey: projectKeySchema,
  /**
   * The executor's PID as recorded evidence. NEVER cleanup authority:
   * no decision reads it (the D3 ruling's law, pinned by the focused
   * tests — a matching live PID authorizes nothing).
   */
  recordedPid: z.number().int().nullable(),
  /**
   * The supervisor's reap accounting as observed at persist time, or
   * `null` when no close report had arrived — honest about both shapes
   * (#326's context).
   */
  closeReport: supervisionCloseReportMirrorSchema.nullable(),
});

export type TombstoneRecord = z.infer<typeof tombstoneRecordSchema>;

export const tombstoneDocumentSchema = z.strictObject({
  schemaVersion: z.literal(TOMBSTONE_SCHEMA_VERSION),
  tombstone: tombstoneRecordSchema,
});

export type TombstoneDocument = z.infer<typeof tombstoneDocumentSchema>;

/** Why persisted bytes could not become a record. */
export type TombstoneUnusableReason = 'corrupt' | 'unsupported-future';

/** What a tombstone file's bytes are: one usable record, or the unusable classification. */
export type TombstoneClassification =
  | { readonly status: 'ok'; readonly document: TombstoneDocument }
  | { readonly status: 'unusable'; readonly reason: TombstoneUnusableReason };

/**
 * The first read of a tombstone file's bytes — never throws: every
 * unusable byte sequence classifies. Unparseable JSON, a missing or
 * non-numeric version, a version below the only one that ever existed,
 * or any schema failure is `corrupt`; a numeric `schemaVersion` above
 * the recognized one is `unsupported-future` (a newer Astroix wrote it
 * — the blocking semantics stay fail-closed until an explicit upgrade,
 * never a downgrade guess).
 */
export function classifyTombstoneDocument(text: string): TombstoneClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'unusable', reason: 'corrupt' };
  }
  if (!isPlainObject(parsed)) return { status: 'unusable', reason: 'corrupt' };
  const version = parsed.schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version)) {
    if (version > TOMBSTONE_SCHEMA_VERSION) {
      return { status: 'unusable', reason: 'unsupported-future' };
    }
    if (version < TOMBSTONE_SCHEMA_VERSION) {
      // A version below the only one that ever existed was never written
      // by any Astroix — corruption, not a migration case.
      return { status: 'unusable', reason: 'corrupt' };
    }
  } else {
    return { status: 'unusable', reason: 'corrupt' };
  }
  const result = tombstoneDocumentSchema.safeParse(parsed);
  return result.success
    ? { status: 'ok', document: result.data }
    : { status: 'unusable', reason: 'corrupt' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
