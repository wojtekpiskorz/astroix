import type { ReactNode } from 'react';
import { Button } from '#components/ui/button.tsx';
import { ContentForm } from '../../../presentation/content-form.tsx';
import type { ActiveEntryView } from '../../../presentation/types.ts';
import { RawTruthPane } from '../raw/raw-truth-pane.tsx';
import { UnknownFieldsSection } from '../raw/unknown-fields-section.tsx';
import { type EntryFormView, useEntryForm } from './use-entry-form.ts';

/**
 * The Content vertical's entry-form pane (#252, J2): the editor dock's
 * surface — the active entry's inspected schema and values as SAFE
 * FORM STATE, the explicit raw representation beside it, the
 * deterministic validation report, and the validated edit intent as
 * feature state ONLY (no write endpoint, no optimistic persistence,
 * nothing leaves the document).
 *
 * The pane hosts the retained prop-driven widgets (the presentation
 * `ContentForm` and `RawField` — never another feature's modules) and
 * consumes the E4 truth through the form slice's hook (one
 * generation-scoped subscription shared with the discovery panel).
 * Validation is REPORTED, never gating: the inline issues render on
 * their fields, the document issues in the summary, the project's own
 * inspected verdict verbatim beside them — and the intent state says
 * ready only when the report is clean and the draft actually edited.
 */

const NOOP = (): void => {};

/** The mode toggle — form widgets or the explicit raw representation. */
function ModeToggle({ view }: { readonly view: EntryFormView }): ReactNode {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant={view.mode === 'form' ? 'default' : 'outline'}
        size="xs"
        data-astroix-form-mode-button="form"
        aria-pressed={view.mode === 'form'}
        onClick={() => view.setMode('form')}
      >
        Form
      </Button>
      <Button
        type="button"
        variant={view.mode === 'raw' ? 'default' : 'outline'}
        size="xs"
        data-astroix-form-mode-button="raw"
        aria-pressed={view.mode === 'raw'}
        onClick={() => view.setMode('raw')}
      >
        Raw
      </Button>
    </div>
  );
}

/** The project's own zod verdict on the entry's raw truth — verbatim, read-only. */
function InspectedIssues({
  issues,
}: {
  readonly issues: NonNullable<EntryFormView['inspectedIssues']>;
}): ReactNode {
  return (
    <div data-astroix-inspected-issues>
      <h4 className="text-xs font-semibold tracking-widest text-slate-500 uppercase">
        inspected issues
      </h4>
      <ul className="flex flex-col gap-0.5">
        {issues.map((issue, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the verdict's own order is the display identity — a path may repeat across codes
          <li key={`${issue.path}.${index}`} data-astroix-inspected-issue={issue.path}>
            <span className="text-xs text-muted-foreground">
              <span className="font-mono">{issue.path === '' ? '(document)' : issue.path}</span>{' '}
              {issue.message} <span className="opacity-60">[{issue.code}]</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The document-level diagnostics — parse and stale-baseline, each named by its kind. */
function DocumentIssues({ view }: { readonly view: EntryFormView }): ReactNode {
  if (view.documentIssues.length === 0) return null;
  return (
    <ul data-astroix-document-issues className="flex flex-col gap-0.5">
      {view.documentIssues.map((issue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the report's own order is the display identity — one kind may report twice
        <li key={`${issue.kind}.${index}`} data-issue-kind={issue.kind}>
          <span className="text-xs text-destructive">{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** The intent surface: the state vocabulary plus the materialized intent (feature state only — J3 consumes it). */
function IntentSurface({ view }: { readonly view: EntryFormView }): ReactNode {
  const text =
    view.intentState === 'none'
      ? 'edit intent: none (the draft matches the inspected truth)'
      : view.intentState === 'ready'
        ? `edit intent ready — baseline ${view.baselineRevision === null ? 'none' : view.baselineRevision.slice(0, 12)}… (not written; the write lane is future work)`
        : 'edit intent blocked — the draft has validation diagnostics';
  return (
    <div
      data-testid="intent-state"
      data-intent-state={view.intentState}
      className="text-xs text-muted-foreground"
    >
      {text}
      {view.intent !== null && (
        <details data-testid="edit-intent" className="mt-1">
          <summary className="cursor-pointer">the intent object (produced, never sent)</summary>
          <pre className="max-h-40 overflow-auto rounded-sm bg-muted p-2 font-mono text-[10px] whitespace-pre-wrap">
            {JSON.stringify(view.intent, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/** The ready state's header — the entry identity beside its inspected revision. */
function PaneHeader({
  entry,
  revision,
}: {
  readonly entry: ActiveEntryView;
  readonly revision: string | null;
}): ReactNode {
  return (
    <header className="flex items-baseline justify-between gap-2 px-3">
      <h3 className="truncate font-mono text-xs">
        {entry.collection}/{entry.entryId}
      </h3>
      <p
        data-testid="entry-revision"
        className="shrink-0 font-mono text-[10px] text-muted-foreground"
      >
        {revision === null ? 'revision: none' : `revision: ${revision.slice(0, 12)}…`}
      </p>
    </header>
  );
}

/** The entry-form pane — the editor dock slot's content. */
export function ContentEntryForm(): ReactNode {
  const view = useEntryForm();
  return (
    <div
      data-astroix-entry-form
      data-form-status={view.status}
      data-form-mode={view.status === 'ready' ? view.mode : undefined}
      className="flex min-h-0 flex-col gap-2 pt-2"
    >
      {view.status === 'no-entry' && (
        <p data-testid="entry-form-status" className="px-3 text-xs text-muted-foreground">
          no entry open — select an entry to inspect its form
        </p>
      )}
      {view.status === 'loading' && (
        <p data-testid="entry-form-status" className="px-3 text-xs text-muted-foreground">
          inspecting the entry…
        </p>
      )}
      {view.status === 'absent' && (
        <p data-testid="entry-form-status" className="px-3 text-xs text-muted-foreground">
          the entry is not in the content inspection
        </p>
      )}
      {view.status === 'drift' && (
        <p
          data-testid="entry-form-diagnostic"
          className="mx-2 rounded-sm bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {view.diagnosticMessage}
        </p>
      )}
      {view.status === 'ready' && view.activeEntry !== null && (
        <>
          <PaneHeader entry={view.activeEntry} revision={view.baselineRevision} />
          <div className="px-3">
            <ModeToggle view={view} />
          </div>
          {view.mode === 'form' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              <ContentForm
                key={view.mountId}
                collection={view.activeEntry.collection}
                fields={[...view.fields]}
                entryData={view.knownValues}
                projectionData={view.values}
                issues={view.inlineIssues}
                onValuesChange={view.reportFormValues}
                onFlushValidation={NOOP}
              />
              <div className="px-3">
                <UnknownFieldsSection
                  unknownPart={view.unknownPart}
                  onUnknownPart={view.reportUnknownPart}
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3">
              <RawTruthPane
                text={view.rawText}
                onText={view.reportRawText}
                parseError={view.parseError}
                revision={view.baselineRevision}
              />
            </div>
          )}
          <div className="flex flex-col gap-2 px-3 pb-2">
            {view.inspectedIssues !== null && view.inspectedIssues.length > 0 && (
              <InspectedIssues issues={view.inspectedIssues} />
            )}
            <DocumentIssues view={view} />
            <IntentSurface view={view} />
          </div>
        </>
      )}
    </div>
  );
}
