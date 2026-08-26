/**
 * Is this request a top-level document navigation the builder should wrap?
 * Deliberately conservative: anything asset-like, internal to Vite/Astro, or
 * carrying an explicit `builder` param falls through to the host.
 */
export function isDocumentRequest(input: {
  method: string;
  url: string;
  accept?: string | undefined;
}): boolean {
  if (input.method !== 'GET' && input.method !== 'HEAD') return false;
  if (!(input.accept ?? '').includes('text/html')) return false;

  let url: URL;
  try {
    url = new URL(input.url, 'http://astroix.internal');
  } catch {
    return false;
  }
  if (url.searchParams.has('builder')) return false;

  const { pathname } = url;
  if (
    pathname.startsWith('/@') ||
    pathname.startsWith('/__') ||
    pathname.startsWith('/_astro') ||
    pathname.startsWith('/virtual:')
  ) {
    return false;
  }
  // A dot in the last path segment reads as an asset (`home.css`, `foo.png`).
  if (/(^|\/)[^/]*\.[a-zA-Z0-9]+$/.test(pathname)) return false;
  return true;
}
