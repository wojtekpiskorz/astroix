/**
 * The content auto-write's serializer (spec Impl #9): the pure splice-writer
 * twin for entry files. The whole file is rebuilt per write — frontmatter
 * through the `yaml` package's Document API (comments, key order and quoting
 * of untouched nodes survive by construction), body as the raw string below
 * the closing `---`. Diffing runs in JSON space (draft vs the loaded
 * baseline, both raw-parse-shaped — #149's one truth-space): only differing
 * keys reach the Document, so untouched keys never touch their node; a
 * differing-on-paper value whose node already holds its JSON twin is left
 * alone too, so a stale baseline cannot churn untouched lines. The Document
 * API's own normalization is the accepted cost of a re-serialized block:
 * flow collections keep their style but respaced (`[a]` → `[ a ]`); block
 * content stays byte-identical.
 */
import { type Document, isCollection, isNode, parse, parseDocument } from 'yaml';

/**
 * The loaded state a write splices into — the raw file parse (the chrome's
 * truth-space since #149; the zod projection is display-only).
 */
export interface EntryBaseline {
  data: unknown;
  body: string;
}

/**
 * The pane's draft — the form values and the body editor's doc — and the
 * shape every truth in the write loop parses into.
 */
export interface EntryDraft {
  data: unknown;
  body: string;
}

/**
 * The raw file parse — one truth-space's both sides (#149): frontmatter
 * through the yaml package plus a JSON round-trip (yaml scalars land as
 * their JSON twins — Dates as ISO strings, the same space `serializeEntry`
 * compares nodes in), body trimmed (the payload's body space). Zod defaults
 * stay absent — they are widget-display, materializing only on touch. Null
 * when the frontmatter cannot parse.
 */
export function parseEntryDraft(contents: string): EntryDraft | null {
  try {
    const split = splitEntryFile(contents);
    const parsed = split.yaml === null ? {} : parse(split.yaml);
    return { data: JSON.parse(JSON.stringify(parsed)) ?? {}, body: split.body.trim() };
  } catch {
    return null;
  }
}

export interface SerializeEntryParams {
  /** The entry file's current bytes (the baseline the hash guard speaks for). */
  raw: string;
  baseline: EntryBaseline;
  draft: EntryDraft;
  /**
   * Dotted paths the write never touches: `image()` fields carry zod output
   * (ImageMetadata objects) in the draft, while the frontmatter value
   * round-trips byte-identical (spec Impl #4) — the write-side's skip list.
   */
  protectedPaths?: readonly string[];
}

/** An entry file split along its frontmatter delimiters. */
export interface EntryFileSplit {
  /** `---\n…\n---` verbatim, delimiters included — null when the file has none. */
  frontmatter: string | null;
  /** The yaml source between the delimiters; null only when `frontmatter` is. */
  yaml: string | null;
  /** The line ending after the closing `---` (`''` when it ends the file). */
  close: string;
  /** Everything after the closing delimiter line. */
  body: string;
}

// Lazy + optional separator so an empty frontmatter (`---\n---\n`) matches too.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---(\r?\n|$)/;

/** Splits an entry file into its frontmatter block and body. */
export function splitEntryFile(raw: string): EntryFileSplit {
  const match = raw.match(FRONTMATTER_RE);
  if (match === null) return { frontmatter: null, yaml: null, close: '', body: raw };
  const yaml = match[1] ?? '';
  const close = match[2] ?? '';
  const end = match[0].length - close.length;
  return {
    frontmatter: raw.slice(0, end),
    yaml,
    close,
    body: raw.slice(match[0].length),
  };
}

/**
 * Serializes the draft onto the raw baseline's bytes. Returns the input
 * unchanged when nothing differs — the write loop's no-op signal. Throws on
 * a frontmatter the Document API cannot parse (a hand-broken file on disk):
 * the caller surfaces an error instead of writing blind.
 */
export function serializeEntry({
  raw,
  baseline,
  draft,
  protectedPaths = [],
}: SerializeEntryParams): string {
  const split = splitEntryFile(raw);
  // null-normalized: a missing/null baseline reads as empty frontmatter
  // (astro parses such files to `data: {}`), and the form always holds an object
  const baseData = baseline.data ?? {};
  const draftData = draft.data ?? {};

  let doc: Document | null = null;
  if (!jsonEqual(baseData, draftData)) {
    const parsed = parseDocument(split.yaml ?? '');
    // every diff path may yet resolve to an equal node (a stale baseline
    // racing a disk change) — only a real splice re-serializes the block
    if (applyDraft(parsed, baseData, draftData, [], new Set(protectedPaths))) doc = parsed;
  }

  // astro serves the payload body trimmed; an edited body is re-anchored in
  // the file's own leading/trailing whitespace so writes stay byte-surgical
  const nextBody = draft.body === baseline.body ? null : anchorBody(split.body, draft.body);
  const bodyText = nextBody ?? split.body;
  // the body starts on its own line: a file whose closing `---` ends it (`''`)
  // gains the separator back whenever a non-empty body follows
  const separator = split.close !== '' || bodyText === '' ? split.close : '\n';
  if (doc === null) {
    if (nextBody === null) return raw;
    // body-only change: the frontmatter slice survives byte-identical
    return `${split.frontmatter ?? ''}${separator}${nextBody}`;
  }
  // re-serialized frontmatter: the Document's own '\n'-terminated output; a
  // file without a block gets one created, with '\n' as its closing ending
  const close = split.frontmatter === null ? '\n' : separator;
  return `---\n${doc.toString()}---${close}${bodyText}`;
}

/**
 * Re-anchors an edited body in the file's whitespace: the payload serves the
 * body trimmed, so the raw's leading run goes back in front and its trailing
 * run returns behind — unless the draft already ends with it (an untrimmed
 * baseline) — keeping body writes byte-surgical.
 */
function anchorBody(rawBody: string, draftBody: string): string {
  const lead = rawBody.slice(0, rawBody.length - rawBody.trimStart().length);
  let tail = rawBody.slice(rawBody.trimEnd().length);
  if (tail !== '' && draftBody.endsWith(tail)) tail = '';
  return `${lead}${draftBody}${tail}`;
}

/** Deep equality over JSON space (zod output never carries richer leaves). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => key in b && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splices the diff into the Document. Objects recurse key-wise (sibling
 * nodes stay untouched); everything else — scalars, arrays, type-divergent
 * subtrees — replaces whole. A node already holding the draft's value (in
 * the JSON projection — a `date:` node equals its ISO-string twin) is left
 * byte-identical, so a stale baseline cannot churn untouched lines.
 * `undefined` deletes: cleared widgets mean "no value", and the raw field's
 * cleared text emits `undefined` too.
 */
function applyDraft(
  doc: Document,
  baseline: unknown,
  draft: unknown,
  path: readonly string[],
  protectedPaths: ReadonlySet<string>,
): boolean {
  if (protectedPaths.has(path.join('.'))) return false;
  if (jsonEqual(baseline, draft)) return false;
  if (isPlainObject(baseline) && isPlainObject(draft)) {
    let touched = false;
    for (const key of Object.keys(baseline)) {
      if (!(key in draft)) {
        doc.deleteIn([...path, key]);
        touched = true;
      }
    }
    for (const [key, value] of Object.entries(draft)) {
      if (applyDraft(doc, baseline[key], value, [...path, key], protectedPaths)) touched = true;
    }
    return touched;
  }
  return setNode(doc, path, draft);
}

/** The node's value in the draft's JSON space (a yaml date reads as ISO). */
function nodeJson(doc: Document, node: unknown): unknown {
  if (node === undefined || node === null) return node;
  if (!isNode(node)) return node;
  const value = node.toJS(doc);
  if (value === undefined) return undefined;
  // the payload projection: Dates land as ISO strings, undefined keys drop
  return JSON.parse(JSON.stringify(value));
}

/**
 * Sets a whole value unless the node already holds it (byte-preservation for
 * equal values). Keeps the previous node's flow style for collections.
 */
function setNode(doc: Document, path: readonly string[], value: unknown): boolean {
  if (path.length === 0) {
    doc.contents = doc.createNode(value);
    return true;
  }
  if (value === undefined) {
    return doc.deleteIn(path);
  }
  const existing = doc.getIn(path, true);
  if (existing !== undefined && jsonEqual(nodeJson(doc, existing), value)) return false;
  const wasFlow = isCollection(existing) && existing.flow === true;
  const node = doc.createNode(value);
  if (wasFlow && isCollection(node)) node.flow = true;
  doc.setIn(path, node);
  return true;
}
