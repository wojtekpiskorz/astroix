import type { ResourceGrant, WritePlan } from '@wojciechpiskorz/astroix-protocol';
import { parseEntryDraft, serializeEntry } from '../../../../../core/src/entry-writer.ts';
import { collectImagePaths, type FormFieldNode } from '../../../../../core/src/form-tree.ts';
import type { EntryWriteFacts } from '../api.ts';
import type { ContentEditIntent } from '../forms/edit-intent.ts';

/**
 * The Content write loop's serializer (#253, J3; CONTEXT.md "raw truth":
 * writes are byte-surgical against the file's bytes): the validated edit
 * intent lifted onto the wire write plan — `replace-contents` for an
 * existing entry file, `create-contents` for an expected-absent creation
 * slot — with the payload bytes produced by the PURE core entry-writer
 * over the inspected raw baseline, exactly the function the frozen edit
 * contracts were derived through (`e2e/behavior-contracts/edit/`: the
 * derived side is "the posted contents computed by the pure packages/core
 * entry-writer over the observed baseline").
 *
 * The laws this module owns:
 *
 * - **The grant is opaque and verbatim** — the plan echoes the issued
 *   grant field for field; nothing here reads a path, mints a token, or
 *   accepts a client-selected resource (the server re-validates the
 *   whole table at execution, D4).
 * - **The baseline is required** — an existing-text write refuses a
 *   null-revision intent (a file-less entry has no bytes to splice), and
 *   the echoed grant's SHA-256 must equal the intent's inspected
 *   revision: a grant issued for another revision is a stale claim, not
 *   authority to write this one.
 * - **Byte-exactness is structural** — `serializeEntry` receives the
 *   entry's RAW text as its anchor (comments, quoting, and flow styles
 *   of untouched nodes survive by construction) and the image-kind
 *   paths as the never-touch list (zod's ImageMetadata objects must
 *   never serialize over the file's own path strings).
 */

/** The serializer's refusal vocabulary — client-side, sanitized, before any dispatch. */
export type SerializeRefusal =
  | 'no-baseline'
  | 'stale-grant'
  | 'wrong-kind'
  | 'operation-not-offered';

/** One serialization outcome — the plan, or the sanitized refusal. */
export type SerializeResult =
  | { readonly ok: true; readonly plan: WritePlan }
  | { readonly ok: false; readonly code: SerializeRefusal };

/**
 * Builds the wire write plan for one validated edit intent. `raw` is the
 * entry file's inspected text (the write facts' byte anchor); `fields`
 * the walked tree (the image paths' source). The intent's `values` are
 * the whole draft document — untouched baseline values included, the
 * draft store's merge law — and its `body` rides along verbatim.
 */
export function buildEntryWritePlan(input: {
  readonly facts: EntryWriteFacts;
  readonly intent: ContentEditIntent;
  readonly fields: readonly FormFieldNode[];
}): SerializeResult {
  const { facts, intent } = input;
  if (facts.grant.kind !== 'content') return { ok: false, code: 'wrong-kind' };
  if (facts.grant.baseline.type === 'sha256') {
    // The existing-text law: the intent must carry the inspected revision
    // the grant binds — one freshness fact, two sides, no splitting it.
    if (intent.revision === null) return { ok: false, code: 'no-baseline' };
    if (facts.grant.baseline.sha256 !== intent.revision) {
      return { ok: false, code: 'stale-grant' };
    }
    if (!facts.grant.operations.includes('replace-contents')) {
      return { ok: false, code: 'operation-not-offered' };
    }
    const baseline = parseEntryDraft(facts.raw);
    // An unparseable raw baseline (a hand-broken file under the draft)
    // refuses the write: serializeEntry would throw, and the honest
    // client answer is the refusal, never a blind overwrite.
    if (baseline === null) return { ok: false, code: 'no-baseline' };
    return {
      ok: true,
      plan: {
        operation: 'replace-contents',
        grant: toWireGrant(facts),
        contents: serializeEntry({
          raw: facts.raw,
          baseline,
          draft: { data: intent.values, body: intent.baseline.body ?? '' },
          protectedPaths: collectImagePaths(input.fields),
        }),
      },
    };
  }
  // The expected-absent creation slot: the intent's entry names the file
  // segment; there is no raw anchor (nothing exists to anchor against)
  // and the whole document serializes from the draft alone.
  if (!facts.grant.operations.includes('create-contents')) {
    return { ok: false, code: 'operation-not-offered' };
  }
  return {
    ok: true,
    plan: {
      operation: 'create-contents',
      grant: toWireGrant(facts),
      contents: serializeEntry({
        raw: '',
        baseline: { data: {}, body: '' },
        draft: { data: intent.values, body: intent.baseline.body ?? '' },
        protectedPaths: collectImagePaths(input.fields),
      }),
    },
  };
}

/** The wire grant — the bound facts echoed verbatim, in the contract's field order. */
function toWireGrant(facts: EntryWriteFacts): ResourceGrant {
  return {
    token: facts.grant.token,
    kind: 'content',
    operations: [...facts.grant.operations] as ResourceGrant['operations'],
    displayPath: facts.grant.displayPath,
    baseline: facts.grant.baseline,
  };
}
