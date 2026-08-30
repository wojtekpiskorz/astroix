import { Button } from '#components/ui/button.tsx';
import type { FormFieldNode } from '../../../core/form-tree';
import { CheckboxWidget, EnumWidget, NumberWidget, StringWidget } from './value-widgets';

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
export function ArrayRows({
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
