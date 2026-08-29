/**
 * The write-status badge both verticals' editor headers share (ADR-0002's
 * two-vertical birth rule, fired at #74's auto-write loop: the CSS rule
 * editor and the content entry pane persist through the same doctrine, so
 * the status vocabulary and its badge live here — the loops themselves stay
 * apart, range-splice and whole-file serialize are different mechanisms).
 * Base-nova tokens; `data-astroix-write-status` is the shared test attribute.
 */

/** The persist-on-pause loop's shared status vocabulary. */
export type WriteStatus = 'loading' | 'idle' | 'pending' | 'saved' | 'stale' | 'error';

/** The header's badge text — empty where the loop is quiet. */
const WRITE_STATUS_TEXT: Record<WriteStatus, string> = {
  loading: '',
  idle: '',
  pending: 'writing…',
  saved: 'written',
  stale: 'changed on disk — reloaded',
  error: 'write error',
};

export function WriteStatusBadge({ status }: { status: WriteStatus }) {
  return (
    <span
      data-astroix-write-status={status}
      className={
        status === 'saved'
          ? 'text-emerald-400'
          : status === 'pending' || status === 'stale'
            ? 'text-amber-400'
            : status === 'error'
              ? 'text-red-400'
              : 'text-muted-foreground'
      }
    >
      {WRITE_STATUS_TEXT[status]}
    </span>
  );
}
