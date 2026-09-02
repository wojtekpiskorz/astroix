import { RuleList } from '../../../../packages/app-shell/src/presentation/rule-list';
import { matchRules } from '../../../core/matcher';
import type { Selection } from '../../store';
import { useCssStore } from './store';

/**
 * The integration-era rule-list adapter (#219, ADR-0010): keeps the legacy
 * contract (index payload + live selection in, store-driven editor open)
 * and maps it onto the moved prop-driven widget — the matcher runs here,
 * over the payload against the canvas element (its own document context);
 * the widget receives positioned matches and an open-file callback. Dies at
 * the retirement gate with the rest of the adapters.
 */
export function RuleListPanel({
  payload,
  selection,
}: {
  payload: Parameters<typeof matchRules>[0] | undefined;
  selection: Selection | null;
}) {
  const openEditor = useCssStore((state) => state.openEditor);
  const matches =
    selection === null || payload === undefined ? null : matchRules(payload, selection.element);
  return (
    <RuleList
      matches={matches === null ? null : matches.map(({ record, winner }) => ({ record, winner }))}
      hasSelection={selection !== null}
      onOpenFile={(target) =>
        openEditor({
          file: target.file,
          ranges: target.ranges.map((range) => ({
            start: range.start,
            end: range.end,
            label: range.label,
          })),
          activeIndex: target.activeIndex,
        })
      }
    />
  );
}
