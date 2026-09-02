import { useForm, useStore } from '@tanstack/react-form';
import { useEffect, useRef } from 'react';
import type { FormFieldNode } from '../../../core/src/form-tree';
import { RawField } from './field-widgets';
import { SchemaField } from './schema-field';
import type { ValidationIssueMap } from './types';

/**
 * The schema-generated form (spec US10, #219 lane C2): one TanStack Form over
 * the entry's raw-parse data, fields rendered from the walked tree. The pane
 * remounts this component on every accepted truth change (keyed by the
 * truth's seq), so the values never need an external-sync guard — they mount
 * on the truth and change only through widgets (#149 retired the
 * projection-reset path the guard carried).
 *
 * Validation is advisory and lives OUTSIDE (US11/US12): the widget renders
 * the issues it is handed and reports draft changes and blur flushes; the
 * owner runs the debounced safeParse roundtrip — the write loop never
 * consults the issues either.
 */

interface ContentFormProps {
  collection: string;
  fields: FormFieldNode[];
  /**
   * The entry's raw-parse data — the form's one truth-space (#149): the
   * values hold exactly what the file parses to; zod defaults stay absent
   * until their field is touched (widgets display them, the write
   * materializes them).
   */
  entryData: unknown;
  /**
   * The payload's zod projection, display-only: transform outputs the raw
   * parse cannot produce (image() metadata) still render read-only; the
   * values never adopt them.
   */
  projectionData: unknown;
  /**
   * Inline advisory-validation issues by dotted path (validation display):
   * rendered per field, gate nothing — the roundtrip that produces them
   * stays with the owner.
   */
  issues: ValidationIssueMap;
  /**
   * The draft values seam for #74's write loop (the form-side twin of the
   * body editor's `onChange`): fires on every change with the whole draft.
   * Raw paths carry parsed values; the YAML text stays widget-local.
   */
  onValuesChange: (values: unknown) => void;
  /**
   * Edit intent: any widget losing focus asks the owner to validate NOW,
   * ahead of the debounce.
   */
  onFlushValidation: () => void;
}

export function ContentForm({
  collection,
  fields,
  entryData,
  projectionData,
  issues,
  onValuesChange,
  onFlushValidation,
}: ContentFormProps) {
  const form = useForm({ defaultValues: entryData as Record<string, unknown> });
  const values = useStore(form.store, (state) => state.values);

  // latest-callback refs — render-time ref writes don't survive Compiler replay
  const onValuesChangeRef = useRef(onValuesChange);
  useEffect(() => {
    onValuesChangeRef.current = onValuesChange;
  }, [onValuesChange]);

  // the values effect covers mount too: the initial draft emits through the
  // seam once, and the owner's debounced validation runs against it
  useEffect(() => {
    onValuesChangeRef.current(values);
  }, [values]);

  // the root raw field is the whole draft, not a path into it — TanStack's
  // `makePathArray('')` reads a phantom `''` key, so it never goes through
  // form.Field: the parsed YAML replaces the values object itself
  const rootRaw =
    fields.length === 1 && fields[0]?.kind === 'raw' && fields[0].path === '' ? fields[0] : null;

  return (
    <form
      data-astroix-content-form={collection}
      className="flex flex-col gap-4 px-3 py-3"
      onSubmit={(event) => event.preventDefault()}
    >
      {rootRaw !== null ? (
        <RawField
          node={rootRaw}
          value={values}
          ariaLabel={rootRaw.label}
          onChange={(next) =>
            // `?? {}`: cleared root text means an empty draft — reset with
            // undefined would fall back to defaultValues (form-core), and the
            // draft would silently keep the frontmatter the textarea no
            // longer shows (round 3). `keepDefaultValues`: a bare reset
            // overwrites the form's defaultValues with the draft, and the
            // next render's update() would then "re-initialize" the form
            // back to the loaded entryData — silently reverting the edit
            form.reset((next ?? {}) as Record<string, unknown>, { keepDefaultValues: true })
          }
        />
      ) : (
        fields.map((node) => (
          <SchemaField
            key={node.path}
            node={node}
            form={form}
            issues={issues}
            onFlushValidation={onFlushValidation}
            projectionData={projectionData}
          />
        ))
      )}
    </form>
  );
}
