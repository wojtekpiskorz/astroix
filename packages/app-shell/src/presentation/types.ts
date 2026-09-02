import type { FormFieldNode, ValidationIssueRecord } from '../../../core/src/form-tree';
import type { IndexPayloadRecord } from '../../../core/src/matcher';

/**
 * The presentation prop taxonomy (#219, lane C2, ADR-0002/ADR-0010): the
 * retained product widgets under this folder are prop-driven — data and
 * callbacks in, rendered contract-shaped states out, nothing else. Every
 * prop below is derived from the frozen behavior contracts (B1 inspection,
 * B2 edit; e2e/behavior-contracts/schema) through the pure editing-domain
 * types those schemas freeze — the pin that keeps this derivation honest is
 * `contracts.test.ts`, which asserts the zod-inferred contract shapes and
 * these types are assignable in both directions. `packages/protocol` (D1)
 * later becomes the wire-type home; until then the type-only imports from
 * `packages/core` carry zero runtime coupling.
 *
 * The four prop classes (AC-4, after the contract envelopes):
 *
 * 1. **Inspection data** — contract-shaped, read-only: what the server
 *    served (index records, collection listings, walked schema fields).
 *    The widgets never mutate or fetch these.
 * 2. **Edit intent** — callbacks plus the ranges/hashes they carry: the
 *    widget's user gestures expressed as intent (open this file at these
 *    ranges, this draft changed), the owner (adapter or host) executes.
 * 3. **Revision/conflict results** — the B2 write-outcome vocabulary the
 *    write-status badge renders: `saved` (a 200 landed), `stale` (a 409
 *    accepted the disk truth — the typed edit dropped, the pane reloaded),
 *    `error` (anything else). The widget displays the result; the write
 *    loop that produced it stays with the host.
 * 4. **Presentation-only state** — selection, active entry, collapsed
 *    folders, loading/pending flags: chrome state that changes what
 *    renders, never what the data means.
 */

// --- 1. Inspection data (contract-shaped, read-only) ---

/**
 * One served index-payload record as the presentation renders it — the B1
 * `css-index` contract's record shape (an edit-truth rule joined with its
 * effective selector).
 */
export type RuleRecordView = IndexPayloadRecord;

/** A matched rule positioned in the cascade — the rule list's row model. */
export interface RuleMatchView {
  record: RuleRecordView;
  /** The cascade winner (specificity sort head) — exactly one per list. */
  winner: boolean;
}

/** A collection as the entries tree lists it — the B1 `collections` projection. */
export interface CollectionListingView {
  name: string;
  /** Entry ids in served (code-unit) order — the tree derives folders from them. */
  entryIds: readonly string[];
}

/** The walked schema tree the form renders widgets from (B1 `content-schemas`). */
export type SchemaFieldsView = readonly FormFieldNode[];

// --- 2. Edit intent (callbacks + ranges) ---

/** A place in a file the editor can scroll to and highlight. */
export interface RuleRangeView {
  start: number;
  end: number;
  /** Human-facing chip label (the rule's source line). */
  label: string;
}

/** The rule editor target a rule click assembles: one file, every place it styles the selection. */
export interface RuleFileTargetView {
  file: string;
  ranges: readonly RuleRangeView[];
  /** Which range's chip starts active. */
  activeIndex: number;
}

// --- 3. Revision/conflict results (the B2 write-outcome display vocabulary) ---

// `WriteStatus` (write-status-badge.tsx) is this class's rendered vocabulary:
// 'saved' freezes a B2 200 write cycle, 'stale' the 409 whose disk truth the
// loop accepted (the reload banner), 'error' every failed write. Declared
// beside its badge — the one-component-per-file rule keeps them together.

// --- 4. Presentation-only state ---

/** The entry open in the content editor — selection state, not data. */
export interface ActiveEntryView {
  collection: string;
  entryId: string;
}

/**
 * Inline advisory-validation issues keyed by dotted field path, joined per
 * path — the display form of the B2 `content-validate` issue records. The
 * widget renders them; the validation roundtrip stays with the host.
 */
export type ValidationIssueMap = Record<string, string>;

/** The raw issue records as served — the adapter maps them into the display form. */
export type ValidationIssueSource = readonly ValidationIssueRecord[];
