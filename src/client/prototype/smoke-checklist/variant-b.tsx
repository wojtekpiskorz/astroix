// PROTOTYPE (issue #46) — variant B, throwaway. A keyboard-summoned wizard
// dialog: one step per screen, the chrome stays unobstructed between steps.
// Entry point demonstrated: the "S" shortcut (guarded while typing).
import { useEffect, useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog.tsx';
import { Input } from '#components/ui/input.tsx';
import { SMOKE_STEPS } from './smoke-steps';
import { buildSmokeReport, useSmokeStore, verifiedCount } from './use-smoke-store';

function isTyping(): boolean {
  const element = document.activeElement;
  if (element === null) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

export function VariantB() {
  const { done, note, toggle, setNote } = useSmokeStore();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0); // steps.length = the summary screen
  const [report, setReport] = useState<string | null>(null);
  const total = SMOKE_STEPS.length;
  const onSummary = index >= total;
  const step = onSummary ? null : (SMOKE_STEPS[index] ?? null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || isTyping()) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const copy = async (): Promise<void> => {
    const text = buildSmokeReport();
    setReport(text);
    await navigator.clipboard.writeText(text);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-astroix-prototype-smoke="B-hint"
        className="fixed right-3 bottom-3 z-[90] rounded-full border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-xs text-slate-300 shadow-lg"
      >
        Smoke checklist · press <kbd className="rounded bg-slate-800 px-1">S</kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* `dark`: Base UI portals into document.body — outside the shadow
            root where the chrome's .dark theme lives — so the token block is
            re-scoped onto the portal content itself (finding for the fold-in) */}
        <DialogContent className="dark sm:max-w-md">
          {step !== null ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-sm">
                  Step {index + 1} of {total} — {step.id}. {step.title}
                </DialogTitle>
                <DialogDescription className="text-xs leading-snug">
                  {step.detail}{' '}
                  <span className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">
                    look at: {step.surface}
                  </span>
                </DialogDescription>
              </DialogHeader>
              <span className="flex items-center gap-2 text-xs text-slate-300">
                <Checkbox
                  checked={done[step.id] ?? false}
                  onCheckedChange={() => toggle(step.id)}
                  aria-label={`Step ${step.id} verified`}
                />
                Verified
              </span>
              <Input
                value={note[step.id] ?? ''}
                onChange={(event) => setNote(step.id, event.target.value)}
                placeholder="note (optional)"
                className="h-7 text-xs"
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-1" aria-hidden>
                  {SMOKE_STEPS.map((s, i) => (
                    <span
                      key={s.id}
                      className={`size-1.5 rounded-full ${
                        done[s.id]
                          ? 'bg-emerald-500'
                          : i === index
                            ? 'bg-slate-300'
                            : 'bg-slate-700'
                      }`}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => setIndex((value) => Math.max(0, value - 1))}
                  >
                    Back
                  </Button>
                  <Button type="button" size="sm" onClick={() => setIndex((value) => value + 1)}>
                    {index === total - 1 ? 'Summary' : 'Next'}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-sm">
                  Smoke summary — {verifiedCount(done)}/{total} verified
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Unchecked steps land in the report as outstanding.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-44 overflow-y-auto text-xs">
                {SMOKE_STEPS.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-0.5">
                    <Checkbox checked={done[s.id] ?? false} onCheckedChange={() => toggle(s.id)} />
                    <span className={done[s.id] ? 'text-slate-400' : 'text-slate-200'}>
                      {s.id}. {s.title}
                    </span>
                  </li>
                ))}
              </ul>
              {report !== null && (
                <pre className="max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[10px] leading-snug whitespace-pre-wrap text-slate-400">
                  {report}
                </pre>
              )}
              <DialogFooter>
                <Button type="button" size="sm" variant="ghost" onClick={() => setIndex(0)}>
                  Back to steps
                </Button>
                <Button type="button" size="sm" onClick={() => void copy()}>
                  {report !== null ? 'Copy report ✓' : 'Copy report'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
