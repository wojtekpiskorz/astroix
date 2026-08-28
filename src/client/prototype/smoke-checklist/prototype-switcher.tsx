// PROTOTYPE (issue #46) — the floating variant switcher, throwaway. Obviously
// not part of the design being judged: high-contrast pill, bottom-centre.
import { Button } from '#components/ui/button.tsx';

export function PrototypeSwitcher({
  current,
  name,
  onCycle,
}: {
  current: string;
  name: string;
  onCycle: (direction: 1 | -1) => void;
}) {
  return (
    <div className="fixed bottom-2 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full border border-amber-400/70 bg-slate-950/95 px-2 py-1 text-xs text-amber-200 shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous variant"
        onClick={() => onCycle(-1)}
      >
        ←
      </Button>
      <span className="min-w-36 text-center font-medium">
        {current} — {name}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next variant"
        onClick={() => onCycle(1)}
      >
        →
      </Button>
    </div>
  );
}
