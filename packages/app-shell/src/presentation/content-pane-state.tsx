/**
 * The content pane's non-editor states (#219, lane C2): the syncing/empty/
 * reading placeholders the entry pane shows while its data arrives, no
 * entry is open, or the entry file's raw truth could not be read. Route and
 * selection state rendered as presentation — the state machine stays with
 * the host.
 */

interface ContentPaneStateProps {
  /**
   * The pane state to show: `syncing` (payload/schema still arriving),
   * `empty` (no entry open), `reading` (raw truth on its way in), or
   * `error` (the write loop is down).
   */
  state: 'syncing' | 'empty' | 'reading' | 'error';
  /** The state's human-facing message. */
  message: string;
}

export function ContentPaneState({ state, message }: ContentPaneStateProps) {
  return (
    <div
      data-astroix-content-pane={state}
      className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
    >
      {message}
    </div>
  );
}
