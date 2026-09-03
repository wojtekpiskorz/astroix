import type { ReactNode } from 'react';
import { useShell } from './shell-context.ts';

/**
 * The stream's honest display state (#240's `stream-state` surface,
 * retained by the rebuilt shell with the same vocabulary): `connecting`
 * until the first verdict, `open` under a current-pair event, `stale`
 * when the stream is refused as stale, `unavailable` on a transport
 * refusal, and the terminal reason once the subscription settles. Live
 * SSE admission is #330-blocked (owner ruling pending) — a live browser
 * stream reports the honest refusal here; the delivery semantics are
 * unit-pinned.
 */

/** The events stream's display state, as the shell renders it. */
export function StreamState(): ReactNode {
  const { streamState } = useShell();
  return <p data-testid="stream-state">{streamState}</p>;
}
