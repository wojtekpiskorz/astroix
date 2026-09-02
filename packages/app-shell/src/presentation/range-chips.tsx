import type { RuleRangeView } from './types';

/**
 * The range chips (#219, lane C2): the per-place jump row the rule editor
 * shows when one file styles the selection in several places. Pure
 * presentation — the chips report the picked index; the editor's view
 * scrolling (and its runtime view handle) stay with the host.
 */

interface RangeChipsProps {
  /** The places to jump between, in source order. */
  ranges: readonly RuleRangeView[];
  /** The chip that starts (or currently is) active. */
  activeIndex: number;
  /** Edit intent: a chip's click — jump to that range's index. */
  onJump: (index: number) => void;
}

export function RangeChips({ ranges, activeIndex, onJump }: RangeChipsProps) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-800 px-3 py-1.5">
      {ranges.map((range, index) => (
        <button
          type="button"
          key={range.label}
          data-astroix-range-chip={index}
          aria-pressed={index === activeIndex}
          onClick={() => onJump(index)}
          className={
            index === activeIndex
              ? 'rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-medium text-slate-950'
              : 'rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400'
          }
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
