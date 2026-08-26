/**
 * A single text edit: replace the half-open range `[start, end)` of the file
 * content with `replacement`. Zero-length ranges insert purely. The editor
 * debounces and sends one edit at a time — this is the only write primitive.
 */
export interface SpliceEdit {
  start: number;
  end: number;
  replacement: string;
}

/** Thrown for ranges that do not fit the content — never produces partial output. */
export class SpliceRangeError extends Error {
  constructor(start: number, end: number, contentLength: number) {
    super(`Invalid splice range [${start}, ${end}) for content of length ${contentLength}`);
    this.name = 'SpliceRangeError';
  }
}

/**
 * The splice-writer primitive: (content, range, replacement) → new content.
 * Text-splice only — never reprints the file. Every byte outside the replaced
 * range stays identical, so formatting, comments and agent conventions
 * survive and the git diff is minimal.
 */
export function spliceText(content: string, edit: SpliceEdit): string {
  const { start, end, replacement } = edit;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > content.length ||
    start > end
  ) {
    throw new SpliceRangeError(start, end, content.length);
  }
  return content.slice(0, start) + replacement + content.slice(end);
}

/**
 * Append a rule at EOF with exactly one added line, regardless of whether the
 * original ends with a newline (no accidental blank runs; the file's
 * trailing-newline convention is preserved).
 */
export function appendRule(content: string, rule: string): string {
  if (content === '') {
    return rule;
  }
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content : `${content}\n`;
  return `${body}${rule}${endsWithNewline ? '\n' : ''}`;
}
