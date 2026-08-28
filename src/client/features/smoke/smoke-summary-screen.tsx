import { useState } from 'react';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog.tsx';
import { buildSmokeReport, verifiedCount } from './smoke-report';
import { SMOKE_STEPS } from './smoke-steps';
import { useSmokeStore } from './store';

interface SmokeSummaryScreenProps {
  onBackToSteps: () => void;
}

/** The full step list for a final pass, plus the Copy report. */
export function SmokeSummaryScreen({ onBackToSteps }: SmokeSummaryScreenProps) {
  const done = useSmokeStore((state) => state.done);
  const note = useSmokeStore((state) => state.note);
  const toggle = useSmokeStore((state) => state.toggle);
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const total = SMOKE_STEPS.length;

  const copy = async (): Promise<void> => {
    const text = buildSmokeReport(done, note, {
      url: `${window.location.origin}${window.location.pathname}`,
      userAgent: navigator.userAgent,
      isoTimestamp: new Date().toISOString(),
    });
    // the preview lands regardless; the ✓ flips only when the clipboard
    // actually took the write (permissions/non-secure contexts can refuse)
    setReport(text);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
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
            <Checkbox
              checked={done[s.id] === true}
              onCheckedChange={() => toggle(s.id)}
              aria-label={`Step ${s.id} verified`}
            />
            <span className={done[s.id] ? 'text-slate-400' : 'text-slate-200'}>
              {s.id}. {s.title}
            </span>
          </li>
        ))}
      </ul>
      {report !== null && (
        <pre
          data-astroix-smoke="report"
          className="max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[10px] leading-snug whitespace-pre-wrap text-slate-400"
        >
          {report}
        </pre>
      )}
      <DialogFooter>
        <Button type="button" size="sm" variant="ghost" onClick={onBackToSteps}>
          Back to steps
        </Button>
        <Button type="button" size="sm" onClick={() => void copy()}>
          {copied ? 'Copy report ✓' : 'Copy report'}
        </Button>
      </DialogFooter>
    </>
  );
}
