import { useState } from 'react';
import { parse, stringify } from 'yaml';
import { Textarea } from '#components/ui/textarea.tsx';
import type { FormFieldNode } from '../../../core/form-tree';
import { ArrayRows } from './array-rows';
import { CheckboxWidget, EnumWidget, NumberWidget, StringWidget } from './value-widgets';

/**
 * The widget dispatch the walked tree renders through — the leaf value
 * widgets (value-widgets.tsx) and the array rows (array-rows.tsx) live in
 * their own files; the tree renderer (schema-field.tsx) stays a separate
 * concern. The raw field lives here: a dispatch case, not a shared primitive.
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
