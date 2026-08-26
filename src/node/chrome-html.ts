/**
 * The chrome document shell: a mount point and the virtual-module reference.
 * Layout lives inside the shadow root (React app); the document only resets
 * geometry so the shadow host can fill the viewport.
 */
export function chromeHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>astroix builder</title>
    <style>
      html, body { margin: 0; height: 100%; }
      #astroix-root { display: block; height: 100vh; }
    </style>
  </head>
  <body>
    <div id="astroix-root"></div>
    <script type="module" src="/virtual:astroix/chrome"></script>
  </body>
</html>`;
}
