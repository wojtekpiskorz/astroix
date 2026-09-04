import type { FormFieldNode } from '../../../../../core/src/form-tree.ts';
import { RawField } from '../../../presentation/field-widgets.tsx';

/**
 * The unknown-fields section (#252, J2): the explicit raw
 * representation of every inspected value key no walked field claims —
 * the AC's "unknown field shapes" surface. Rendered through the
 * retained `RawField` widget (the presentation layer's raw-field
 * convention) under a synthetic node: the section is a widget host, not
 * a new widget. The parsed report goes up; the owner merges it back
 * into the draft (unknown fields never leave the draft).
 */

/** The synthetic raw node the section renders under — a display identity, never a walked path. */
const UNKNOWN_NODE: Extract<FormFieldNode, { kind: 'raw' }> = {
  kind: 'raw',
  path: '__unknown__',
  label: 'unknown fields',
  required: false,
  reason: 'not declared by the collection schema',
};

/** Reads the section as text for the empty check — any nonempty record renders. */
function hasEntries(part: Record<string, unknown>): boolean {
  return Object.keys(part).length > 0;
}

export function UnknownFieldsSection({
  unknownPart,
  onUnknownPart,
}: {
  /** The unclaimed half of the draft values. */
  readonly unknownPart: Record<string, unknown>;
  /** The section's parsed report — the whole unclaimed half, replaced wholesale. */
  readonly onUnknownPart: (part: Record<string, unknown>) => void;
}) {
  if (!hasEntries(unknownPart)) return null;
  return (
    <div data-astroix-unknown-fields className="flex flex-col">
      <RawField
        node={UNKNOWN_NODE}
        value={unknownPart}
        ariaLabel="unknown fields"
        onChange={(parsed) => onUnknownPart((parsed ?? {}) as Record<string, unknown>)}
      />
    </div>
  );
}
