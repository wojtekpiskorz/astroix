import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '#components/ui/dialog.tsx';
import { isSmokeGateOpen } from './gate';
import { SmokeStepScreen } from './smoke-step-screen';
import { SMOKE_STEPS } from './smoke-steps';
import { SmokeSummaryScreen } from './smoke-summary-screen';

// Read once per page load: the gate never flips without a reload, so a
// module-level constant keeps the check out of the render path entirely.
const gateOpen = isSmokeGateOpen(window.location.search);

/**
 * The owner's manual-smoke checklist (fold-in of the #46 prototype, variant
 * B): renders nothing unless the top-level URL carries `?astroix_smoke=1`.
 */
export function SmokeChecklist() {
  if (!gateOpen) return null;
  return <SmokeWizard />;
}

function SmokeWizard() {
  const [open, setOpen] = useState(false);
  // index === SMOKE_STEPS.length is the summary screen
  const [index, setIndex] = useState(0);
  const total = SMOKE_STEPS.length;
  const step = index < total ? (SMOKE_STEPS[index] ?? null) : null;

  // `S` summons/dismisses the wizard, but never while typing — the target
  // must come from the event's composed path: while CodeMirror holds focus,
  // document.activeElement is the shadow host (#astroix-root), not the
  // editor, so a focus-based guard cannot see the chrome's own inputs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPlainS(event) || isTypingTarget(event.composedPath()[0])) return;
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        data-astroix-smoke="pill"
        onClick={() => setOpen(true)}
        className="fixed right-2 bottom-2 z-[90] rounded-full border border-slate-700 bg-slate-900/90 px-2 py-0.5 text-[10px] text-slate-400 shadow-lg"
      >
        Smoke <kbd className="rounded bg-slate-800 px-1">S</kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        {/* `dark`: Base UI portals the dialog into document.body — outside
            the shadow root where the chrome's .dark token block lives — so
            the block is re-scoped onto the portal content itself (#46
            finding; bites every future chrome dialog). */}
        <DialogContent className="dark sm:max-w-md">
          {step !== null ? (
            <SmokeStepScreen
              step={step}
              index={index}
              onBack={() => setIndex((value) => Math.max(0, value - 1))}
              onNext={() => setIndex((value) => value + 1)}
            />
          ) : (
            <SmokeSummaryScreen onBackToSteps={() => setIndex(0)} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function isPlainS(event: KeyboardEvent): boolean {
  // modifier chords (cmd/ctrl/alt+S) stay with the browser; a held key
  // would strobe the dialog open and closed on every OS repeat
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return false;
  return event.key.toLowerCase() === 's';
}

function isTypingTarget(target: EventTarget | null | undefined): boolean {
  // plain inputs, textareas, contenteditable — CodeMirror's hidden textarea
  // and .cm-content both count, inside or outside the shadow root
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return target instanceof HTMLElement && target.isContentEditable;
}
