/**
 * The chrome placeholder document: a mount point for the React app and a
 * same-origin iframe loading the same URL as a clean page (`?builder=0`).
 * The real shell replaces the placeholder rendering in the chrome shell
 * slice; the entry contract (`#astroix-root`, `/virtual:astroix/chrome`,
 * `#astroix-canvas`) is what this slice locks in.
 */
export function chromeHtml({ iframeSrc }: { iframeSrc: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>astroix builder</title>
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: flex; flex-direction: column; }
      #astroix-root { flex: none; padding: 0.25rem 0.75rem; font: 600 12px/1.6 system-ui, sans-serif; background: #0f172a; color: #fff; }
      #astroix-root strong { letter-spacing: 0.02em; }
      #astroix-canvas { flex: 1; border: 0; width: 100%; }
    </style>
  </head>
  <body>
    <div id="astroix-root"></div>
    <iframe id="astroix-canvas" src="${escapeHtml(iframeSrc)}" title="astroix canvas"></iframe>
    <script type="module" src="/virtual:astroix/chrome"></script>
  </body>
</html>`;
}

/** The canvas URL for a builder request: same path+query with `builder=0`. */
export function canvasUrl(pathAndQuery: string): string {
  const url = new URL(pathAndQuery, 'http://astroix.internal');
  url.searchParams.set('builder', '0');
  return `${url.pathname}${url.search}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
