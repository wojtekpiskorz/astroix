import type { SessionRef } from '@wojciechpiskorz/astroix-protocol';
import { create } from 'zustand';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { parseRawText, toRawText } from '../raw/raw-text.ts';
import { mergeValues, partitionValues } from '../raw/value-partition.ts';

/**
 * The Content vertical's form-draft store (#252, J2): the feature-local
 * zustand slice holding ONE entry's draft document — the mode, the
 * draft values (the whole), the form's known half, the unclaimed
 * unknown half, the raw text, and the standing parse failure — beside
 * the binding and baseline it is scoped to.
 *
 * The reset law (the AC's own list): the draft and its validation reset
 * whenever ProjectKey, runtime epoch, generation, collection, OR entry
 * changes. The binding carries the pair + collection + entryId; a
 * ProjectKey change is a different document and therefore a different
 * pair (the pair IS the project binding at the document, per J1's
 * query-key ruling), so the one binding check covers the whole list.
 * The #372 ruling (feature stores outside the commit-time reset
 * registry) is OPEN: this store follows J1's precedent — feature-local,
 * document-replacement lifetime — and additionally self-gates through
 * the binding check, so a NEW document's first open resets any stale
 * draft before anything renders from it.
 *
 * The values discipline (CONTEXT.md "raw truth"): the draft values are
 * the editing truth-space. The form reports its KNOWN half (it mounts
 * on the partitioned known half); the unknown half is re-derived from
 * the standing whole at every report and merged back — unknown fields
 * never leave the draft, and no report order can clobber them (the
 * property tests pin the law). Raw-mode reports replace the whole; a
 * parse failure keeps the last parsed values and records the
 * diagnostic (the no-drop law: broken text never destroys values).
 */

/** The editing mode — schema-backed widgets, or the explicit raw representation. */
export type FormDraftMode = 'form' | 'raw';

/** What a draft is bound to — the pair plus the entry identity. */
export interface DraftBinding {
  readonly runtimeEpoch: string;
  readonly generation: number;
  readonly collection: string;
  readonly entryId: string;
}

/** The inspected baseline the draft began from. */
export interface DraftBaseline {
  /** The entry's inspected SHA-256 revision (null for a file-less entry). */
  readonly revision: string | null;
  /** The inspected values the draft started from. */
  readonly values: unknown;
  /** The entry's inspected body — carried untouched; not an editing surface in J2. */
  readonly body: string | null;
}

/** The same binding again — value equality, the whole reset law's trigger. */
export function sameDraftBinding(a: DraftBinding | null, b: DraftBinding | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.runtimeEpoch === b.runtimeEpoch &&
    a.generation === b.generation &&
    a.collection === b.collection &&
    a.entryId === b.entryId
  );
}

interface FormDraftState {
  /** The binding this draft belongs to; null when no entry is drafted. */
  readonly binding: DraftBinding | null;
  readonly baseline: DraftBaseline | null;
  /** The walked field tree the draft edits under (set at open; the merge seam's law). */
  readonly fields: readonly FormFieldNode[];
  readonly mode: FormDraftMode;
  /**
   * The form mount identity — bumped on open and on every return from
   * raw mode, so the retained form remounts on the current values (the
   * #149 remount discipline; values never re-flow into a mounted form).
   */
  readonly mountId: number;
  /** The form's half — the last reported known values (the widgets' editing space). */
  readonly knownValues: unknown;
  /** The unclaimed half — the explicit raw representation's values. */
  readonly unknownPart: Record<string, unknown>;
  /** The whole draft values — the editing truth-space. */
  readonly draftValues: unknown;
  /** The raw pane's live text — materialized from the values on every raw entry. */
  readonly rawText: string | null;
  /** The standing parse failure of the raw text, or null while it parses. */
  readonly parseError: string | null;
  /**
   * Opens the entry's draft. The total reset law: a changed binding
   * resets everything; the SAME binding is a no-op — a background
   * refetch never clobbers a live draft (the stale-baseline diagnostic
   * is the honest report for a moved revision).
   */
  open(
    actor: SessionRef,
    binding: DraftBinding,
    baseline: DraftBaseline,
    fields: readonly FormFieldNode[],
  ): void;
  setMode(mode: FormDraftMode): void;
  /** The form's values report (the known half) — the unknown half re-derived and merged. */
  reportFormValues(values: unknown): void;
  /** The unknown-fields section's report (the parsed unclaimed half). */
  reportUnknownPart(part: Record<string, unknown>): void;
  /** The raw pane's text report — parsed values on success, the diagnostic on failure. */
  reportRawText(text: string): void;
  /** Clears the draft entirely (tests; the future reset registry — the #372 carry). */
  clear(): void;
}

export const useFormDraftStore = create<FormDraftState>((set, get) => ({
  binding: null,
  baseline: null,
  fields: [],
  mode: 'form',
  mountId: 0,
  knownValues: undefined,
  unknownPart: {},
  draftValues: undefined,
  rawText: null,
  parseError: null,
  open: (actor, binding, baseline, fields) => {
    const current = get();
    // Currency: the opener must speak for the pair the draft binds to —
    // a mismatched actor is a stale render's report, never an open.
    if (actor.runtimeEpoch !== binding.runtimeEpoch || actor.generation !== binding.generation) {
      return;
    }
    if (sameDraftBinding(current.binding, binding)) return;
    const { known, unknown } = partitionValues(fields, baseline.values);
    set({
      binding,
      baseline,
      fields,
      mode: 'form',
      mountId: current.mountId + 1,
      knownValues: known,
      unknownPart: unknown,
      draftValues: baseline.values,
      rawText: null,
      parseError: null,
    });
  },
  setMode: (mode) =>
    set((state) => {
      if (state.mode === mode || state.binding === null) return state;
      if (mode === 'raw') {
        // Entering raw materializes the text from the current values —
        // deterministic, never a stale text cache (every parsed edit
        // already lives in the values; an unparsed tail was never a value).
        return { mode, rawText: toRawText(state.draftValues), parseError: null };
      }
      // Returning to form remounts the form on the current values; the
      // mount report re-derives the halves.
      return { mode, rawText: null, parseError: null, mountId: state.mountId + 1 };
    }),
  reportFormValues: (values) =>
    set((state) => {
      if (state.binding === null) return state;
      // The unknown half is re-derived from the STANDING whole — the
      // report order can never clobber unclaimed keys (a mount report
      // after raw-mode edits picks up the raw edit's unknown keys).
      const unknown = partitionValues(state.fields, state.draftValues).unknown;
      return {
        knownValues: values,
        unknownPart: unknown,
        draftValues: mergeValues(values, unknown),
      };
    }),
  reportUnknownPart: (part) =>
    set((state) => {
      if (state.binding === null) return state;
      return { unknownPart: part, draftValues: mergeValues(state.knownValues, part) };
    }),
  reportRawText: (text) =>
    set((state) => {
      if (state.binding === null || state.mode !== 'raw') return state;
      const parsed = parseRawText(text);
      return parsed.ok
        ? { rawText: text, parseError: null, draftValues: parsed.values }
        : { rawText: text, parseError: parsed.message };
    }),
  clear: () =>
    set({
      binding: null,
      baseline: null,
      fields: [],
      mode: 'form',
      knownValues: undefined,
      unknownPart: {},
      draftValues: undefined,
      rawText: null,
      parseError: null,
    }),
}));
