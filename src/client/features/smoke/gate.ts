/**
 * The checklist's only entry: a top-level `?astroix_smoke=1` (the #46
 * prototype gated on `?smoke=1`; the fold-in prefixes the name). Without the
 * param nothing renders at all — the checklist must be invisible in normal
 * builder use. Strict value match, so `astroix_smoke=0` stays closed.
 */
export function isSmokeGateOpen(search: string): boolean {
  return new URLSearchParams(search).get('astroix_smoke') === '1';
}
