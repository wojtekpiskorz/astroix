import { type ReactNode, useEffect } from 'react';
import { useShell } from './shell-context.ts';
import { useSessionQuery } from './use-session-query.ts';

/**
 * The shell's session-inspection surface (#241, G2): the project's own
 * inspection through the generation-scoped query — the retained
 * `inspect-revision`/`reinspect` surface (#240's testids, same
 * semantics) and the proof the query discipline is live: the revision
 * a user reads is the current pair's inspection, fetched under its
 * key, belt-checked, and cleared with the session at reset.
 */

/** The shell's project inspection probe. */
export function SessionInspection(): ReactNode {
  const { session, clearCommandError, reportCommandError } = useShell();
  const query = useSessionQuery(['project'], (signal) =>
    session.inspect({ kind: 'project' }, signal),
  );

  useEffect(() => {
    if (query.error !== null) reportCommandError(query.error);
  }, [query.error, reportCommandError]);

  return (
    <>
      <p data-testid="inspect-revision">
        {query.data === undefined ? 'pending' : String(query.data.revision)}
      </p>
      <button
        type="button"
        data-testid="reinspect"
        disabled={query.isFetching}
        onClick={() => {
          clearCommandError();
          void query.refetch();
        }}
      >
        Inspect again
      </button>
    </>
  );
}
