import { Checkbox } from '#components/ui/checkbox.tsx';
import { Input } from '#components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select.tsx';

/**
 * The leaf value widgets the widget dispatch (field-widgets.tsx) and the
 * array rows (array-rows.tsx) render — one file so full-size fields and
 * repeatable rows share the same primitives.
 */

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
export function StringWidget({ value, onChange, id, ariaLabel, placeholder }: ValueWidgetProps) {
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
export function NumberWidget({ value, onChange, id, ariaLabel, placeholder }: ValueWidgetProps) {
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

export function CheckboxWidget({
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

export function EnumWidget({
  options,
  value,
  onChange,
  id,
  ariaLabel,
  placeholder,
}: EnumWidgetProps) {
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
