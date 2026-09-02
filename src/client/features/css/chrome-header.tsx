import { ShellHeader } from '../../../../packages/app-shell/src/presentation/shell-header';
import { useChromeStore } from '../../store';

/**
 * The integration-era header adapter (#219, ADR-0010): keeps the chrome
 * store ownership (vertical, select mode, selection) and maps it onto the
 * moved prop-driven widget — the descriptor surfacing is presentation; the
 * state and its canvas machinery stay here. Dies at the retirement gate.
 */
export function ChromeHeader() {
  const { activeVertical, selectMode, toggleSelectMode, selection } = useChromeStore();
  return (
    <ShellHeader
      selectMode={selectMode}
      selectModeDisabled={activeVertical !== 'css'}
      selectionDescriptor={selection?.descriptor ?? null}
      onToggleSelectMode={toggleSelectMode}
    />
  );
}
