import type { ReactNode } from 'react';
import { useShell } from './shell-context.ts';

/**
 * The stream's honest display state (#240's `stream-state` surface,
 * retained by the rebuilt shell with the same vocabulary): `connecting`
 * until the first verdict, `open` under a current-pair event, `stale`
 * when the stream is refused as stale, `unavailable` on a transport
 * refusal, and the terminal reason once the subscription settles. Live
 * SSE admission follows the reads law (#330) — the browser's
 * no-`Origin` same-origin GET shape is admitted — so a live document's
 * stream opens; the delivery semantics stay unit-pinned.
 */

/** The events stream's display state, as the shell renders it. */
export function StreamState(): ReactNode {
  const { streamState } = useShell();
  return <p data-testid="stream-state">{streamState}</p>;
}
