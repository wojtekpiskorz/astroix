import { describe, expect, it } from 'vitest';
import { isDocumentRequest } from './document-request';

const HTML = 'text/html,application/xhtml+xml';

function check(url: string, overrides: Record<string, unknown> = {}): boolean {
  return isDocumentRequest({ method: 'GET', url, accept: HTML, ...overrides });
}

describe('isDocumentRequest', () => {
  it('accepts top-level document navigations', () => {
    expect(check('/')).toBe(true);
    expect(check('/about')).toBe(true);
    expect(check('/blog/post-one/')).toBe(true);
  });

  it('falls through when the builder param is explicit', () => {
    expect(check('/?builder=0')).toBe(false);
    expect(check('/?builder=1')).toBe(false);
  });

  it('falls through for non-document requests', () => {
    expect(check('/', { accept: '*/*' })).toBe(false);
    expect(check('/', { method: 'POST' })).toBe(false);
    expect(check('/', { accept: undefined })).toBe(false);
  });

  it('falls through for vite/astro internals and modules', () => {
    expect(check('/@vite/client')).toBe(false);
    expect(check('/@fs/src/client/entry.tsx')).toBe(false);
    expect(check('/virtual:astroix/chrome')).toBe(false);
    expect(check('/_astro/hero.abc123.js')).toBe(false);
    expect(check('/__open-in-editor')).toBe(false);
  });

  it('falls through for asset-like paths (extension in the last segment)', () => {
    expect(check('/src/pages/home.css')).toBe(false);
    expect(check('/favicon.ico')).toBe(false);
    expect(check('/dir.v2/nested')).toBe(true);
  });
});
