import { extractStylesSync } from '@astrojs/compiler-binding';
import postcss from 'postcss';

/** A project CSS source to index: path + raw contents. No IO happens here. */
export interface SourceFile {
  file: string;
  contents: string;
}

/**
 * One rule from the edit-truth index. The range is in character offsets of
 * `file` and covers the rule from its selector through the closing brace
 * (end-exclusive) — the splice-writer edits inside these bounds.
 */
export interface CssRuleRecord {
  /** Selector text verbatim from source (source space — no cid synthesis here). */
  selector: string;
  file: string;
  range: { start: number; end: number };
  /**
   * One-based line of the rule's selector in `file`, derived from the range
   * at index time (the indexer holds the contents) — the rule list shows it.
   */
  line: number;
  /** Condition of the nearest `@media` ancestor, or null at the top level. */
  media: string | null;
  /** True for rules from a scoped `<style>` block (the compiler applies the cid). */
  scoped: boolean;
  /**
   * Zero-based style-block index correlating with the module-graph module id
   * `{file}.astro?astro&type=style&index={N}` — the join key for the index
   * payload. Null when the block is not in the module graph (`is:inline`).
   */
  styleBlockIndex: number | null;
}

interface BlockMeta {
  scoped: boolean;
  styleBlockIndex: number | null;
  baseOffset: number;
}

const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

/**
 * The indexer: scans project CSS sources into the edit-truth index
 * (selector → file, source range, media condition). Dev generates no CSS
 * sourcemaps, so this static scan is the only mapping to what's on disk —
 * and the only one that sees `is:inline` blocks.
 */
export function buildCssIndex(sources: SourceFile[]): CssRuleRecord[] {
  const records: CssRuleRecord[] = [];
  for (const source of sources) {
    const fileRecords = source.file.endsWith('.css')
      ? indexStylesheet(source.file, source.contents, {
          scoped: false,
          styleBlockIndex: null,
          baseOffset: 0,
        })
      : source.file.endsWith('.astro')
        ? indexAstroStyles(source.file, source.contents)
        : [];
    // Lines derive from absolute offsets against the whole file — the .astro
    // blocks were parsed as substrings but carry absolute ranges.
    for (const record of fileRecords) {
      records.push({ ...record, line: lineAt(source.contents, record.range.start) });
    }
  }
  return records;
}

/** One-based line number of a character offset. */
function lineAt(contents: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < contents.length; i++) {
    if (contents[i] === '\n') line += 1;
  }
  return line;
}

function indexStylesheet(
  file: string,
  css: string,
  meta: BlockMeta,
): Omit<CssRuleRecord, 'line'>[] {
  const records: Omit<CssRuleRecord, 'line'>[] = [];
  postcss.parse(css).walkRules((rule) => {
    const start = rule.source?.start;
    const end = rule.source?.end;
    if (start === undefined || end === undefined) return;
    records.push({
      selector: rule.selector,
      file,
      range: { start: start.offset + meta.baseOffset, end: end.offset + meta.baseOffset },
      media: nearestMediaCondition(rule),
      scoped: meta.scoped,
      styleBlockIndex: meta.styleBlockIndex,
    });
  });
  return records;
}

function indexAstroStyles(file: string, source: string): Omit<CssRuleRecord, 'line'>[] {
  const records: Omit<CssRuleRecord, 'line'>[] = [];
  // extractStylesSync returns only blocks the compiler would process —
  // `is:inline` (and expression-attribute blocks) never make it there, so the
  // raw tag scan is the edit-truth pass and the compiler blocks supply the
  // module-graph index.
  const processed = extractStylesSync(source);
  let next = 0;

  for (const match of source.matchAll(STYLE_TAG)) {
    const content = match[1];
    if (content === undefined) continue;
    const openTag = match[0].slice(0, match[0].indexOf('>') + 1);
    const contentStart = match.index + openTag.length;

    const compilerBlock = processed[next];
    if (compilerBlock !== undefined && compilerBlock.content === content) {
      next += 1;
      records.push(
        ...indexStylesheet(file, content, {
          scoped: compilerBlock.attrs['is:global'] === undefined,
          styleBlockIndex: compilerBlock.index,
          baseOffset: contentStart,
        }),
      );
    } else {
      records.push(
        ...indexStylesheet(file, content, {
          scoped: false,
          styleBlockIndex: null,
          baseOffset: contentStart,
        }),
      );
    }
  }
  return records;
}

function nearestMediaCondition(node: postcss.Node): string | null {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (parent.type !== 'atrule') continue;
    const atRule = parent as postcss.AtRule;
    if (atRule.name === 'media') {
      return atRule.params;
    }
  }
  return null;
}
