import { beforeEach, describe, expect, it } from 'vitest';
import type { IndexPayloadRecord } from './matcher';
import { matchRules } from './matcher';

let target: Element;

beforeEach(() => {
  document.body.innerHTML = '';
  const main = document.createElement('div');
  main.id = 'main';
  target = document.createElement('h1');
  target.className = 'hero-title';
  target.setAttribute('data-astro-cid-abc123', '');
  main.append(target);
  document.body.append(main);
});

function payload(overrides: Partial<IndexPayloadRecord>): IndexPayloadRecord {
  return {
    selector: '.hero-title',
    file: 'src/pages/home.css',
    range: { start: 0, end: 10 },
    line: 1,
    media: null,
    scoped: false,
    styleBlockIndex: null,
    effectiveSelector: null,
    ...overrides,
  };
}

describe('matchRules — selector semantics', () => {
  it('matches a global rule by its source selector', () => {
    const matches = matchRules([payload({ selector: '.hero-title' })], target);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.record.file).toBe('src/pages/home.css');
  });

  it('matches a scoped rule only via its effective selector — same class, different component, no match', () => {
    const mine = payload({
      selector: '.hero-title',
      file: 'src/pages/index.astro',
      scoped: true,
      styleBlockIndex: 0,
      effectiveSelector: '.hero-title[data-astro-cid-abc123]',
    });
    const otherComponent = payload({
      selector: '.hero-title',
      file: 'src/components/other.astro',
      scoped: true,
      styleBlockIndex: 0,
      effectiveSelector: '.hero-title[data-astro-cid-zzz999]',
    });

    const matches = matchRules([mine, otherComponent], target);
    expect(matches.map((m) => m.record.file)).toEqual(['src/pages/index.astro']);
  });

  it('never matches scoped records without an effective selector (file not loaded on this route)', () => {
    const dead = payload({ scoped: true, styleBlockIndex: 0, effectiveSelector: null });
    expect(matchRules([dead], target)).toEqual([]);
  });

  it('carries the media condition through untouched', () => {
    const inMedia = payload({ media: '(max-width: 640px)' });
    const [match] = matchRules([inMedia], target);
    expect(match?.record.media).toBe('(max-width: 640px)');
  });

  it('ignores records whose selector cannot parse — no throw', () => {
    expect(matchRules([payload({ selector: '..hero-title' })], target)).toEqual([]);
  });
});

describe('matchRules — specificity sort and winner', () => {
  it('sorts by specificity descending and marks the winner first', () => {
    const matches = matchRules(
      [
        payload({ selector: '.hero-title' }), // (0,1,0)
        payload({ selector: '#main .hero-title' }), // (1,1,0)
        payload({ selector: 'h1.hero-title' }), // (0,1,1)
      ],
      target,
    );

    expect(matches.map((m) => m.record.selector)).toEqual([
      '#main .hero-title',
      'h1.hero-title',
      '.hero-title',
    ]);
    expect(matches.map((m) => m.winner)).toEqual([true, false, false]);
  });

  it('keeps source order for specificity ties', () => {
    const matches = matchRules(
      [
        payload({ file: 'a.css', selector: '.hero-title' }),
        payload({ file: 'b.css', selector: '.hero-lead, .hero-title' }),
      ],
      target,
    );

    expect(matches.map((m) => m.record.file)).toEqual(['a.css', 'b.css']);
    expect(matches[0]?.winner).toBe(true);
  });

  it('counts the cid attribute as class weight in effective selectors (attribute strategy forms)', () => {
    const scoped = payload({
      scoped: true,
      styleBlockIndex: 0,
      effectiveSelector: '.hero-title[data-astro-cid-abc123]',
    });
    const [match] = matchRules([scoped], target);
    expect(match?.specificity).toEqual([0, 2, 0]);
  });

  it('uses the most specific part of a selector list', () => {
    const list = payload({ selector: '.hero-title, #legacy .hero-title' });
    const [match] = matchRules([list], target);
    expect(match?.specificity).toEqual([1, 1, 0]);
  });
});
