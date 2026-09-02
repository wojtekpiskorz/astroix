import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { ValidationIssueRecord } from '../../../core/form-tree';
import { validateDraft } from './api';

const VALIDATE_DEBOUNCE_MS = 300;

/** Issues by dotted path; multiple issues on one path join with a bullet. */
function toIssueMap(records: ValidationIssueRecord[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const record of records) {
    map[record.path] =
      map[record.path] === undefined ? record.message : `${map[record.path]} • ${record.message}`;
  }
  return map;
}

/**
 * One validation roundtrip. Module scope on purpose: a stable reference the
 * effects close over; `token` (the run counter) drops stale responses —
 * typing outruns the roundtrips.
 */
async function runValidation(
  collection: string,
  draft: unknown,
  token: { current: number },
  setIssues: Dispatch<SetStateAction<Record<string, string>>>,
): Promise<void> {
  const run = token.current + 1;
  token.current = run;
  const records = await validateDraft(collection, draft);
  if (run !== token.current) return;
  setIssues(toIssueMap(records));
}

/**
 * The advisory-validation loop's integration-era adapter (#219, ADR-0010):
 * the fetch roundtrip the moved ContentForm used to own — debounced
 * safeParse against the collection's own schema, issues inline per field,
 * gating nothing (US11/US12; the auto-write never checks these issues
 * either). The form reports every draft change (`notify`) and blur flushes
 * (`flush`); the issues land back in the form as props. `resetKey` (the
 * pane's truth seq) clears the display the moment the form remounts on a
 * new raw truth — the mount emission re-validates on the debounce, exactly
 * the remount semantics the in-form loop carried.
 */
export function useAdvisoryValidation(collection: string, resetKey: unknown) {
  const [issues, setIssues] = useState<Record<string, string>>({});
  const latestDraft = useRef<unknown>(undefined);

  // only the latest run may land issues
  const runToken = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // a fresh truth clears the display immediately (the remounted form's
  // mount emission re-arms the debounce)
  const prevResetKey = useRef(resetKey);
  useEffect(() => {
    if (prevResetKey.current === resetKey) return;
    prevResetKey.current = resetKey;
    if (timer.current !== undefined) clearTimeout(timer.current);
    runToken.current += 1; // drops any in-flight roundtrip
    setIssues({});
    // children's effects run first: the remounted form's mount emission has
    // already called notify and armed the debounce with the NEW truth's
    // values — the clearTimeout above would kill exactly that baseline
    // validation (the legacy in-form loop always re-validated on remount).
    // Re-arm it against the notified draft so a 409/external-truth reload
    // shows the fresh baseline's issues, not an empty panel.
    if (latestDraft.current !== undefined) {
      timer.current = setTimeout(
        () => void runValidation(collection, latestDraft.current, runToken, setIssues),
        VALIDATE_DEBOUNCE_MS,
      );
    }
  }, [resetKey, collection]);

  useEffect(() => {
    return () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, []);

  const notify = (values: unknown): void => {
    latestDraft.current = values;
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void runValidation(collection, latestDraft.current, runToken, setIssues);
    }, VALIDATE_DEBOUNCE_MS);
  };

  const flush = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    // the latest notified draft is the form's committed values — the blur
    // always follows the change that emitted them
    void runValidation(collection, latestDraft.current, runToken, setIssues);
  };

  return { issues, notify, flush };
}
