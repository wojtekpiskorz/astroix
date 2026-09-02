import {
  EntryTree,
  RuleList,
  type RuleMatchView,
  WriteStatusBadge,
} from '@wojciechpiskorz/astroix-app-shell/presentation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// read-only reuse of the app-shell's own test helpers (mount + the
// schema-loading fixture access): one loader home, no duplicated parsing
import {
  editFixture,
  inspectionFixture,
} from '../../packages/app-shell/src/presentation/fixtures.ts';
import { mount } from '../../packages/app-shell/src/presentation/mount.tsx';
import { matchRules } from '../../packages/core/src/matcher.ts';

/**
 * The readiness presentation lane (#214, AC-3): the retained app-shell
 * presentation RUNNING against typed contract-shaped data — props derived
 * from the frozen B1/B2 corpora through the versioned schemas, mounted
 * with real React, rendered assertions on the contract-shaped output.
 * The C2 widget tests (#219) own the deep widget behavior; this lane is
 * the readiness aggregation's own proof that the surface still runs over
 * the contracts with its prop-driven boundary intact — importing the
 * package's `./presentation` export path, not its internals.
 *
 * The widgets take data and callbacks only; the forbidden-coupling scan
 * (in the readiness spec, not here) proves they carry no fetch, no
 * /__astroix URL, and no Vite handle.
 */

const NOOP = (): void => {};

const cssIndex = inspectionFixture('css-index.attribute.json');
const collections = inspectionFixture('collections.json');
const resolution = inspectionFixture('route-resolution.json');
const cssConflict = editFixture('css-conflict.json');
const contentConflict = editFixture('content-conflict.json');

function heroTitleElement(): Element {
  const scoped = cssIndex.records.find(
    (record) => record.scoped && record.effectiveSelector !== null,
  );
  const attribute = /\[(data-astro-cid-[a-z0-9]+)\]/.exec(scoped?.effectiveSelector ?? '')?.[1];
  if (attribute === undefined) throw new Error('frozen corpus carries no joined scoped selector');
  const element = document.createElement('h1');
  element.className = 'hero-title';
  element.setAttribute(attribute, '');
  return element;
}

function matchesFor(element: Element): RuleMatchView[] {
  return matchRules(
    cssIndex.records.map((record) => ({ ...record })),
    element,
  ).map(({ record, winner }) => ({ record, winner }));
}

describe('the retained presentation runs against the frozen contracts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('RuleList renders the frozen css-index corpus: four places, one winner, media badge, no cid leakage', () => {
    const { container, unmount } = mount(
      <RuleList matches={matchesFor(heroTitleElement())} hasSelection onOpenFile={NOOP} />,
    );
    expect(container.querySelectorAll('[data-astroix-rule]').length).toBe(4);
    expect(container.querySelectorAll('[data-astroix-winner="true"]').length).toBe(1);
    expect(container.querySelectorAll('[data-astroix-media="(max-width: 640px)"]').length).toBe(1);
    // presentation filter: the raw cid hash never renders
    expect(container.textContent).not.toContain('data-astro-cid');
    unmount();
  });

  it('RuleList reports edit intent as prop callbacks — never a fetch', () => {
    const onOpenFile = vi.fn<(target: { file: string }) => void>();
    const { container, unmount } = mount(
      <RuleList matches={matchesFor(heroTitleElement())} hasSelection onOpenFile={onOpenFile} />,
    );
    container.querySelectorAll<HTMLButtonElement>('[data-astroix-rule] button')[1]?.click();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile.mock.calls[0]?.[0]?.file).toBe('src/pages/home.css');
    unmount();
  });

  it('EntryTree renders the frozen collections + route-resolution corpora with the unrouted markers', () => {
    const listings = collections.collections.map((collection) => ({
      name: collection.name,
      entryIds: collection.entries.map((entry) => entry.id),
    }));
    const unroutedIds = new Set(
      resolution.entryResolutions.filter((row) => row.unrouted).map((row) => row.entryId),
    );
    const { container, unmount } = mount(
      <EntryTree
        collections={listings}
        activeEntry={null}
        unroutedIds={unroutedIds}
        collapsedFolders={new Set()}
        onToggleFolder={NOOP}
        onOpenEntry={NOOP}
      />,
    );
    expect(
      [...container.querySelectorAll('[data-astroix-collection]')].map((node) =>
        node.getAttribute('data-astroix-collection'),
      ),
    ).toEqual(['blog', 'gallery', 'homepage', 'notes']);
    expect(
      container
        .querySelector('[data-astroix-entry="scratch"]')
        ?.hasAttribute('data-astroix-entry-unrouted'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-astroix-entry="hello-builder"]')
        ?.hasAttribute('data-astroix-entry-unrouted'),
    ).toBe(false);
    unmount();
  });

  it('WriteStatusBadge renders the frozen 409 conflicts as the stale vocabulary', () => {
    expect(cssConflict.response.status).toBe(409);
    expect(contentConflict.response.status).toBe(409);
    const { container, unmount } = mount(<WriteStatusBadge status="stale" />);
    expect(container.querySelector('[data-astroix-write-status="stale"]')?.textContent).toBe(
      'changed on disk — reloaded',
    );
    unmount();
  });
});
