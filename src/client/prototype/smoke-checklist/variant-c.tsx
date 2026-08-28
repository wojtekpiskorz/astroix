// PROTOTYPE (issue #46) — variant C, throwaway. A permanent bottom status
// strip: numbered step chips, one step expanded at a time in a card above the
// bar. Entry point demonstrated: presence — the bar is simply always there
// while smoke mode is on.
import { useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { Input } from '#components/ui/input.tsx';
import { SMOKE_STEPS } from './smoke-steps';
import { buildSmokeReport, useSmokeStore, verifiedCount } from './use-smoke-store';

export function VariantC() {
  const { done, note, toggle, setNote } = useSmokeStore();
  // which card is open above the bar: a step id, 'report', or null
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const step = SMOKE_STEPS.find((s) => s.id === openCard) ?? null;
  const showReport = openCard === 'report';

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(buildSmokeReport());
    setCopied(true);
    setOpenCard('report');
  };

  return (
    <div
      data-astroix-prototype-smoke="C"
      className="fixed inset-x-0 bottom-11 z-[80] flex flex-col items-stretch"
    >
      {(step !== null || showReport) && (
        <div className="mx-auto mb-2 w-[30rem] max-w-[90%] rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm shadow-2xl">
          {step !== null ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <strong className="text-xs text-slate-200">
                  {step.id}. {step.title}
                </strong>
                <span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
                  {step.surface}
                </span>
                <button
                  type="button"
                  onClick={() => setOpenCard(null)}
                  className="ml-auto text-xs text-slate-500 hover:text-slate-300"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-slate-500">{step.detail}</p>
              <div className="mt-2 flex items-center gap-2">
                <Checkbox
                  checked={done[step.id] ?? false}
                  onCheckedChange={() => toggle(step.id)}
                />
                <span className="text-xs text-slate-400">Verified</span>
                <Input
                  value={note[step.id] ?? ''}
                  onChange={(event) => setNote(step.id, event.target.value)}
                  placeholder="note (optional)"
                  className="h-6 flex-1 rounded-md text-xs"
                />
                <Button type="button" size="xs" onClick={() => setOpenCard(nextId(step.id))}>
                  Next
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <strong className="text-xs text-slate-200">Smoke report</strong>
                <button
                  type="button"
                  onClick={() => setOpenCard(null)}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  ✕
                </button>
              </div>
              <pre className="mt-1 max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[10px] leading-snug whitespace-pre-wrap text-slate-400">
                {buildSmokeReport()}
              </pre>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-slate-700 bg-slate-900/95 px-4 py-1.5 text-xs shadow-[0_-4px_20px_rgba(0,0,0,0.5)] backdrop-blur">
        <strong className="tracking-widest text-slate-500 uppercase">Smoke</strong>
        <span className="text-slate-400">
          {verifiedCount(done)}/{SMOKE_STEPS.length}
        </span>
        <div className="flex flex-1 justify-center gap-1">
          {SMOKE_STEPS.map((s) => (
            <Button
              key={s.id}
              type="button"
              size="xs"
              variant={done[s.id] ? 'default' : openCard === s.id ? 'secondary' : 'ghost'}
              onClick={() => setOpenCard(openCard === s.id ? null : s.id)}
              title={s.title}
            >
              {s.id}
            </Button>
          ))}
        </div>
        <Button type="button" size="xs" variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copy report ✓' : 'Copy report'}
        </Button>
      </div>
    </div>
  );
}

function nextId(current: string): string | null {
  const index = SMOKE_STEPS.findIndex((s) => s.id === current);
  if (index === -1 || index === SMOKE_STEPS.length - 1) return null;
  return SMOKE_STEPS[index + 1]?.id ?? null;
}
