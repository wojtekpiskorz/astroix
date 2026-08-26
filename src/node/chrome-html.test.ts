import { describe, expect, it } from 'vitest';
import { canvasUrl, chromeHtml } from './chrome-html';

describe('canvasUrl', () => {
  it('adds builder=0 to a bare path', () => {
    expect(canvasUrl('/')).toBe('/?builder=0');
  });

  it('preserves existing query params and order', () => {
    expect(canvasUrl('/about?tab=styles&x=1')).toBe('/about?tab=styles&x=1&builder=0');
  });

  it('overrides any existing builder value', () => {
    expect(canvasUrl('/?builder=1')).toBe('/?builder=0');
  });
});

describe('chromeHtml', () => {
  it('references the canvas iframe, mount point and virtual chrome module', () => {
    const html = chromeHtml({ iframeSrc: '/?builder=0' });
    expect(html).toContain('<div id="astroix-root"></div>');
    expect(html).toContain('<iframe id="astroix-canvas" src="/?builder=0"');
    expect(html).toContain('<script type="module" src="/virtual:astroix/chrome"></script>');
  });

  it('escapes the iframe src', () => {
    const html = chromeHtml({ iframeSrc: '/?q=<script>"&x=1' });
    expect(html).toContain('src="/?q=&lt;script&gt;&quot;&amp;x=1"');
    expect(html).not.toContain('<script>&');
  });
});
