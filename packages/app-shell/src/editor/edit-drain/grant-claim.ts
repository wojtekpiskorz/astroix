import {
  editOperationKindSchema,
  type ResourceGrant,
  resourceKindSchema,
} from '@wojciechpiskorz/astroix-protocol';

/**
 * The shared edit drain/fence seam's grant-claim binder (ADR-0002
 * amendment 5, born at its second consumer #250/I2 — the verticals'
 * write loops share the mechanics of binding a served grant claim;
 * what stays feature-local is WHICH claims a feature's plans may echo,
 * declared as the rules parameter): one enrichment-served grant record
 * bound field-for-field into the protocol's own `ResourceGrant` shape
 * — the exact claim the wire plan echoes verbatim.
 *
 * The binding law (fail closed, never a heuristic claim): every field
 * is structural, the kind and operations spaces are the PROTOCOL's own
 * closed vocabularies (single-sourced off the schema options, so a
 * protocol enum change is a compile-time event here, never a silent
 * drift), the sha256 baseline is the canonical lowercase 64-hex the
 * wire schema itself pins, and any drift binds `null` — the consumer's
 * read-only truth, never a guess. The server re-validates the whole
 * table at execution anyway (D4's authorize + echo equality); this
 * binding only refuses to plan against a claim it could not prove.
 *
 * The structural primitives (`asRecord`, `nonEmptyString`) are the
 * seam's shared pair — the fact binders that sit beside every
 * grant-claim binding (a file, a raw text, an entry) consume them off
 * the same home.
 */

/** The grant-claim rules one consuming feature declares — its own narrowing, feature-local by law. */
export interface GrantClaimRules {
  /**
   * The one protocol resource kind the feature's plans echo (`'css'`
   * for the splice loop); `null` accepts either kind and leaves the
   * feature's own serializer to refuse a foreign one.
   */
  readonly kind: ResourceGrant['kind'] | null;
  /**
   * Whether the `expected-absent` creation contract binds — a
   * splice-only loop over existing files refuses it.
   */
  readonly expectedAbsent: boolean;
}

/** Narrows one unknown to a plain record — the binders' entry step. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** One nonempty string field — the shared primitive shape of names, ids, codes. */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The protocol's own closed kind vocabulary (single-sourced off the schema). */
const RESOURCE_KINDS = resourceKindSchema.options;

/** The protocol's own closed operation vocabulary (single-sourced off the schema). */
const OPERATION_KINDS = editOperationKindSchema.options;

/** Narrows one string into the protocol's kind vocabulary. */
function isResourceKind(value: string): value is ResourceGrant['kind'] {
  return (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** Narrows one string into the protocol's operation vocabulary. */
function isEditOperation(value: string): value is ResourceGrant['operations'][number] {
  return (OPERATION_KINDS as readonly string[]).includes(value);
}

/** Binds the operations array — a nonempty set inside the protocol's own operation vocabulary. */
function bindOperations(value: unknown): ResourceGrant['operations'] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const operations: ResourceGrant['operations'] = [];
  for (const operation of value) {
    if (typeof operation !== 'string' || !isEditOperation(operation)) return null;
    operations.push(operation);
  }
  return operations;
}

/** Binds the revision contract — the canonical sha256, plus the creation contract when the rules allow it. */
function bindBaseline(value: unknown, rules: GrantClaimRules): ResourceGrant['baseline'] | null {
  const baseline = asRecord(value);
  if (baseline === null) return null;
  if (baseline.type === 'sha256') {
    const sha256 = nonEmptyString(baseline.sha256);
    // the wire schema's own canonical shape (the frozen contracts'
    // sha256 species) — never a heuristic digest acceptance
    if (sha256 === null || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    return { type: 'sha256', sha256 };
  }
  if (baseline.type === 'expected-absent' && rules.expectedAbsent) {
    return { type: 'expected-absent' };
  }
  return null;
}

/**
 * Binds one served grant claim field-for-field into the protocol's
 * `ResourceGrant` — `null` on any drift (fail closed): a missing or
 * empty token/kind/display path, an enum-foreign kind or operation, an
 * empty operations set, or a baseline that is neither the canonical
 * 64-hex sha256 contract nor (when the rules accept it) the
 * expected-absent creation contract.
 */
export function bindGrantClaim(
  grantRecord: Record<string, unknown>,
  rules: GrantClaimRules,
): ResourceGrant | null {
  const token = nonEmptyString(grantRecord.token);
  const kind = nonEmptyString(grantRecord.kind);
  const displayPath = nonEmptyString(grantRecord.displayPath);
  if (token === null || kind === null || displayPath === null) return null;
  if (!isResourceKind(kind)) return null;
  if (rules.kind !== null && kind !== rules.kind) return null;
  const operations = bindOperations(grantRecord.operations);
  if (operations === null) return null;
  const baseline = bindBaseline(grantRecord.baseline, rules);
  if (baseline === null) return null;
  return { token, kind, operations, displayPath, baseline };
}
