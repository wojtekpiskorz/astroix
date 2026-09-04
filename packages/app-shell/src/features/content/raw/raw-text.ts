import { parse, stringify } from 'yaml';

/**
 * The raw representation's text space (#252, J2; CONTEXT.md "raw
 * field"/"raw truth"): the entry's inspected values serialized as YAML
 * — the text the raw pane edits, and the space whose parse failures are
 * the validation lane's `parse` diagnostics.
 *
 * The roundtrip law this module owns: for every JSON-plain value tree
 * (the wire's space — the E4 payload arrives JSON-serialized, so
 * ISO-date strings and image metadata objects are strings and records
 * by the time they get here), `parseRawText(toRawText(v))` deep-equals
 * `v`. The property tests pin this. Values outside the JSON-plain
 * space (e.g. `undefined` — a cleared widget's emission) serialize as
 * the YAML `null` spelling: the raw space has no undefined, by design.
 */

/** One raw-text parse outcome — success carries the values, failure the sanitized message. */
export type RawParse =
  | { readonly ok: true; readonly values: unknown }
  | { readonly ok: false; readonly message: string };

/** The value tree as YAML text; absent/null trees start empty, not as `null`. */
export function toRawText(values: unknown): string {
  if (values === undefined || values === null) return '';
  const text = stringify(values);
  return typeof text === 'string' ? text.replace(/\n$/, '') : '';
}

/** Parses the raw text — cleared text is the empty draft (`{}`), never `null`. */
export function parseRawText(text: string): RawParse {
  if (text.trim() === '') return { ok: true, values: {} };
  try {
    return { ok: true, values: parse(text) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'invalid YAML' };
  }
}
