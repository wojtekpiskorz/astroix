import { Button } from '#components/ui/button.tsx';
import { useChromeStore } from '../../store';

export function ChromeHeader() {
  const { selectMode, toggleSelectMode, selection } = useChromeStore();
  return (
    <header
      data-astroix-header=""
      className="flex items-center gap-4 border-b border-slate-800 bg-slate-900 px-4 py-2 text-sm"
    >
      <strong className="translate-x-2 text-xs tracking-widest uppercase">astroix</strong>
      <Button
        type="button"
        variant={selectMode ? 'default' : 'secondary'}
        size="sm"
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
