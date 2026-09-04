import type { ResourceGrant } from '@wojciechpiskorz/astroix-protocol';
import {
  asRecord,
  bindGrantClaim,
  nonEmptyString,
} from '../../../editor/edit-drain/grant-claim.ts';

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
 * The wire law pinned here: the grant's kind is `css`, its splice
 * species carries no creation contract (the sha256 baseline alone —
 * `CSS_GRANT_RULES`, the shared seam binder's declared narrowing), and
 * its display path is the UI-only project-relative form — the browser
 * never sees, submits, or selects an absolute or project-relative
 * AUTHORITY path; the grant token is the only authority, and it is
 * opaque.
 */

/** The feature's grant-claim narrowing — the css kind, the splice species' existing-text contract alone. */
const CSS_GRANT_RULES = { kind: 'css', expectedAbsent: false } as const;

/** One file's bound write facts — the grant plus the byte anchor. */
export interface CssWriteFact {
  /** The file the fact authorizes — the record's own sanitized project-relative path. */
  readonly file: string;
  /** The opaque grant claim, echoed verbatim on every write plan for this file. */
  readonly grant: ResourceGrant;
  /** The file's raw text as the enrichment read it — every splice range is an index into it. */
  readonly raw: string;
}

/** Binds one fact — every field structural, `null` on any drift. */
function bindFact(value: unknown): CssWriteFact | null {
  const record = asRecord(value);
  if (record === null) return null;
  const file = nonEmptyString(record.file);
  if (file === null) return null;
  const grantRecord = asRecord(record.grant);
  if (grantRecord === null) return null;
  const grant = bindGrantClaim(grantRecord, CSS_GRANT_RULES);
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
