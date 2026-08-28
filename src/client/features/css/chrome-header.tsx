import { Button } from '#components/ui/button.tsx';
import { useChromeStore } from '../../store';

export function ChromeHeader() {
  const { activeVertical, selectMode, toggleSelectMode, selection } = useChromeStore();
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
        // select mode is owned by the CSS vertical (issue #70): off-CSS it is
        // suspended on the canvas, so the toggle has nothing to steer there
        disabled={activeVertical !== 'css'}
        onClick={toggleSelectMode}
        aria-pressed={selectMode}
      >
        Select: {selectMode ? 'on' : 'off'}
      </Button>
      <span data-astroix-selection className="truncate text-slate-400">
        {selection === null ? 'no selection' : selection.descriptor}
      </span>
    </header>
  );
}
