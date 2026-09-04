import type { ReactNode } from 'react';
import { Button } from '#components/ui/button.tsx';
import type { EntryWriteControls } from './use-entry-write.ts';

/**
 * The Content vertical's write surface (#253, J3): the pane footer's
 * write gesture and its honest state report. The AC's five states are
 * the `data-write-state` vocabulary — `pending`, `committed`,
 * `rejected`, `irreversible-postcommit`, `refresh-required` (plus the
 * quiet `idle`) — rendered from the loop's machine, never guessed, and
 * the sanitized reason rides `data-write-code` (a protocol error code
 * or the loop's own admission vocabulary; no raw error text exists
 * here). The revision-conflict handback (the disk-truth SHA the next
 * attempt must serialize against) renders when the server served one.
 */

/** The state line's text — one sanitized sentence per phase. */
function statusText(controls: EntryWriteControls): string {
  switch (controls.phase) {
    case 'idle':
      return 'write: idle';
    case 'pending':
      return 'write: pending…';
    case 'committed':
      return `write: committed at revision ${controls.revision ?? '?'}`;
    case 'refresh-required':
      return `write: committed${controls.revision === null ? '' : ` at revision ${controls.revision}`} — refreshing server truth…`;
    case 'irreversible-postcommit':
      return 'write: outcome could not be confirmed — the server truth below is authoritative';
    case 'rejected':
      return `write: rejected (${controls.code ?? 'unknown'})`;
  }
}

/** The write surface — the intent's consumer and the pane's one mutation gesture. */
export function ContentWriteControls({
  controls,
}: {
  readonly controls: EntryWriteControls;
}): ReactNode {
  return (
    <div data-astroix-write-surface className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          data-testid="write-entry"
          disabled={!controls.canWrite}
          title={controls.blockedReason ?? 'write the validated edit intent through its grant'}
          onClick={() => {
            void controls.submit();
          }}
        >
          Write
        </Button>
        <p
          data-testid="write-state"
          data-write-state={controls.phase}
          data-write-code={controls.code ?? undefined}
          data-write-conflict={controls.conflictSha256 ?? undefined}
          className="font-mono text-[10px] text-muted-foreground"
        >
          {statusText(controls)}
        </p>
      </div>
      {controls.phase === 'rejected' && controls.conflictSha256 !== null && (
        <p data-testid="write-conflict" className="font-mono text-[10px] text-amber-500">
          the file changed on disk — current baseline {controls.conflictSha256.slice(0, 12)}…
        </p>
      )}
    </div>
  );
}
