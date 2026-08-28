import { useEffect } from 'react';
import { useChromeStore } from '../../store';
import { useIndexPayload } from './api';
import { RuleList } from './rule-list';

export function Sidebar() {
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
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-800 p-4 text-sm">
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
    </aside>
  );
}
