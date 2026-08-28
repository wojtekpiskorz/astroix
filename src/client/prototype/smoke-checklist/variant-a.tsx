// PROTOTYPE (issue #46) — variant A, throwaway. A docked side panel: the
// whole checklist stays visible next to the canvas while the owner works
// through the smoke. Entry point demonstrated: the ?smoke=1 URL param itself
// (this panel is what the param opens).
import { useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { Input } from '#components/ui/input.tsx';
import { SMOKE_STEPS } from './smoke-steps';
import { buildSmokeReport, useSmokeStore, verifiedCount } from './use-smoke-store';

export function VariantA() {
  const { done, note, toggle, setNote, reset } = useSmokeStore();
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const copy = async (): Promise<void> => {
    const text = buildSmokeReport();
    setReport(text);
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };

  return (
    <aside
      data-astroix-prototype-smoke="A"
      className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-slate-800 bg-slate-900/40 p-4 text-sm"
    >
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-xs font-semibold tracking-widest text-slate-500 uppercase">
            Owner smoke
          </h2>
          <p className="text-[11px] text-slate-500">manual-smoke.md · entry: ?smoke=1</p>
        </div>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-300">
          {verifiedCount(done)}/{SMOKE_STEPS.length}
        </span>
      </header>

      <ul className="flex flex-col gap-2">
        {SMOKE_STEPS.map((step) => (
          <li
            key={step.id}
            className="rounded border border-slate-800 px-2 py-1.5 data-verified:border-emerald-700/60"
            data-verified={done[step.id] ? '' : undefined}
          >
            <div className="flex items-start gap-2">
              <Checkbox
                checked={done[step.id] ?? false}
                onCheckedChange={() => toggle(step.id)}
                aria-label={`Step ${step.id} verified`}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <strong className="text-xs text-slate-200">
                    {step.id}. {step.title}
                  </strong>
                  <span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
                    {step.surface}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{step.detail}</p>
                <Input
                  value={note[step.id] ?? ''}
                  onChange={(event) => setNote(step.id, event.target.value)}
                  placeholder="note (optional) — what failed / where"
                  className="mt-1.5 h-6 rounded-md text-xs"
                />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copy report ✓' : 'Copy report'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
            Reset
          </Button>
        </div>
        {report !== null && (
          <pre className="max-h-48 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[10px] leading-snug whitespace-pre-wrap text-slate-400">
            {report}
          </pre>
        )}
      </div>
    </aside>
  );
}
