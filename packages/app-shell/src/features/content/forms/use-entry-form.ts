import { useEffect } from 'react';
import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { useShell } from '../../../app-shell/shell-context.ts';
import { useSessionQuery } from '../../../app-shell/use-session-query.ts';
import type { ActiveEntryView } from '../../../presentation/types.ts';
import { useContentNavigationStore } from '../navigation/navigation-store.ts';
import { toRawText } from '../raw/raw-text.ts';
import { partitionValues } from '../raw/value-partition.ts';
import type { DraftIssue, DraftValidation } from '../validation/validate-draft.ts';
import { validateDraft } from '../validation/validate-draft.ts';
import {
  type ContentEditIntent,
  type IntentState,
  intentStateOf,
  toEditIntent,
} from './edit-intent.ts';
import { bindEntryTruth, type EntryTruth } from './entry-truth.ts';
import { type DraftBinding, type FormDraftMode, useFormDraftStore } from './form-draft-store.ts';

/**
 * The form slice's composition hook (#252, J2): one subscription (the
 * E4 content inspection under the shell's generation-scoped query
 * discipline — the SAME key the discovery query rides, so one fetch
 * serves both and the SSE invalidation bridge refetches both), one
 * bind (the active entry's truth, fail-closed), one draft lifecycle
 * (open on entry, reset on binding change), and the pure derivations
 * (partition, validation, intent) the pane renders.
 *
 * Read-only by charter: the only exchange this hook ever dispatches is
 * the `inspect` — J2 produces validated edit intent as feature state;
 * the write lane (J3) is where intent becomes a command.
 */

/** The pane's structured state vocabulary — the AC's own surfaces. */
export type EntryFormStatus = 'no-entry' | 'loading' | 'absent' | 'drift' | 'ready';

/** One sanitized diagnostic message for the refused/drifted states. */
function diagnosticMessageOf(error: unknown): string {
  if (error instanceof Error && error.name === 'StaleSessionResultError') {
    return 'the session moved before the response arrived';
  }
  const envelope = (error as { envelope?: { error?: { code?: string } } } | undefined)?.envelope;
  if (typeof envelope?.error?.code === 'string')
    return `inspection refused: ${envelope.error.code}`;
  return 'inspection could not be completed';
}

/** The pane's view model — everything the component renders, nothing it owns. */
export interface EntryFormView {
  readonly status: EntryFormStatus;
  /** The refused/drifted states' sanitized reason; null elsewhere. */
  readonly diagnosticMessage: string | null;
  readonly activeEntry: ActiveEntryView | null;
  readonly mode: FormDraftMode;
  readonly mountId: number;
  /** The walked tree — the widgets' truth (ready state only). */
  readonly fields: readonly FormFieldNode[];
  /** The whole draft values — the editing truth-space. */
  readonly values: unknown;
  /** The known half — the retained form's mount values. */
  readonly knownValues: unknown;
  /** The unclaimed half — the explicit raw representation's values. */
  readonly unknownPart: Record<string, unknown>;
  /** The raw pane's live text (raw mode; materialized from values on entry). */
  readonly rawText: string;
  readonly inlineIssues: Record<string, string>;
  readonly documentIssues: readonly DraftIssue[];
  readonly parseError: string | null;
  /** The project's own zod verdict on the entry's raw truth, as inspected. */
  readonly inspectedIssues: EntryTruth['inspectedIssues'];
  readonly intentState: IntentState;
  readonly intent: ContentEditIntent | null;
  readonly baselineRevision: string | null;
  readonly body: string | null;
  setMode(mode: FormDraftMode): void;
  reportFormValues(values: unknown): void;
  reportUnknownPart(part: Record<string, unknown>): void;
  reportRawText(text: string): void;
}

/** The pane's action wiring — the store's actions, stable across state changes. */
interface DraftActions {
  readonly setMode: EntryFormView['setMode'];
  readonly reportFormValues: EntryFormView['reportFormValues'];
  readonly reportUnknownPart: EntryFormView['reportUnknownPart'];
  readonly reportRawText: EntryFormView['reportRawText'];
}

const NO_ENTRY_VIEW: EntryFormView = {
  status: 'no-entry',
  diagnosticMessage: null,
  activeEntry: null,
  mode: 'form',
  mountId: 0,
  fields: [],
  values: undefined,
  knownValues: undefined,
  unknownPart: {},
  rawText: '',
  inlineIssues: {},
  documentIssues: [],
  parseError: null,
  inspectedIssues: null,
  intentState: 'none',
  intent: null,
  baselineRevision: null,
  body: null,
  setMode: () => {},
  reportFormValues: () => {},
  reportUnknownPart: () => {},
  reportRawText: () => {},
};

/**
 * Derives the view over one bound truth and the live draft state. The
 * baseline is the draft's own mount truth (a same-binding no-op keeps
 * it); the LIVE revision is the current inspection's — the gap between
 * them is the stale-baseline diagnostic's truth.
 */
function draftView(
  truth: EntryTruth,
  draft: ReturnType<typeof useFormDraftStore.getState>,
  actions: DraftActions,
): EntryFormView {
  const baseline = draft.baseline;
  const values = draft.draftValues;
  const validation: DraftValidation = validateDraft({
    fields: truth.fields,
    values,
    parseError: draft.parseError,
    baselineRevision: baseline?.revision ?? null,
    liveRevision: truth.revision,
  });
  const derivation =
    baseline !== null && draft.binding !== null
      ? { binding: draft.binding, baseline, values, validation }
      : null;
  return {
    status: 'ready',
    diagnosticMessage: null,
    activeEntry: { collection: truth.collection, entryId: truth.entryId },
    mode: draft.mode,
    mountId: draft.mountId,
    fields: truth.fields,
    values,
    knownValues: partitionValues(truth.fields, values).known,
    unknownPart: draft.unknownPart,
    rawText: draft.rawText ?? toRawText(values),
    inlineIssues: validation.inline,
    documentIssues: validation.issues.filter((issue) => issue.path === ''),
    parseError: draft.parseError,
    inspectedIssues: truth.inspectedIssues,
    intentState: derivation === null ? 'none' : intentStateOf(derivation),
    intent: derivation === null ? null : toEditIntent(derivation),
    baselineRevision: baseline?.revision ?? null,
    body: baseline?.body ?? truth.body,
    ...actions,
  };
}

/** The pre-open render: the untouched truth as its own first view (the effect opens the draft next tick). */
function truthView(
  truth: EntryTruth,
  activeEntry: ActiveEntryView,
  actions: DraftActions,
): EntryFormView {
  const validation = validateDraft({
    fields: truth.fields,
    values: truth.values,
    parseError: null,
    baselineRevision: truth.revision,
    liveRevision: truth.revision,
  });
  const partition = partitionValues(truth.fields, truth.values);
  return {
    ...NO_ENTRY_VIEW,
    status: 'ready',
    activeEntry,
    fields: truth.fields,
    values: truth.values,
    knownValues: partition.known,
    unknownPart: partition.unknown,
    inlineIssues: validation.inline,
    documentIssues: validation.issues.filter((issue) => issue.path === ''),
    inspectedIssues: truth.inspectedIssues,
    baselineRevision: truth.revision,
    body: truth.body,
    ...actions,
  };
}

/**
 * The form slice: the active entry (the navigation slice's selection)
 * inspected through E4, drafted in the feature store, validated, and
 * exposed as the pane's view model.
 */
export function useEntryForm(): EntryFormView {
  const { session } = useShell();
  const activeEntry = useContentNavigationStore((state) => state.activeEntry);
  const draft = useFormDraftStore();
  const openDraft = useFormDraftStore((state) => state.open);
  const content = useSessionQuery(['content'], (signal) =>
    session.inspect({ kind: 'content' }, signal),
  );

  // The open effect: a bound truth for the ACTIVE entry opens the
  // draft — once per binding (the store's same-binding no-op covers
  // refetches, so a background invalidation never clobbers a draft;
  // the stale-baseline diagnostic reports the moved revision instead).
  useEffect(() => {
    if (activeEntry === null || content.data === undefined) return;
    const bound = bindEntryTruth(content.data.payload, activeEntry.collection, activeEntry.entryId);
    if (bound.outcome !== 'truth') return;
    const binding: DraftBinding = {
      runtimeEpoch: session.ref.runtimeEpoch,
      generation: session.ref.generation,
      collection: bound.truth.collection,
      entryId: bound.truth.entryId,
    };
    openDraft(
      session.ref,
      binding,
      { revision: bound.truth.revision, values: bound.truth.values, body: bound.truth.body },
      bound.truth.fields,
    );
  }, [activeEntry, content.data, openDraft, session.ref]);

  if (activeEntry === null) return NO_ENTRY_VIEW;

  if (content.isPending) {
    return { ...NO_ENTRY_VIEW, status: 'loading', activeEntry };
  }
  if (content.error !== null) {
    return {
      ...NO_ENTRY_VIEW,
      status: 'drift',
      diagnosticMessage: diagnosticMessageOf(content.error),
      activeEntry,
    };
  }

  const bound = bindEntryTruth(content.data?.payload, activeEntry.collection, activeEntry.entryId);
  if (bound.outcome === 'absent') {
    return { ...NO_ENTRY_VIEW, status: 'absent', activeEntry };
  }
  if (bound.outcome === 'drift') {
    return {
      ...NO_ENTRY_VIEW,
      status: 'drift',
      diagnosticMessage: 'the content inspection payload drifted',
      activeEntry,
    };
  }

  // The stale-draft guard: a draft bound to anything but the CURRENT
  // pair + entry never renders — the open effect resets it next tick,
  // and this render shows the truth's own untouched view.
  const actions: DraftActions = {
    setMode: draft.setMode,
    reportFormValues: draft.reportFormValues,
    reportUnknownPart: draft.reportUnknownPart,
    reportRawText: draft.reportRawText,
  };
  const draftMatches =
    draft.binding !== null &&
    draft.binding.collection === bound.truth.collection &&
    draft.binding.entryId === bound.truth.entryId &&
    draft.binding.runtimeEpoch === session.ref.runtimeEpoch &&
    draft.binding.generation === session.ref.generation;
  if (!draftMatches || draft.baseline === null) {
    return truthView(bound.truth, activeEntry, actions);
  }
  return draftView(bound.truth, draft, actions);
}
