/**
 * The CSS index summary (#219, lane C2): the inspection-status line the CSS
 * sidebar shows above the rule list — loading, empty, or the served rule
 * count. Pure presentation of the index payload's presence.
 */

interface IndexStatusProps {
  /** Served rule count; `null` = the index payload is still loading. */
  count: number | null;
}

export function IndexStatus({ count }: IndexStatusProps) {
  return (
    <section className="text-slate-400">
      <h2 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">Index</h2>
      {count === null ? (
        <p data-astroix-index="loading">loading…</p>
      ) : count === 0 ? (
        <p data-astroix-index="empty">no indexed rules</p>
      ) : (
        <p data-astroix-index="ready">{count} rules indexed</p>
      )}
    </section>
  );
}
