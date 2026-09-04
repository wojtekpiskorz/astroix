import type { ReactNode } from 'react';
import type { MatchedStyleRow } from './inspection/match-rows.ts';

/**
 * The CSS vertical's read-only rule list (#249, I1; the edit
 * affordance joined at #250, I2): the positioned matched rows — source
 * selectors, effective scoped selectors, media conditions, sanitized
 * project-relative locations, and the deterministic match order with
 * the cascade winner marked — in the order the pure matcher produced
 * (specificity desc, ties in payload order). Prop-driven like the
 * retained presentation widgets, but feature-owned: the retained
 * `presentation/rule-list.tsx` carries the EDIT vertical's intent (its
 * rows are buttons assembling an editor target); this list is the READ
 * slice — every control it has is a disclosure (the read-only rule
 * detail) plus, when the host passes `onEdit`, the one edit gesture
 * that opens the row's rule in the rule editor (the grant-bound
 * auto-write loop's surface, never a path selection).
 */

interface RuleListProps {
  /** The matcher's positioned output — nonempty; the caller renders the empty state. */
  readonly rows: readonly MatchedStyleRow[];
  /** The open detail row's key — `null` when every detail is collapsed. */
  readonly openKey: string | null;
  /** Opens one row's read-only detail (the disclosure intent). */
  readonly onOpenDetail: (key: string) => void;
  /** Opens one row's rule in the editor (the edit gesture — absent in read-only hosts). */
  readonly onEdit?: (row: MatchedStyleRow) => void;
}

export function RuleList({ rows, openKey, onOpenDetail, onEdit }: RuleListProps): ReactNode {
  return (
    <section
      data-astroix-css-rules="list"
      data-testid="css-rule-list"
      className="flex flex-col gap-1.5"
    >
      <h3 className="mb-1 text-xs font-semibold tracking-widest text-slate-500 uppercase">Rules</h3>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const { record } = row;
          const open = openKey === row.key;
          return (
            <li
              key={row.key}
              data-testid="css-rule"
              data-css-selector={record.selector}
              data-css-effective={record.effectiveSelector ?? ''}
              data-css-media={record.media ?? ''}
              data-css-file={record.file}
              data-css-line={record.line}
              data-css-scoped={record.scoped ? 'true' : 'false'}
              data-css-winner={row.winner ? 'true' : undefined}
              className={
                row.winner
                  ? 'rounded border border-amber-500/60 bg-amber-500/10 px-2 py-1'
                  : 'rounded border border-slate-800 px-2 py-1'
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                {row.winner && (
                  <span role="img" aria-label="cascade winner" title="cascade winner">
                    ★
                  </span>
                )}
                <code className="text-xs text-sky-300">{record.selector}</code>
                {record.effectiveSelector !== null && (
                  <code
                    data-testid="css-rule-effective"
                    className="rounded bg-slate-800 px-1 font-mono text-[10px] text-slate-400"
                  >
                    {record.effectiveSelector}
                  </code>
                )}
                {record.media !== null && (
                  <span
                    data-testid="css-rule-media"
                    className="rounded bg-slate-800 px-1 text-[10px] text-slate-400"
                  >
                    @media {record.media}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                {record.file}:{record.line}
              </div>
              <button
                type="button"
                data-testid="css-rule-detail-toggle"
                aria-expanded={open}
                onClick={() => onOpenDetail(row.key)}
                className="text-[11px] text-slate-500 underline"
              >
                {open ? 'hide detail' : 'detail'}
              </button>
              {onEdit !== undefined && (
                <button
                  type="button"
                  data-testid="css-rule-edit"
                  onClick={() => onEdit(row)}
                  className="text-[11px] text-slate-500 underline"
                >
                  edit
                </button>
              )}
              {open && (
                <dl data-testid="css-rule-detail" className="mt-1 text-[11px] text-slate-400">
                  <div className="flex gap-1">
                    <dt>source range:</dt>
                    <dd>
                      {record.range.start}–{record.range.end}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>origin:</dt>
                    <dd>
                      {record.scoped
                        ? `scoped style block ${record.styleBlockIndex ?? 0}`
                        : 'global sheet'}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>match:</dt>
                    <dd>{record.effectiveSelector ?? record.selector}</dd>
                  </div>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
