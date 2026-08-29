import { useForm } from '@tanstack/react-form';
import { useState } from 'react';
import { parse, stringify } from 'yaml';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '#components/ui/field.tsx';
import { Input } from '#components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select.tsx';
import { Textarea } from '#components/ui/textarea.tsx';
import type { FormFieldNode } from '../../../core/form-tree';

/**
 * The chrome's value draft: TanStack Form's store — raw paths hold the
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

interface SchemaFieldProps {
  node: FormFieldNode;
  form: ContentDraftForm;
  /** Inline validation issues by dotted path — advisory, never gating (US11/12). */
  issues: Record<string, string>;
  /** Blur flush: validation runs immediately, ahead of the debounce. */
  onFlushValidation: () => void;
}

/** Renders one walked schema node with its widget — recursion happens at groups. */
export function SchemaField({ node, form, issues, onFlushValidation }: SchemaFieldProps) {
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
          />
        ))}
      </FieldSet>
    );
  }

  return (
    // onBlurCapture: any widget losing focus validates now, not on the debounce
    <div onBlurCapture={onFlushValidation}>
      <form.Field name={node.path}>
        {(field) => (
          <Field data-astroix-form-field={node.path} className="group/field">
            <FieldLabel className="text-xs">
              {node.label}
              {node.required ? ' *' : ''}
            </FieldLabel>
            <FieldWidget
              node={node}
              value={field.state.value}
              onChange={field.handleChange}
              issues={issues}
            />
            <FieldError data-astroix-field-issue={node.path}>{issues[node.path]}</FieldError>
          </Field>
        )}
      </form.Field>
    </div>
  );
}

interface FieldWidgetProps {
  node: Exclude<FormFieldNode, { kind: 'group' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  issues: Record<string, string>;
}

/** Pure dispatch over the walked node's kind — the widgets own their behavior. */
function FieldWidget({ node, value, onChange, issues }: FieldWidgetProps) {
  switch (node.kind) {
    case 'string':
      return <StringWidget value={value} onChange={onChange} />;
    case 'number':
      return <NumberWidget value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <Checkbox
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
      );
    case 'enum':
      return <EnumWidget options={node.options} value={value} onChange={onChange} />;
    case 'image':
      return <ImageMeta value={value} />;
    case 'array':
      return <ArrayRows node={node} value={value} onChange={onChange} issues={issues} />;
    case 'raw':
      return <RawField node={node} value={value} onChange={onChange} />;
  }
}

interface ValueWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
}

/** A string field — any non-string display value stringifies rather than lying. */
function StringWidget({ value, onChange }: ValueWidgetProps) {
  return (
    <Input
      value={typeof value === 'string' ? value : value == null ? '' : String(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A number field: cleared input means `undefined` (a required number then
 * shows its real issue), a non-numeric intermediate degrades the same way
 * instead of inventing NaN into the draft.
 */
function NumberWidget({ value, onChange }: ValueWidgetProps) {
  return (
    <Input
      type="number"
      value={value == null ? '' : String(value)}
      onChange={(event) => onChange(numberFromInput(event.target.value))}
    />
  );
}

function numberFromInput(text: string): number | undefined {
  if (text === '') return undefined;
  const parsed = Number(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface EnumWidgetProps extends ValueWidgetProps {
  options: (string | number)[];
}

function EnumWidget({ options, value, onChange }: EnumWidgetProps) {
  return (
    <Select
      items={options.map((option) => ({ value: option, label: String(option) }))}
      value={value == null ? null : value}
      onValueChange={(selected) => onChange(selected)}
    >
      <SelectTrigger>
        <SelectValue placeholder="—" />
      </SelectTrigger>
      <SelectContent
        // `.dark` re-scope: Base UI portals the popup into document.body,
        // outside the shadow root — same finding as the smoke dialog (#46);
        // the adopted sheet carries the token block document-wide (T1)
        className="dark"
      >
        {options.map((option) => (
          <SelectItem key={String(option)} value={option}>
            {String(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** `image()` metadata — read-only display (spec Impl #4; the picker is deferred). */
function ImageMeta({ value }: { value: unknown }) {
  const meta = (value ?? {}) as { src?: unknown; width?: unknown; height?: unknown };
  const rows = (
    [
      ['src', meta.src],
      ['width', meta.width],
      ['height', meta.height],
    ] as const
  ).filter(([, cell]) => cell !== undefined && cell !== null);
  if (rows.length === 0) {
    return (
      <p data-astroix-image-field="empty" className="text-xs text-muted-foreground">
        no image data
      </p>
    );
  }
  return (
    <dl
      data-astroix-image-field="meta"
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
    >
      {rows.map(([key, cell]) => (
        <div key={key} className="flex gap-2">
          <dt className="w-12 shrink-0">{key}</dt>
          <dd className="truncate font-mono">{String(cell)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One repeatable row's widget — same primitives as full-size fields. */
function RowWidget({
  item,
  value,
  onChange,
}: {
  item: { kind: 'string' | 'number' | 'boolean' | 'enum'; options?: (string | number)[] };
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (item.kind) {
    case 'string':
      return <StringWidget value={value} onChange={onChange} />;
    case 'number':
      return <NumberWidget value={value} onChange={onChange} />;
    case 'boolean':
      return (
        <Checkbox
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
        />
      );
    case 'enum':
      return <EnumWidget options={item.options ?? []} value={value} onChange={onChange} />;
  }
}

/** Repeatable rows for arrays of primitives; anything else walked to raw. */
function ArrayRows({
  node,
  value,
  onChange,
  issues,
}: {
  node: Extract<FormFieldNode, { kind: 'array' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  issues: Record<string, string>;
}) {
  const rows = Array.isArray(value) ? value : [];

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: repeatable rows are positional values (controlled inputs, no per-row state) — removal shifting indices IS the identity change
        <div key={`${node.path}.${index}`} className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1" data-astroix-form-field={`${node.path}.${index}`}>
            <RowWidget
              item={node.item}
              value={row}
              onChange={(next) =>
                onChange(rows.map((current, at) => (at === index ? next : current)))
              }
            />
            {issues[`${node.path}.${index}`] !== undefined && (
              <p
                data-astroix-field-issue={`${node.path}.${index}`}
                className="text-xs text-destructive"
              >
                {issues[`${node.path}.${index}`]}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${node.label} row ${index + 1}`}
            data-astroix-array-remove={index}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="w-fit"
        data-astroix-array-add={node.path}
        onClick={() => onChange([...rows, defaultRowItem(node.item)])}
      >
        Add {node.label} row
      </Button>
    </div>
  );
}

/** The value a fresh row starts with, per the item's kind. */
function defaultRowItem(item: {
  kind: 'string' | 'number' | 'boolean' | 'enum';
  options?: (string | number)[];
}): unknown {
  switch (item.kind) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return item.options?.[0] ?? '';
  }
}

/**
 * The raw field (glossary): the unsupported subtree as clearly-marked,
 * editable YAML. The draft carries the parsed value; a YAML syntax error
 * stays local to this widget as an inline issue — never blocking (US12).
 */
function RawField({
  node,
  value,
  onChange,
}: {
  node: Extract<FormFieldNode, { kind: 'raw' }>;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => rawTextFrom(value));
  const [syntaxIssue, setSyntaxIssue] = useState<string | null>(null);

  const handleText = (next: string): void => {
    setText(next);
    if (next.trim() === '') {
      setSyntaxIssue(null);
      onChange(undefined);
      return;
    }
    try {
      onChange(parse(next));
      setSyntaxIssue(null);
    } catch (error) {
      setSyntaxIssue(error instanceof Error ? error.message : 'invalid YAML');
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <Textarea
        data-astroix-raw-field={node.path}
        data-astroix-raw-reason={node.reason}
        value={text}
        onChange={(event) => handleText(event.target.value)}
        spellCheck={false}
        className="min-h-16 font-mono text-xs"
      />
      <p className="text-[10px] text-muted-foreground">
        raw field — unsupported schema node ({node.reason}), edited as YAML
      </p>
      {syntaxIssue !== null && (
        <p data-astroix-field-issue={node.path} className="text-xs text-destructive">
          YAML: {syntaxIssue}
        </p>
      )}
    </div>
  );
}

/** The subtree as YAML text; absent subtrees start empty, not as `null`. */
function rawTextFrom(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = stringify(value);
  return typeof text === 'string' ? text.replace(/\n$/, '') : '';
}
