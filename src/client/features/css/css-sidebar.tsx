import { useEffect } from 'react';
import { useChromeStore } from '../../store';
import { useIndexPayload } from './api';
import { RuleList } from './rule-list';

/** The CSS vertical's sidebar body — the frame and tabs live in the shell. */
export function CssSidebar() {
  const selection = useChromeStore((state) => state.selection);
  const { data, refetch } = useIndexPayload();
  // The module-graph join is only complete once the canvas page's style
  // modules are loaded — the initial fetch can race that. Refetch on
  // selection (the charter's "refetch on demand" line).
  useEffect(() => {
    if (selection !== null) void refetch();
  }, [selection, refetch]);
  const count = data?.length ?? null;

  return (
    // the primitive's SidebarContent is the scroll point; the body only
    // pads horizontally (the old aside frame's padding is gone)
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2">
      <section className="text-slate-400">
        <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Index
        </h2>
        {count === null ? (
          <p data-astroix-index="loading">loading…</p>
        ) : count === 0 ? (
          <p data-astroix-index="empty">no indexed rules</p>
        ) : (
          <p data-astroix-index="ready">{count} rules indexed</p>
        )}
      </section>
      <RuleList payload={data} selection={selection} />
      <p className="mt-auto text-xs text-slate-600">The rule editor mounts below the list next.</p>
    </div>
  );
}
