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
 * letter-led segment pair, wherever it sits — `/Users/…`, `/srv/…`,
 * `/mnt/…`, including composed after a version or package handle:
 * `astro@7.3.0/Users/…`, `astro@/Users/…`, `@24/bin/node`), a
 * home-relative path (`~/…`, likewise composed: `7.3.0~/dev/…`), a
 * Windows drive path (`C:\\…`, `D:/…`), a UNC path (`\\\\server\\share`),
 * a stack frame, a `node:internal` frame, a PID or port reference, or an
 * environment value. Sanitized prose ("the project root is
 * unavailable") passes; prose merely containing slashes without an
 * absolute shape ("and/or", "1/2", "2026/09/03", "24/7") passes too.
 *
 * The two poles of the discipline (#352 ruling): this pattern is the
 * structural pole over composed free-form text — its path anchors are
 * boundary-insensitive around the version/pair vocabulary, so a
 * path-shaped string embedded after `astro@` or a version digit is
 * caught, never just at prose boundaries. The complementary pole is the
 * law for fact-shaped fields: they validate format-tight (version/pair
 * facts pinned to a semver-ish shape at admission), and composed
 * free-form text relies on the standalone belt (#351: every fact string
 * validated in isolation before it is composed). Shape-based scanning of
 * composed text is weaker than format-tight fact validation — the
 * defenses are layered on purpose: the pattern catches general composed
 * text; format-tightness kills the class at the source.
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
  // a drive letter is a SINGLE letter with no letter before it — the
  // lookbehind keeps prose like `see:/Users/...` out of this finding
  { id: 'windows-path', pattern: /(?<![A-Za-z])[A-Za-z]:[\\/]/, what: 'a Windows drive path' },
  // #352 composed-text embedding: the path anchors below admit digits and
  // `@` (the version/pair vocabulary boundary) so a path-shaped string
  // composed after a version or package handle is still scanned —
  // `astro@7.3.0/Users/secret`, `astro@7.2.10/Users/you/dev/project`,
  // `astro@24/bin/node`, `7.3.0~/dev/project`, `astro@~/dev/project`.
  // Calibration: digit-led benign shapes stay safe because the first
  // segment after the anchored slash must be letter-led — dates
  // (`2026/09/03`) and single-slash fractions (`24/7`) never match. A
  // letter-led segment pair after a digit or `@` (`03/Sep/26`, an `@/`
  // alias like `@/lib/ui`) is path-shaped by this guard's fail-closed
  // standard and is flagged. Windows paths need no such anchor: their
  // lookbehind already admits digit/`@`-prefixed drive letters.
  {
    id: 'absolute-path',
    pattern: /(?:^|[\s"'`(=:@0-9])\/[a-z][^/\s]*\//i,
    what: 'an absolute filesystem path',
  },
  {
    id: 'home-relative-path',
    pattern: /(?:^|[\s"'`(=:@0-9])~\//,
    what: 'a home-relative path',
  },
  { id: 'unc-path', pattern: /\\\\[^\\/\s]+[\\/]/, what: 'a UNC path' },
  { id: 'pid', pattern: /\bpid\b\s*[:=]?\s*\d+/i, what: 'a process id' },
  // keyword-anchored like pid: "port 4321" leaks, "10:30" prose stays safe
  { id: 'port', pattern: /\bport\b\s*[:=]?\s*\d+/i, what: 'a listening port' },
  // env values: SCREAMING_SNAKE assignments (at least one underscore keeps
  // prose like "ID=5" out) — the in-character leaks are ASTRO_*/VITE_*/NODE_*
  { id: 'env-value', pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{1,}=\S/, what: 'an environment value' },
];

/**
 * The first disclosure shape found in `text`, or `null` when the text is
 * shape-clean. Returns the pattern id (not the matched bytes) so callers
 * can report the finding without echoing the potential leak.
 */
export function findDisclosure(text: string): { id: string; what: string } | null {
  for (const { id, pattern, what } of DISCLOSURE_PATTERNS) {
    if (pattern.test(text)) return { id, what };
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
      message: `public text may not disclose ${disclosure.what} (${disclosure.id}, ADR-0006 §7 output hygiene)`,
    });
  }
});
