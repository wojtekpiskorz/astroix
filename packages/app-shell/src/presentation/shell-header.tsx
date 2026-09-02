import { Button } from '#components/ui/button.tsx';

/**
 * The app-shell header (#219, lane C2): the selection-state surface,
 * extracted from the integration chrome's header as a prop-driven widget.
 * Selection (the clicked canvas element's descriptor), select mode, and the
 * vertical gating all arrive as props — the store, the canvas machinery,
 * and the vertical state stay with the host.
 */

interface ShellHeaderProps {
  /** Select mode's on/off state (presentation-only state). */
  selectMode: boolean;
  /**
   * Select mode is owned by the CSS vertical (issue #70): off-CSS it is
   * suspended on the canvas, so the toggle has nothing to steer there.
   */
  selectModeDisabled: boolean;
  /** The selected element's descriptor, or null with no selection. */
  selectionDescriptor: string | null;
  /** Edit intent: the select-mode toggle's click. */
  onToggleSelectMode: () => void;
}

export function ShellHeader({
  selectMode,
  selectModeDisabled,
  selectionDescriptor,
  onToggleSelectMode,
}: ShellHeaderProps) {
  return (
    <header
      data-astroix-header=""
      className="flex items-center gap-4 border-b border-border bg-card px-4 py-2 text-sm"
    >
      <strong className="translate-x-2 text-xs tracking-widest uppercase">astroix</strong>
      <Button
        type="button"
        variant={selectMode ? 'default' : 'secondary'}
        size="sm"
        disabled={selectModeDisabled}
        onClick={onToggleSelectMode}
        aria-pressed={selectMode}
      >
        Select: {selectMode ? 'on' : 'off'}
      </Button>
      <span data-astroix-selection className="truncate text-slate-400">
        {selectionDescriptor ?? 'no selection'}
      </span>
    </header>
  );
}
