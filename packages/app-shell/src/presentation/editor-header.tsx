import { WriteStatusBadge } from './write-status-badge';

/**
 * The editor header both verticals' editor panes share (#219, lane C2 —
 * the write-status-badge doctrine's second sharing, now as a widget): the
 * open document's path, the persist loop's status badge (the write-status
 * and conflict surfacing surface — `stale` is the accepted-409 reload
 * banner), and an optional close affordance. Everything arrives as props;
 * the write loops stay with the host.
 */

interface EditorHeaderProps {
  /** The open document's identifier (a repo file path or collection/id). */
  title: string;
  /** The persist-on-pause loop's status — the revision/conflict result display. */
  status: Parameters<typeof WriteStatusBadge>[0]['status'];
  /** Edit intent: the close button's click; omit the callback to hide it. */
  onClose?: () => void;
}

export function EditorHeader({ title, status, onClose }: EditorHeaderProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <code className="truncate text-muted-foreground">{title}</code>
      <WriteStatusBadge status={status} />
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          aria-label="close editor"
          className="ml-auto rounded px-1 text-slate-500 hover:bg-slate-800"
        >
          ×
        </button>
      )}
    </div>
  );
}
