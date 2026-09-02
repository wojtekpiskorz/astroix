import { useEffect } from 'react';
import { IndexStatus } from '../../../../packages/app-shell/src/presentation/index-status';
import { useChromeStore } from '../../store';
import { useIndexPayload } from './api';
import { RuleListPanel } from './rule-list-panel';

/** The CSS vertical's sidebar body — the frame and tabs live in the shell. */
export function CssSidebar() {
  const selection = useChromeStore((state) => state.selection);
  const { data, refetch } = useIndexPayload();
  // The module-graph join is only complete once the canvas page's style
  // modules are loaded — the initial fetch can race that. Refetch on
  // selection (the charter's "refetch on demand" line).
  useEffect(() => {
    if (selection !== null) void refetch();
  }, [selection, refetch]);

  return (
    // the primitive's SidebarContent is the scroll point; the body pads
    // itself (the old aside frame's padding is gone)
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-2 pb-2">
      <IndexStatus count={data?.length ?? null} />
      <RuleListPanel payload={data} selection={selection} />
      <p className="mt-auto text-xs text-slate-600">The rule editor mounts below the list next.</p>
    </div>
  );
}
