import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '#components/ui/dialog.tsx';
import { isSmokeGateOpen } from './gate.ts';
import { SmokeStepScreen } from './smoke-step-screen.tsx';
import { SMOKE_STEPS } from './smoke-steps.ts';
import { SmokeSummaryScreen } from './smoke-summary-screen.tsx';

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

  // `S` summons/dismisses the wizard, but never while typing — plain inputs,
  // textareas, contenteditable and CodeMirror's hidden textarea all count.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPlainS(event) || isTyping()) return;
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
  // modifier chords (cmd/ctrl/alt+S) stay with the browser
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return event.key.toLowerCase() === 's';
}

function isTyping(): boolean {
  const element = document.activeElement;
  if (element === null) return false;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return element instanceof HTMLElement && element.isContentEditable;
}
