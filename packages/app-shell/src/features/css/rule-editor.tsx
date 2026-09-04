import { type ReactNode, useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Input } from '#components/ui/input.tsx';
import { parseRule } from './editing/declarations.ts';
import type { BoundStyleRecord } from './inspection/bind-styles.ts';
import type { CssAutoWriteControls } from './use-auto-write.ts';
import { cssWriteStatusText } from './write-status.ts';

/**
 * The CSS vertical's rule editor (#250, I2): one matched record's rule
 * — parsed out of the served raw truth — as an editable surface: the
 * selector head and each declaration's value. Every change is the
 * auto-write gesture (nothing writes here directly — the scheduling is
 * the controls'), so the editor itself holds only the draft state and
 * the honest refusals: a rule whose body is not a flat declaration
 * list renders read-only (the parser's fail-closed law), never a
 * heuristic input.
 *
 * Keyed by its target at the mount site: a fresh record (the write's
 * own refresh re-resolving the edited rule) remounts the editor on the
 * served truth, while the in-flight window keeps the user's draft —
 * no flicker, no reopen on stale bytes.
 */

interface RuleEditorProps {
  /** The record being edited — its range locates the rule in `raw`. */
  readonly record: BoundStyleRecord;
  /** The file's served raw text — the parse's byte anchor. */
  readonly raw: string;
  /** The auto-write controls — the only write path. */
  readonly controls: CssAutoWriteControls;
  /** Closes the editor (the panel's disclosure gesture). */
  onClose(): void;
}

export function CssRuleEditor({ record, raw, controls, onClose }: RuleEditorProps): ReactNode {
  const ruleText =
    record.range.end <= raw.length ? raw.slice(record.range.start, record.range.end) : '';
  const parsed = parseRule(ruleText);
  const [selectorDraft, setSelectorDraft] = useState(record.selector);
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});

  return (
    <section
      data-astroix-css-rule-editor
      data-testid="css-rule-editor"
      className="mt-1 flex flex-col gap-1.5 rounded border border-slate-700 bg-slate-900/60 p-2"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-semibold tracking-widest text-slate-400 uppercase">
          Edit rule
        </h4>
        <button
          type="button"
          data-testid="css-rule-editor-close"
          className="text-[11px] text-slate-500 underline"
          onClick={onClose}
        >
          close
        </button>
      </div>
      {parsed === null ? (
        <p data-testid="css-rule-editor-readonly" className="text-[11px] text-slate-500">
          this rule's body is not a flat declaration list — read-only
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1 text-[11px] text-slate-400">
            <span>selector</span>
            <Input
              aria-label={`selector of ${record.selector}`}
              data-testid="css-selector-input"
              className="h-6 flex-1 font-mono text-xs"
              value={selectorDraft}
              onChange={(event) => {
                const next = event.target.value;
                setSelectorDraft(next);
                controls.scheduleSelectorEdit(record, next);
              }}
            />
          </div>
          <ul className="flex flex-col gap-1">
            {parsed.declarations.map((declaration) => (
              <li key={declaration.property} className="flex items-center gap-1 text-[11px]">
                <code className="min-w-24 font-mono text-sky-300">{declaration.property}</code>
                <Input
                  data-testid="css-decl-input"
                  data-css-prop={declaration.property}
                  className="h-6 flex-1 font-mono text-xs"
                  value={valueDrafts[declaration.property] ?? declaration.value}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValueDrafts((drafts) => ({ ...drafts, [declaration.property]: next }));
                    controls.scheduleDeclarationEdit(record, declaration.property, next);
                  }}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          data-testid="css-undo"
          disabled={!controls.canUndo}
          title="undo the last landed write through the same grant-bound loop"
          onClick={controls.undo}
        >
          Undo
        </Button>
        <p
          data-testid="css-write-status"
          data-write-state={controls.status.state}
          data-write-code={controls.status.code ?? undefined}
          data-write-conflict={controls.status.conflictSha256 ?? undefined}
          className="font-mono text-[10px] text-muted-foreground"
        >
          {cssWriteStatusText(controls.status)}
        </p>
      </div>
    </section>
  );
}
