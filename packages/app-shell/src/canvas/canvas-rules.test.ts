import { beforeEach, describe, expect, it } from 'vitest';
import { RUNTIME_SELECTOR_BOUND, runtimeRuleSelectors } from './canvas-rules.ts';

/**
 * The runtime rule-selector walk's focused lane (#242, G3): document
 * order preserved, the scoped effective forms verbatim, media
 * conditions carried on their nested rules, unreadable sheets skipped
 * fail-closed, and the walk bounded. The fixture-shaped style content
 * here mirrors what the live canvas document serves in dev (the scoped
 * block the compiler emitted beside the globally imported sheet).
 */

/** The sheet of one staged style element — every leg rebuilds it, so order and isolation stay honest. */
function sheetOf(css: string): CSSStyleSheet {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const sheet = style.sheet;
  if (sheet === null) throw new Error('the probe style element carries no sheet');
  return sheet;
}

beforeEach(() => {
  for (const style of document.head.querySelectorAll('style')) {
    style.remove();
  }
});

describe('the runtime selector walk', () => {
  it('collects style rules in document order, scoped forms verbatim', () => {
    const selectors = runtimeRuleSelectors([
      sheetOf(
        '.hero { display: grid; } .hero-title[data-astro-cid-h4sh123] { color: #1e293b; } .hero-lead { margin: 0; }',
      ),
    ]);
    expect(selectors).toEqual([
      { selector: '.hero', media: null },
      { selector: '.hero-title[data-astro-cid-h4sh123]', media: null },
      { selector: '.hero-lead', media: null },
    ]);
  });

  it('carries the media condition on rules nested in @media', () => {
    const selectors = runtimeRuleSelectors([
      sheetOf('@media (max-width: 640px) { .hero-title { font-size: 2rem; } }'),
    ]);
    expect(selectors).toEqual([{ selector: '.hero-title', media: '(max-width: 640px)' }]);
  });

  it('walks multiple sheets in sheet order', () => {
    const first = document.createElement('style');
    first.textContent = '.a { color: red; }';
    const second = document.createElement('style');
    second.textContent = '.b { color: blue; }';
    document.head.append(first, second);
    const sheets = [first.sheet, second.sheet].filter(
      (sheet): sheet is CSSStyleSheet => sheet !== null,
    );
    const selectors = runtimeRuleSelectors(sheets);
    expect(selectors.map((entry) => entry.selector)).toEqual(['.a', '.b']);
  });

  it('ignores rules that are neither style rules nor groupings', () => {
    const selectors = runtimeRuleSelectors([
      sheetOf('@font-face { font-family: probe; src: url(probe.woff2); } .a { color: red; }'),
    ]);
    expect(selectors.map((entry) => entry.selector)).toEqual(['.a']);
  });

  it('skips an unreadable sheet fail-closed — the walk never throws and never guesses', () => {
    const readable = sheetOf('.a { color: red; }');
    const throwing = {
      get cssRules(): CSSRuleList {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    };
    const selectors = runtimeRuleSelectors([throwing, readable]);
    expect(selectors.map((entry) => entry.selector)).toEqual(['.a']);
  });

  it('stops at the bound — a pathological document cannot stall the panel', () => {
    const selectors = runtimeRuleSelectors(
      [sheetOf('.a { color: red; } .b { color: blue; } .c { color: green; }')],
      2,
    );
    expect(selectors).toHaveLength(2);
    expect(selectors[0]?.selector).toBe('.a');
    expect(selectors[1]?.selector).toBe('.b');
  });

  it('answers an empty walk for a sheet with no rules', () => {
    expect(runtimeRuleSelectors([sheetOf('')])).toEqual([]);
    expect(runtimeRuleSelectors([], RUNTIME_SELECTOR_BOUND)).toEqual([]);
  });

  it('walks a SECOND window\u2019s rules — a foreign document\u2019s sheets, structural checks only', () => {
    // The canvas document is a foreign document to the shell: the walk
    // gates on structure (`selectorText`, `cssRules`, `conditionText`),
    // never on this realm's classes. A real browser's iframe realms
    // reject every cross-realm instanceof (pinned live by the e2e leg);
    // happy-dom's second window shares classes, so what this unit pins
    // is the walk over a document that is not the walking one's own.
    const other = new Window();
    const style = other.document.createElement('style');
    style.textContent =
      '.hero-title[data-astro-cid-r34lm] { color: red; } @media (max-width: 640px) { .hero-title { font-size: 2rem; } }';
    other.document.head.append(style);
    const sheet = style.sheet;
    if (sheet === null) throw new Error('the other window\u2019s style element carries no sheet');

    const selectors = runtimeRuleSelectors([sheet]);
    expect(selectors).toEqual([
      { selector: '.hero-title[data-astro-cid-r34lm]', media: null },
      { selector: '.hero-title', media: '(max-width: 640px)' },
    ]);
  });
});
