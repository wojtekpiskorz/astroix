import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { DialogDescription, DialogHeader, DialogTitle } from '#components/ui/dialog.tsx';
import { Input } from '#components/ui/input.tsx';
import type { SmokeStepItem } from './smoke-steps';
import { SMOKE_STEPS } from './smoke-steps';
import { useSmokeStore } from './store';

interface SmokeStepScreenProps {
  step: SmokeStepItem;
  index: number;
  onBack: () => void;
  onNext: () => void;
}

/** One step per screen: verify, optionally note, walk with Back/Next. */
export function SmokeStepScreen({ step, index, onBack, onNext }: SmokeStepScreenProps) {
  const done = useSmokeStore((state) => state.done);
  const note = useSmokeStore((state) => state.note[step.id] ?? '');
  const toggle = useSmokeStore((state) => state.toggle);
  const setNote = useSmokeStore((state) => state.setNote);
  const total = SMOKE_STEPS.length;

  return (
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
          checked={done[step.id] === true}
          onCheckedChange={() => toggle(step.id)}
          aria-label={`Step ${step.id} verified`}
        />
        Verified
      </span>
      <Input
        value={note}
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
                done[s.id] ? 'bg-emerald-500' : i === index ? 'bg-slate-300' : 'bg-slate-700'
              }`}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={index === 0} onClick={onBack}>
            Back
          </Button>
          <Button type="button" size="sm" onClick={onNext}>
            {index === total - 1 ? 'Summary' : 'Next'}
          </Button>
        </div>
      </div>
    </>
  );
}
