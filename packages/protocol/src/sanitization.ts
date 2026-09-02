import { z } from 'zod';

/**
 * Output hygiene for every public free-text field (ADR-0006 §7: "public
 * errors never disclose roots, ports, PIDs, environment values,
 * capabilities, or stacks"; ADR-0007 "Limits and output hygiene"). The
 * primary control is structural — the wire schemas are closed unions of
 * typed fields, so no field exists that could carry a root, a port, a
 * PID, an environment value, or a stack. This module is the second line
 * of defense: a disclosure-shape guard over the free text that does
 * appear (error messages, diagnostic messages, failure messages, display
 * names).
 *
 * The guard is deliberately shape-based, not semantic, and fails closed:
 * it flags text that *looks like* any POSIX absolute path (a slash-rooted
 * segment pair, wherever it sits — `/Users/…`, `/srv/…`, `/mnt/…`), a
 * home-relative path (`~/…`), a Windows drive path (`C:\\…`, `D:/…`), a
 * UNC path (`\\\\server\\share`), a stack frame, a `node:internal`
 * frame, or a PID reference. Sanitized prose ("the project root is
 * unavailable") passes; prose merely containing slashes without an
 * absolute shape ("and/or", "1/2") passes too.
 */
// Order matters for reporting precision: a stack frame's `(/app/x.js:1:2)`
// tail also carries an absolute-path shape, and the more specific finding
// wins. Detection itself is order-independent — every pattern runs.
const DISCLOSURE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; what: string }> = [
  { id: 'stack-frame', pattern: /(?:^|\n)\s*at\s+[^\n(]*\(/, what: 'a stack trace' },
  { id: 'node-internal', pattern: /\bnode:internal\//, what: 'a Node internals frame' },
  // windows-drive precedes absolute-path on purpose: the colon boundary
  // added to the absolute guard would otherwise claim `D:/dev/site` before
  // the more specific drive-letter finding wins
  { id: 'windows-path', pattern: /[A-Za-z]:[\\/]/, what: 'a Windows drive path' },
  {
    id: 'absolute-path',
    pattern: /(?:^|[\s"'`(=:])\/[a-z][^/\s]*\//i,
    what: 'an absolute filesystem path',
  },
  { id: 'home-relative-path', pattern: /(?:^|[\s"'`(=:])~\//, what: 'a home-relative path' },
  { id: 'unc-path', pattern: /\\\\[^\\/\s]+[\\/]/, what: 'a UNC path' },
  { id: 'pid', pattern: /\bpid\b\s*[:=]?\s*\d+/i, what: 'a process id' },
];

/**
 * The first disclosure shape found in `text`, or `null` when the text is
 * shape-clean. Returns the pattern id (not the matched bytes) so callers
 * can report the finding without echoing the potential leak.
 */
export function findDisclosure(text: string): string | null {
  for (const { id, pattern } of DISCLOSURE_PATTERNS) {
    if (pattern.test(text)) return id;
  }
  return null;
}

/**
 * The schema of every public free-text field: non-empty and free of
 * disclosure shapes. Field byte budgets come from the envelope limits
 * (ADR-0006 §7), not from an invented per-field cap.
 */
export const sanitizedTextSchema = z.string().superRefine((text, ctx) => {
  if (text.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'public text must not be empty' });
    return;
  }
  const disclosure = findDisclosure(text);
  if (disclosure !== null) {
    ctx.addIssue({
      code: 'custom',
      message: `public text may not disclose ${disclosure} (ADR-0006 §7 output hygiene)`,
    });
  }
});
