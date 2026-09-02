/**
 * The write-status badge both verticals' editor headers share (ADR-0002's
 * two-vertical birth rule, fired at #74's auto-write loop: the CSS rule
 * editor and the content entry pane persist through the same doctrine, so
 * the status vocabulary and its badge live here — the loops themselves stay
 * apart, range-splice and whole-file serialize are different mechanisms).
 * Base-nova tokens where they exist; `data-astroix-write-status` is the
 * shared test attribute.
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

/** The badge's color class per state — destructive is the theme's error token; emerald/amber stay raw until the theme grows success/warning tokens. */
const WRITE_STATUS_CLASS: Record<WriteStatus, string> = {
  loading: 'text-muted-foreground',
  idle: 'text-muted-foreground',
  pending: 'text-amber-400',
  saved: 'text-emerald-400',
  stale: 'text-amber-400',
  error: 'text-destructive',
};

export function WriteStatusBadge({ status }: { status: WriteStatus }) {
  return (
    <span data-astroix-write-status={status} className={WRITE_STATUS_CLASS[status]}>
      {WRITE_STATUS_TEXT[status]}
    </span>
  );
}
