import { useForm, useStore } from '@tanstack/react-form';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { FormFieldNode, ValidationIssueRecord } from '../../../core/form-tree';
import { validateDraft } from './api';
import { SchemaField } from './schema-field';

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
 * values effect can close over; `token` (the caller's run counter) drops
 * stale responses — typing outruns the roundtrips.
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

interface ContentFormProps {
  collection: string;
  fields: FormFieldNode[];
  /** The entry's parsed data (zod output — defaults already filled) as loaded. */
  entryData: unknown;
  /**
   * The draft values seam for #74's write loop (the form-side twin of the
   * body editor's `onChange`): fires on every change with the whole draft.
   * Raw paths carry parsed values; the YAML text stays widget-local.
   */
  onValuesChange: (values: unknown) => void;
}

/**
 * The schema-generated form (spec US10): one TanStack Form over the entry's
 * data, fields rendered from the walked tree. Validation is the advisory
 * loop — debounced POST safeParse against the collection's own schema,
 * issues inline per field — and gates nothing: there is no save to gate
 * (US12; #74's auto-write never checks these issues either).
 */
export function ContentForm({ collection, fields, entryData, onValuesChange }: ContentFormProps) {
  const form = useForm({ defaultValues: entryData as Record<string, unknown> });
  const values = useStore(form.store, (state) => state.values);
  const [issues, setIssues] = useState<Record<string, string>>({});

  // latest-callback refs — render-time ref writes don't survive Compiler replay
  const onValuesChangeRef = useRef(onValuesChange);
  useEffect(() => {
    onValuesChangeRef.current = onValuesChange;
  }, [onValuesChange]);

  // only the latest run may land issues
  const runToken = useRef(0);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // the values effect covers mount too: the initial draft emits through the
  // seam once and the debounced baseline validation runs against it
  useEffect(() => {
    onValuesChangeRef.current(values);
    const timer = setTimeout(() => {
      void runValidation(collection, values, runToken, setIssues);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [collection, values]);

  const flushValidation = (): void => {
    void runValidation(collection, valuesRef.current, runToken, setIssues);
  };

  return (
    <form
      data-astroix-content-form={collection}
      className="flex flex-col gap-4 px-3 py-3"
      onSubmit={(event) => event.preventDefault()}
    >
      {fields.map((node) => (
        <SchemaField
          key={node.path}
          node={node}
          form={form}
          issues={issues}
          onFlushValidation={flushValidation}
        />
      ))}
    </form>
  );
}
