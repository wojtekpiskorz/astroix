import { z } from 'zod';

/**
 * Output hygiene for every public free-text field (ADR-0006 §7: "public
 * errors never disclose roots, ports, PIDs, environment values,
 * capabilities, or stacks"; ADR-0007 "Limits and output hygiene"). The
 * primary control is structural — the wire schemas are closed unions of
 * typed fields, so no field exists that could carry a root, a port, a
 * PID, an environment value, or a stack. This module is the second line
 * of defense: a disclosure-shape guard over the free text that does
 * appear (error messages, diagnostic messages, failure messages).
 *
 * The guard is deliberately shape-based, not semantic: it flags text that
 * *looks like* an absolute filesystem path, a Windows drive path, a stack
 * frame, a `node:internal` frame, or a PID reference. Sanitized prose
 * ("the project root is unavailable") passes; a leaked
 * `/Users/owner/projects/site` fails.
 */
const DISCLOSURE_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp; what: string }> = [
  {
    id: 'absolute-path',
    pattern: /(?:^|[\s"'`(=])\/(?:Users|home|var|tmp|etc|opt|private)\//,
    what: 'an absolute filesystem root',
  },
  { id: 'windows-path', pattern: /[A-Za-z]:[\\/]/, what: 'a Windows drive path' },
  { id: 'stack-frame', pattern: /(?:^|\n)\s*at\s+[^\n(]*\(/, what: 'a stack trace' },
  { id: 'node-internal', pattern: /\bnode:internal\//, what: 'a Node internals frame' },
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
