import { describe, expect, it } from 'vitest';
import { chromeHtml } from './chrome-html';

describe('chromeHtml', () => {
  it('references the mount point and the virtual chrome module', () => {
    const html = chromeHtml();
    expect(html).toContain('<div id="astroix-root"></div>');
    expect(html).toContain('<script type="module" src="/virtual:astroix/chrome"></script>');
  });

  it('resets document geometry so the shadow host fills the viewport', () => {
    const html = chromeHtml();
    expect(html).toContain('html, body { margin: 0; height: 100%; }');
    expect(html).toContain('#astroix-root { display: block; height: 100vh; }');
  });
});
