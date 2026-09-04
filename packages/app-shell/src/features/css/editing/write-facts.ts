import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';

/**
 * The CSS vertical's write facts (#250, I2 — J3's per-entry content
 * discipline applied per FILE): the styles payload's additive
 * enrichment, one fact per file the converged records name — the
 * server-issued opaque css grant (issued over the bytes this
 * composition's own discovery read — ADR-0006 §6) plus the file's raw
 * text, the splice planner's byte anchor. Binding is structural and
 * fail-closed per fact: a drifted fact drops THAT file's write truth
 * (the read payload survives — the panel is read-only truth, the fact
 * is write truth), and a payload without any facts is simply
 * un-enriched (an inspection the write composition could not prove —
 * read-only, never a heuristic grant).
 *
 * The wire law pinned here: the grant's kind is `css`, its operations
 * carry the splice species, and its display path is the UI-only
 * project-relative form — the browser never sees, submits, or selects
 * an absolute or project-relative AUTHORITY path; the grant token is
 * the only authority, and it is opaque.
 */

/** One file's bound write facts — the grant plus the byte anchor. */
export interface CssWriteFact {
  /** The file the fact authorizes — the record's own sanitized project-relative path. */
  readonly file: string;
  /** The opaque grant claim, echoed verbatim on every write plan for this file. */
  readonly grant: ResourceGrant;
  /** The file's raw text as the enrichment read it — every splice range is an index into it. */
  readonly raw: string;
}

/** Narrows one unknown to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** One nonempty string field. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Binds the grant claim field-for-field — `null` on any drift (J3's `EntryWriteFacts` discipline). */
function bindGrantClaim(grantRecord: Record<string, unknown>): ResourceGrant | null {
  const token = nonEmptyString(grantRecord.token);
  const kind = nonEmptyString(grantRecord.kind);
  const displayPath = nonEmptyString(grantRecord.displayPath);
  if (token === null || kind === null || displayPath === null) return null;
  if (kind !== 'css') return null;
  if (!Array.isArray(grantRecord.operations)) return null;
  const operations: string[] = [];
  for (const operation of grantRecord.operations) {
    if (typeof operation !== 'string') return null;
    operations.push(operation);
  }
  if (operations.length === 0) return null;
  const baseline = asRecord(grantRecord.baseline);
  if (baseline === null) return null;
  if (baseline.type !== 'sha256') return null;
  const sha256 = nonEmptyString(baseline.sha256);
  if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return {
    token,
    kind: 'css',
    operations: operations as ResourceGrant['operations'],
    displayPath,
    baseline: { type: 'sha256', sha256 },
  };
}

/** Binds one fact — every field structural, `null` on any drift. */
function bindFact(value: unknown): CssWriteFact | null {
  const record = asRecord(value);
  if (record === null) return null;
  const file = nonEmptyString(record.file);
  if (file === null) return null;
  const grantRecord = asRecord(record.grant);
  if (grantRecord === null) return null;
  const grant = bindGrantClaim(grantRecord);
  if (grant === null) return null;
  if (typeof record.raw !== 'string') return null;
  return { file, grant, raw: record.raw };
}

/**
 * Binds the payload's additive `writeFacts` field onto the per-file
 * lookup the write loop consumes: the latest fact per file wins (the
 * enrichment issues one per file — a duplicate is a wire defect the
 * last-wins rule tolerates without drift), absent facts are simply not
 * present, and a drifted fact drops its file alone.
 */
export function bindCssWriteFacts(payload: unknown): ReadonlyMap<string, CssWriteFact> {
  const record = asRecord(payload);
  const facts = new Map<string, CssWriteFact>();
  if (record === null || !Array.isArray(record.writeFacts)) return facts;
  for (const candidate of record.writeFacts) {
    const bound = bindFact(candidate);
    if (bound !== null) facts.set(bound.file, bound);
  }
  return facts;
}
