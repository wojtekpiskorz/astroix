import { type IndexPayloadRecord, matchRules } from '../../../core/matcher';
import type { Selection } from '../../store';
import { useCssStore } from './store';

/**
 * The rule list: on selection, the matcher runs over the index payload
 * against the canvas element (its own document context). Presentation shows
 * source-space selectors — the cid hash lives only in effective selectors
 * and is never displayed.
 */
export function RuleList({
  payload,
  selection,
}: {
  payload: IndexPayloadRecord[] | undefined;
  selection: Selection | null;
}) {
  const openEditor = useCssStore((state) => state.openEditor);
  if (selection === null) {
    return (
      <section data-astroix-rules="no-selection" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>Select an element to see its rules.</p>
      </section>
    );
  }
  if (payload === undefined) {
    return (
      <section data-astroix-rules="loading" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>loading…</p>
      </section>
    );
  }

  const matches = matchRules(payload, selection.element);
  if (matches.length === 0) {
    return (
      <section data-astroix-rules="empty" className="text-slate-500">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Rules
        </h2>
        <p>No matching rules for this element.</p>
      </section>
    );
  }

  const placesPerFile = new Map<string, number>();
  for (const match of matches) {
    placesPerFile.set(match.record.file, (placesPerFile.get(match.record.file) ?? 0) + 1);
  }

  const openRule = (match: (typeof matches)[number]): void => {
    // the editor shows the whole file; the chips jump between every place
    // that file styles the current selection
    const fileMatches = matches.filter((m) => m.record.file === match.record.file);
    openEditor({
      file: match.record.file,
      ranges: fileMatches.map((m) => ({
        start: m.record.range.start,
        end: m.record.range.end,
        label: `L${m.record.line}`,
      })),
      activeIndex: fileMatches.indexOf(match),
    });
  };

  return (
    <section data-astroix-rules="list">
      <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">Rules</h2>
      <ul className="flex flex-col gap-1.5">
        {matches.map((match) => {
          const multiPlace = (placesPerFile.get(match.record.file) ?? 0) > 1;
          return (
            <li
              key={`${match.record.file}:${match.record.range.start}`}
              data-astroix-rule=""
              data-astroix-winner={match.winner ? 'true' : undefined}
              className={
                match.winner
                  ? 'rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1'
                  : 'rounded border border-slate-800 px-2 py-1'
              }
            >
              <button
                type="button"
                onClick={() => openRule(match)}
                className="block w-full text-left"
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {match.winner && (
                    <span role="img" aria-label="cascade winner" title="cascade winner">
                      ★
                    </span>
                  )}
                  <code className="text-xs text-sky-300">{match.record.selector}</code>
                  {match.record.media !== null && (
                    <span
                      data-astroix-media={match.record.media}
                      className="rounded bg-slate-800 px-1 text-[10px] text-slate-400"
                    >
                      {match.record.media}
                    </span>
                  )}
                  {multiPlace && (
                    <span
                      data-astroix-multi=""
                      className="rounded bg-slate-800 px-1 text-[10px] text-slate-400"
                    >
                      multi-place
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  {match.record.file}:{match.record.line}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
