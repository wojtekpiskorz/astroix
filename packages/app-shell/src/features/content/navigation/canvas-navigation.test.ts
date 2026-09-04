import { describe, expect, it } from 'vitest';
import { navigateCanvasFrame, productCanvasFrameLocator } from './canvas-navigation.ts';

/**
 * The canvas navigation seam's focused lane (#251): the frame is
 * located through the canvas root's product attribute, the navigation
 * rides the frame's own same-origin `location.assign`, and every
 * refusal — absent frame, unreachable window — fails closed as
 * `canvas-unavailable`. No URL is constructed here (the callers' law),
 * so the legs pass absolute URLs through verbatim.
 */

/** One fake frame — `assign` is the spy the legs assert on. */
function fakeFrame(): { frame: HTMLIFrameElement; assigned: string[] } {
  const assigned: string[] = [];
  const frame = {
    contentWindow: {
      location: {
        assign: (url: string) => {
          assigned.push(url);
        },
      },
    },
  } as unknown as HTMLIFrameElement;
  return { frame, assigned };
}

describe('navigateCanvasFrame', () => {
  it('assigns the URL on the located frame through its own location API', () => {
    const { frame, assigned } = fakeFrame();
    const outcome = navigateCanvasFrame(
      'http://project.localhost:1/blog/hello-builder',
      () => frame,
    );
    expect(outcome).toBe('navigated');
    expect(assigned).toEqual(['http://project.localhost:1/blog/hello-builder']);
  });

  it('fails closed as canvas-unavailable when no frame exists', () => {
    expect(navigateCanvasFrame('http://project.localhost:1/', () => null)).toBe(
      'canvas-unavailable',
    );
  });

  it('fails closed when the frame window is unreachable (off-origin reads throw)', () => {
    const frame = {
      get contentWindow(): unknown {
        throw new Error('cross-origin');
      },
    } as unknown as HTMLIFrameElement;
    expect(navigateCanvasFrame('http://project.localhost:1/', () => frame)).toBe(
      'canvas-unavailable',
    );
  });
});

describe('productCanvasFrameLocator', () => {
  it('locates the canvas root product attribute — never a test id', () => {
    const root = document.createElement('div');
    root.setAttribute('data-astroix-canvas', '');
    const frame = document.createElement('iframe');
    root.append(frame);
    document.body.append(root);
    try {
      expect(productCanvasFrameLocator()).toBe(frame);
    } finally {
      root.remove();
    }
  });

  it('returns null when the canvas is absent from the document', () => {
    expect(productCanvasFrameLocator()).toBeNull();
  });

  it('the default locator drives navigation — the product path, no injection', () => {
    const root = document.createElement('div');
    root.setAttribute('data-astroix-canvas', '');
    const { frame, assigned } = fakeFrame();
    // a REAL iframe element carrying the spied window — the locator must
    // find it through the DOM, exactly as it finds the live canvas
    const element = document.createElement('iframe');
    Object.defineProperty(element, 'contentWindow', { value: frame.contentWindow });
    root.append(element);
    document.body.append(root);
    try {
      const outcome = navigateCanvasFrame('http://project.localhost:1/blog/2024/post');
      expect(outcome).toBe('navigated');
      expect(assigned).toEqual(['http://project.localhost:1/blog/2024/post']);
    } finally {
      root.remove();
    }
  });
});
