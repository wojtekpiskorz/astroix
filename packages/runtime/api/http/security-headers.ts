/**
 * Security-relevant header evidence for the HTTP control surface (#234,
 * F2; ADR-0006 §7 "Reject … duplicate security-relevant headers",
 * ADR-0007 "Limits and output hygiene"). Pure functions over the raw
 * header pairs exactly as they arrived — the same discipline as the
 * listener's Host evidence: a duplicate can never hide behind a parser
 * join, because the pairs are counted before any value is read.
 *
 * The dispatch layer's every header decision reads this evidence and
 * nothing else: duplicate detection over a closed set of
 * security-relevant names, and the exact JSON content-type gate. The
 * Origin / Fetch Metadata / mutation-marker comparisons are exact-value
 * checks the dispatch core performs directly over the same evidence.
 */

/**
 * The security-relevant names, lowercased: every header the dispatch
 * reads an authorization or transport decision from. A request
 * carrying any of these names twice is malformed outright
 * (ADR-0006 §7) — request-smuggling shapes never reach a value
 * comparison.
 */
export const SECURITY_RELEVANT_HEADERS: readonly string[] = [
  'host',
  'origin',
  'cookie',
  'content-type',
  'content-length',
  'sec-fetch-site',
  'x-astroix-request',
  'x-astroix-client',
];

/** One request's header evidence, built from the raw pairs: counts and the last value per name. */
export interface HeaderEvidence {
  /** How many raw pairs carried each security-relevant name (lowercased). */
  readonly counts: Readonly<Record<string, number>>;
  /** The last value of each security-relevant name (last-wins) — consult `counts` before trusting it. */
  readonly values: Readonly<Record<string, string>>;
}

/** Reads the raw header pairs into evidence — the only entry point for header values the dispatch trusts. */
export function headerEvidence(rawHeaders: readonly string[]): HeaderEvidence {
  const counts: Record<string, number> = {};
  const values: Record<string, string> = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase();
    if (!SECURITY_RELEVANT_HEADERS.includes(name)) continue;
    counts[name] = (counts[name] ?? 0) + 1;
    values[name] = rawHeaders[i + 1] ?? '';
  }
  return { counts, values };
}

/** The first duplicated security-relevant name, or null — the rejection reason, never the values. */
export function duplicatedSecurityHeader(evidence: HeaderEvidence): string | null {
  for (const name of SECURITY_RELEVANT_HEADERS) {
    if ((evidence.counts[name] ?? 0) > 1) return name;
  }
  return null;
}

/** The exact media type the command endpoint accepts — `application/json`, optionally `charset=utf-8` (ADR-0006 §7 "JSON content"). */
export function contentTypeIsJson(value: string | undefined): boolean {
  if (value === undefined) return false;
  const semicolon = value.indexOf(';');
  const mediaType = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  if (mediaType !== 'application/json') return false;
  if (semicolon === -1) return true;
  return (
    value
      .slice(semicolon + 1)
      .trim()
      .toLowerCase() === 'charset=utf-8'
  );
}
