import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matchRules } from '../../../core/src/matcher';
import { inspectionFixture } from './fixtures';
import { IndexStatus } from './index-status';
import { mount } from './mount';
import { RuleList } from './rule-list';
import type { RuleFileTargetView, RuleMatchView } from './types';

/**
 * The rule-list widget tests (#219, AC-5/6): the frozen B1 css-index corpus
 * is the prop source. The matcher (the pure core module the host adapter
 * runs) positions the frozen records against an element constructed from
 * the fixture's OWN effective selector — the cid attribute the corpus
 * carries — so the rendered structure (specificity order, winner, media
 * badges, multi-place hints) is asserted over contract-shaped data end to
 * end.
 */

const fixture = inspectionFixture('css-index.attribute.json');

/** The scoped record's cid attribute name, derived from the frozen bytes. */
function scopedCidAttribute(): string {
  const scoped = fixture.records.find((record) => record.scoped && record.effectiveSelector);
  if (scoped?.effectiveSelector === undefined || scoped.effectiveSelector === null) {
    throw new Error('frozen fixture carries no joined scoped selector');
  }
  const match = /\[(data-astro-cid-[a-z0-9]+)\]/.exec(scoped.effectiveSelector);
  const attribute = match?.[1];
  if (attribute === undefined) throw new Error('effective selector carries no cid attribute');
  return attribute;
}

/** An element the frozen scoped rule matches — its class plus the corpus's cid. */
function heroTitleElement(): Element {
  const element = document.createElement('h1');
  element.className = 'hero-title';
  element.setAttribute(scopedCidAttribute(), '');
  return element;
}

/** The adapter's exact mapping: matcher output → widget rows. */
function matchesFor(element: Element): RuleMatchView[] {
  return matchRules(
    fixture.records.map((record) => ({ ...record })),
    element,
  ).map(({ record, winner }) => ({ record, winner }));
}

const ON_OPEN_FILE = (): void => {};

describe('RuleList over the frozen css-index corpus', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the positioned matches: winner first, media badge, multi-place, file:line', () => {
    const { container, unmount } = mount(
      <RuleList matches={matchesFor(heroTitleElement())} hasSelection onOpenFile={ON_OPEN_FILE} />,
    );

    const rules = container.querySelectorAll('[data-astroix-rule]');
    // the three home.css places (base, weight, @media) + the scoped rule
    expect(rules.length).toBe(4);

    // exactly one winner — the scoped rule (0,2,0 beats (0,1,0)), first row
    const winners = container.querySelectorAll('[data-astroix-winner="true"]');
    expect(winners.length).toBe(1);
    expect(winners[0]?.textContent).toContain('.hero-title');
    expect(winners[0]?.textContent).toContain('src/pages/index.astro');

    // the @media place carries its badge (condition text, unevaluated)
    expect(container.querySelectorAll('[data-astroix-media="(max-width: 640px)"]').length).toBe(1);

    // multi-place hint: home.css styles the element in three places
    expect(container.querySelectorAll('[data-astroix-multi]').length).toBe(3);

    // presentation filter: raw cid hashes never appear
    expect(container.textContent).not.toContain('data-astro-cid');

    // file:line values match the frozen records
    expect(container.textContent).toContain('src/pages/home.css:8');
    expect(container.textContent).toContain('src/pages/home.css:16');
    expect(container.textContent).toContain('src/pages/home.css:22');

    // specificity order after the winner: source order for the (0,1,0) ties,
    // the @media place last
    const orderText = [...rules].map((rule) => rule.textContent ?? '');
    expect(orderText.findIndex((text) => text.includes('max-width'))).toBe(3);

    unmount();
  });

  it('hands the open-file intent the clicked rule file with every place it styles the element', () => {
    const onOpenFile = vi.fn<(target: RuleFileTargetView) => void>();
    const { container, unmount } = mount(
      <RuleList matches={matchesFor(heroTitleElement())} hasSelection onOpenFile={onOpenFile} />,
    );

    // click the scoped winner (index.astro styles it once)
    container.querySelectorAll<HTMLButtonElement>('[data-astroix-rule] button')[0]?.click();
    expect(onOpenFile).toHaveBeenLastCalledWith({
      file: 'src/pages/index.astro',
      ranges: [{ start: expect.any(Number), end: expect.any(Number), label: 'L24' }],
      activeIndex: 0,
    });

    // click a home.css place — the target carries all three places, active
    // at the clicked one
    container.querySelectorAll<HTMLButtonElement>('[data-astroix-rule] button')[1]?.click();
    const target = onOpenFile.mock.calls.at(-1)?.[0];
    expect(target?.file).toBe('src/pages/home.css');
    expect(target?.ranges.map((range) => range.label)).toEqual(['L8', 'L16', 'L22']);
    expect(target?.activeIndex).toBe(0);

    unmount();
  });

  it('renders the loading, empty, and no-selection states', () => {
    const loading = mount(<RuleList matches={null} hasSelection onOpenFile={ON_OPEN_FILE} />);
    expect(loading.container.querySelector('[data-astroix-rules="loading"]')).not.toBeNull();
    loading.unmount();

    const empty = mount(<RuleList matches={[]} hasSelection onOpenFile={ON_OPEN_FILE} />);
    expect(empty.container.querySelector('[data-astroix-rules="empty"]')).not.toBeNull();
    empty.unmount();

    const noSelection = mount(
      <RuleList matches={null} hasSelection={false} onOpenFile={ON_OPEN_FILE} />,
    );
    expect(
      noSelection.container.querySelector('[data-astroix-rules="no-selection"]'),
    ).not.toBeNull();
    noSelection.unmount();
  });

  it('IndexStatus covers the payload presence states', () => {
    const loading = mount(<IndexStatus count={null} />);
    expect(loading.container.querySelector('[data-astroix-index="loading"]')).not.toBeNull();
    loading.unmount();

    const empty = mount(<IndexStatus count={0} />);
    expect(empty.container.querySelector('[data-astroix-index="empty"]')).not.toBeNull();
    empty.unmount();

    const ready = mount(<IndexStatus count={fixture.records.length} />);
    expect(ready.container.querySelector('[data-astroix-index="ready"]')?.textContent).toContain(
      `${fixture.records.length} rules indexed`,
    );
    ready.unmount();
  });
});
