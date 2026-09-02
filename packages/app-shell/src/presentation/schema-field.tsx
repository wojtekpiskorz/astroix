import { useForm } from '@tanstack/react-form';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '#components/ui/field.tsx';
import { FieldWidget } from './field-widgets';
import type { FormFieldNode } from './types';

/**
 * The app shell's value draft: TanStack Form's store — raw paths hold the
 * subtree as a parsed value; the YAML text itself lives in the raw widget's
 * local state (#74 serializes the store, never the text). The type is the
 * exact `useForm` return for a record draft (an instantiation-expression
 * helper below keeps it locked to the real API instead of re-declaring
 * twelve generics).
 */
export type ContentDraftForm = ReturnType<typeof useFormDraft>;

/** `useForm` narrowed to the record draft — the named type the widgets consume. */
function useFormDraft(options: { defaultValues: Record<string, unknown> }) {
  return useForm(options);
}

/** Kinds whose widget is one focusable control the label can point at. */
function hasLabelControl(node: FormFieldNode): boolean {
  return (
    node.kind === 'string' || node.kind === 'number' || node.kind === 'enum' || node.kind === 'raw'
  );
}

interface SchemaFieldProps {
  node: FormFieldNode;
  form: ContentDraftForm;
  /** Inline validation issues by dotted path — advisory, never gating (US11/12). */
  issues: Record<string, string>;
  /** Blur flush: validation runs immediately, ahead of the debounce. */
  onFlushValidation: () => void;
  /**
   * The payload's zod projection (#149, display-only): image() widgets read
   * their resolved metadata from it — the raw parse carries only the file's
   * path string, and the values never adopt the projection.
   */
  projectionData: unknown;
}

/** Reads a dotted path out of a plain-object tree (the image display lookup). */
function pickPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Renders one walked schema node with its widget — recursion happens at groups. */
export function SchemaField({
  node,
  form,
  issues,
  onFlushValidation,
  projectionData,
}: SchemaFieldProps) {
  if (node.kind === 'group') {
    return (
      <FieldSet data-astroix-form-field={node.path} className="gap-3">
        <FieldLegend variant="label">
          {node.label}
          {node.required ? ' *' : ''}
        </FieldLegend>
        {node.children.map((child) => (
          <SchemaField
            key={child.path}
            node={child}
            form={form}
            issues={issues}
            onFlushValidation={onFlushValidation}
            projectionData={projectionData}
          />
        ))}
      </FieldSet>
    );
  }

  // label→control association: one id per single-control field; group-ish
  // kinds (boolean, array, image) name their controls through aria-label
  const fieldId = `astroix-field-${node.path}`;

  return (
    // onBlurCapture: any widget losing focus validates now, not on the debounce
    <div onBlurCapture={onFlushValidation}>
      <form.Field name={node.path}>
        {(field) => (
          <Field data-astroix-form-field={node.path} className="group/field">
            <FieldLabel className="text-xs" htmlFor={hasLabelControl(node) ? fieldId : undefined}>
              {node.label}
              {node.required ? ' *' : ''}
            </FieldLabel>
            <FieldWidget
              node={node}
              value={field.state.value}
              onChange={field.handleChange}
              issues={issues}
              id={hasLabelControl(node) ? fieldId : undefined}
              display={node.kind === 'image' ? pickPath(projectionData, node.path) : undefined}
            />
            <FieldError data-astroix-field-issue={node.path}>{issues[node.path]}</FieldError>
          </Field>
        )}
      </form.Field>
    </div>
  );
}
