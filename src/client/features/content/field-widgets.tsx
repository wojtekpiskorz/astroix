import { useState } from 'react';
import { parse, stringify } from 'yaml';
import { Button } from '#components/ui/button.tsx';
import { Checkbox } from '#components/ui/checkbox.tsx';
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
 * The widget set the walked tree renders — one file so the dispatch (this
 * file) and the tree renderer (schema-field.tsx) stay separate concerns and
 * full-size fields and array rows share the same primitives.
 */

interface FieldWidgetProps {
  node: Exclude<FormFieldNode, { kind: 'group' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  issues: Record<string, string>;
  /** Associates the widget's control with its FieldLabel (a11y). */
  id?: string;
  /** The projection value for read-only display (image kind only, #149). */
  display?: unknown;
}

/**
 * The zod default as widget text (#149's widget-display ruling): visible in
 * the widget while `values` stay absent — placeholder semantics, the key
 * materializes only when the field is touched.
 */
function defaultText(node: Exclude<FormFieldNode, { kind: 'group' }>): string | undefined {
  return node.initial === undefined || node.initial === null ? undefined : String(node.initial);
}

/** Pure dispatch over the walked node's kind — the widgets own their behavior. */
export function FieldWidget({ node, value, onChange, issues, id, display }: FieldWidgetProps) {
  switch (node.kind) {
    case 'string':
      return (
        <StringWidget id={id} value={value} onChange={onChange} placeholder={defaultText(node)} />
      );
    case 'number':
      return (
        <NumberWidget id={id} value={value} onChange={onChange} placeholder={defaultText(node)} />
      );
    case 'boolean':
      return (
        <CheckboxWidget
          label={node.label}
          value={value}
          onChange={onChange}
          initial={node.initial}
        />
      );
    case 'enum':
      return (
        <EnumWidget
          id={id}
          options={node.options}
          value={value}
          onChange={onChange}
          placeholder={defaultText(node) ?? '—'}
        />
      );
    case 'image':
      return <ImageMeta value={display ?? value} />;
    case 'array':
      return <ArrayRows node={node} value={value} onChange={onChange} issues={issues} />;
    case 'raw':
      return <RawField id={id} node={node} value={value} onChange={onChange} />;
  }
}

interface ValueWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
  /** The zod default shown while the value is absent (#149 widget-display). */
  placeholder?: string;
  /** Names the control when its label is a group, not a single field (array rows). */
  ariaLabel?: string;
}

/** A string field — any non-string display value stringifies rather than lying. */
function StringWidget({ value, onChange, id, ariaLabel, placeholder }: ValueWidgetProps) {
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      value={typeof value === 'string' ? value : value == null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A number field: cleared input means `undefined` (a required number then
 * shows its real issue), a non-numeric intermediate degrades the same way
 * instead of inventing NaN into the draft.
 */
function NumberWidget({ value, onChange, id, ariaLabel, placeholder }: ValueWidgetProps) {
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type="number"
      value={value == null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(event) => onChange(numberFromInput(event.target.value))}
    />
  );
}

function numberFromInput(text: string): number | undefined {
  if (text === '') return undefined;
  const parsed = Number(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function CheckboxWidget({
  label,
  value,
  onChange,
  initial,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The zod default displayed while the value is absent (#149 widget-display). */
  initial?: unknown;
}) {
  return (
    <Checkbox
      aria-label={label}
      // widget-display: an absent key renders its default checked-state —
      // display-only, the touch materializes the value either way
      checked={value === undefined ? Boolean(initial) : Boolean(value)}
      onCheckedChange={(checked) => onChange(Boolean(checked))}
    />
  );
}

interface EnumWidgetProps extends ValueWidgetProps {
  options: (string | number)[];
}

function EnumWidget({ options, value, onChange, id, ariaLabel, placeholder }: EnumWidgetProps) {
  return (
    <Select
      items={options.map((option) => ({ value: option, label: String(option) }))}
      value={value == null ? null : value}
      onValueChange={(selected) => onChange(selected)}
    >
      <SelectTrigger id={id} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
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
  ariaLabel,
}: {
  item: { kind: 'string' | 'number' | 'boolean' | 'enum'; options?: (string | number)[] };
  value: unknown;
  onChange: (value: unknown) => void;
  ariaLabel: string;
}) {
  switch (item.kind) {
    case 'string':
      return <StringWidget ariaLabel={ariaLabel} value={value} onChange={onChange} />;
    case 'number':
      return <NumberWidget ariaLabel={ariaLabel} value={value} onChange={onChange} />;
    case 'boolean':
      return <CheckboxWidget label={ariaLabel} value={value} onChange={onChange} />;
    case 'enum':
      return (
        <EnumWidget
          ariaLabel={ariaLabel}
          options={item.options ?? []}
          value={value}
          onChange={onChange}
        />
      );
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
  // an absent key renders no rows — the common `default([])` displays
  // naturally; a non-empty array default is not phantom-rendered (its rows
  // materialize only through the Add button)
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
              ariaLabel={`${node.label} ${index + 1}`}
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
export function RawField({
  node,
  value,
  onChange,
  id,
  ariaLabel,
}: {
  node: Extract<FormFieldNode, { kind: 'raw' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  id?: string;
  /** Names the control when its label is not a sibling (the root raw field). */
  ariaLabel?: string;
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
        id={id}
        aria-label={ariaLabel}
        data-astroix-raw-field={node.path}
        data-astroix-raw-reason={node.reason}
        value={text}
        placeholder={
          value === undefined && node.initial != null ? rawTextFrom(node.initial) : undefined
        }
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
