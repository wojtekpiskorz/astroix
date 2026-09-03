import { beforeEach, describe, expect, it } from 'vitest';
import {
  cssEscapeIdent,
  matchedSelectors,
  rematchSelection,
  type SelectionDescriptor,
  selectionDescriptorOf,
  selectionSelector,
} from './selection.ts';

/**
 * The selection identity's focused lane (#242, G3): the descriptor
 * round-trip (element → identity → selector → the element again), the
 * reload survival (the same identity re-found in a REBUILT document),
 * the honest miss (an identity this reload no longer carries), and the
 * matching law — `Element.matches` against runtime effective
 * selectors, scoped forms included, exactly the seam the canvas and
 * the CSS vertical's index payload share.
 */

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

/** One element carrying the scoped-style identity the fixture's `.hero-title` carries in the live canvas. */
function scopedTitle(): Element {
  const element = mount('<h1 class="hero-title" data-astro-cid-h4sh123>Astroix fixture</h1>');
  return element;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('the selection descriptor', () => {
  it('reads tag, id, classes, and the Astro scope attributes', () => {
    const element = mount(
      '<div id="hero" class="a b" data-astro-cid-one data-astro-cid-two></div>',
    );
    expect(selectionDescriptorOf(element)).toEqual({
      tag: 'div',
      id: 'hero',
      classes: ['a', 'b'],
      scopeAttributes: ['data-astro-cid-one', 'data-astro-cid-two'],
    });
  });

  it('carries no id and no scope for a plain element', () => {
    const element = mount('<p class="only">text</p>');
    expect(selectionDescriptorOf(element)).toEqual({
      tag: 'p',
      id: null,
      classes: ['only'],
      scopeAttributes: [],
    });
  });

  it('never treats a non-scope attribute as scope identity', () => {
    const element = mount('<p data-testid="x" data-other="1"></p>');
    expect(selectionDescriptorOf(element).scopeAttributes).toEqual([]);
  });
});

describe('the re-match selector', () => {
  it('composes the scoped form the runtime DOM matches', () => {
    const descriptor = selectionDescriptorOf(scopedTitle());
    expect(selectionSelector(descriptor)).toBe('h1.hero-title[data-astro-cid-h4sh123]');
  });

  it('escapes identifier characters that would break a naive composition', () => {
    const element = mount('<p class="sm:text-lg" id="w-1/2"></p>');
    const selector = selectionSelector(selectionDescriptorOf(element));
    expect(selector).toBe('p#w-1\\/2.sm\\:text-lg');
    // The composed selector actually matches the element it came from.
    expect(element.matches(selector)).toBe(true);
  });
});

describe('selection persistence across reloads', () => {
  const identity = (): SelectionDescriptor => selectionDescriptorOf(scopedTitle());

  it('re-finds the element in a rebuilt document — the reload was eligible', () => {
    const descriptor = identity();
    document.body.replaceChildren();
    document.body.innerHTML =
      '<nav><a href="/">home</a></nav><h1 class="hero-title" data-astro-cid-h4sh123>Astroix fixture</h1>';
    const found = rematchSelection(document, descriptor);
    expect(found).not.toBeNull();
    expect(found?.textContent).toBe('Astroix fixture');
  });

  it('answers null when the rebuilt document no longer carries the identity', () => {
    const descriptor = identity();
    document.body.innerHTML = '<h1 class="hero-title">scope lost</h1>';
    expect(rematchSelection(document, descriptor)).toBeNull();
  });

  it('answers null — never throws — when the composed selector is unparseable', () => {
    // A lone surrogate in an identifier survives no escape this side of
    // the engine's parser: the composed selector is rejected, and the
    // rematch must be a non-rematch (guarded like matchesSelector),
    // never a crash of the recompute pass.
    const descriptor: SelectionDescriptor = {
      tag: 'p',
      id: null,
      classes: ['\uD800'],
      scopeAttributes: [],
    };
    expect(() => selectionSelector(descriptor)).not.toThrow();
    expect(rematchSelection(document, descriptor)).toBeNull();
  });

  it('re-finds an element whose identifier carries an ASTRAL code point', () => {
    // A name the DOM legally carries (an astral letter): the escaper
    // walks code points, so it passes as one identifier character and
    // the rematch SUCCEEDS — not merely fails honestly.
    const astral = 'title\u{1D306}';
    const element = mount(`<h1 class="${astral}">astral</h1>`);
    const descriptor = selectionDescriptorOf(element);
    expect(selectionSelector(descriptor)).toBe(`h1.title\u{1D306}`);
    const found = rematchSelection(document, descriptor);
    expect(found).toBe(element);
  });
});

describe('matching against runtime effective selectors', () => {
  it('matches the scoped form, the global form, and carries the media condition', () => {
    const element = scopedTitle();
    const matched = matchedSelectors(element, [
      { selector: '.hero-title[data-astro-cid-h4sh123]', media: null },
      { selector: '.hero-title', media: null },
      { selector: '.hero-title', media: '(max-width: 640px)' },
      { selector: '.hero-lead', media: null },
      // A scoped form for a DIFFERENT component's scope never matches.
      { selector: '.hero-title[data-astro-cid-other]', media: null },
    ]);
    expect(matched).toEqual([
      { selector: '.hero-title[data-astro-cid-h4sh123]', media: null },
      { selector: '.hero-title', media: null },
      { selector: '.hero-title', media: '(max-width: 640px)' },
    ]);
  });

  it('matches scoped forms for a differently-scoped element only through that scope', () => {
    const element = mount('<p class="hero-lead" data-astro-cid-l34d456>lead</p>');
    const matched = matchedSelectors(element, [
      { selector: '.hero-title[data-astro-cid-h4sh123]', media: null },
      { selector: '.hero-lead', media: null },
      { selector: '.hero-lead[data-astro-cid-l34d456]', media: null },
    ]);
    expect(matched.map((entry) => entry.selector)).toEqual([
      '.hero-lead',
      '.hero-lead[data-astro-cid-l34d456]',
    ]);
  });

  it('answers no match for an unparseable selector instead of failing the pass', () => {
    const element = scopedTitle();
    expect(
      matchedSelectors(element, [{ selector: 'this is <<< not a selector', media: null }]),
    ).toEqual([]);
  });
});

describe('the identifier escaper', () => {
  it('hex-escapes a leading digit, backslash-escapes delimiter characters', () => {
    expect(cssEscapeIdent('1a')).toBe('\\31 a');
    expect(cssEscapeIdent('a/b')).toBe('a\\/b');
    expect(cssEscapeIdent('plain_underscore-kept')).toBe('plain_underscore-kept');
  });
});
