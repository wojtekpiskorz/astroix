import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryTree } from './entry-tree';
import { inspectionFixture } from './fixtures';
import { mount } from './mount';
import type { ActiveEntryView, CollectionListingView } from './types';

/**
 * The entry-tree widget tests (#219, AC-5/6): the frozen B1 collections and
 * route-resolution corpora are the prop source — the listing view derives
 * from the collections payload, the unrouted marker truth from the
 * resolution payload's own `unrouted` rows (CONTEXT.md: unrouted entry).
 */

const collectionsFixture = inspectionFixture('collections.json');
const resolutionFixture = inspectionFixture('route-resolution.json');

const listings: readonly CollectionListingView[] = collectionsFixture.collections.map(
  (collection) => ({
    name: collection.name,
    entryIds: collection.entries.map((entry) => entry.id),
  }),
);

const unroutedIds = new Set(
  resolutionFixture.entryResolutions.filter((row) => row.unrouted).map((row) => row.entryId),
);

const NOOP = (): void => {};

function tree(active: ActiveEntryView | null = null) {
  return (
    <EntryTree
      collections={listings}
      activeEntry={active}
      unroutedIds={unroutedIds}
      collapsedFolders={new Set()}
      onToggleFolder={NOOP}
      onOpenEntry={NOOP}
    />
  );
}

describe('EntryTree over the frozen collections and route-resolution corpora', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('lists collections in served order with nested ids filed under folders', () => {
    const { container, unmount } = mount(tree());

    const sections = container.querySelectorAll('[data-astroix-collection]');
    expect([...sections].map((section) => section.getAttribute('data-astroix-collection'))).toEqual(
      ['blog', 'gallery', 'homepage', 'notes'],
    );

    // blog's nested ids live under year folders; flat ids stay bare
    const blog = sections[0];
    expect(blog?.querySelectorAll('[data-astroix-tree-folder="blog/2024"]').length).toBe(1);
    expect(blog?.querySelectorAll('[data-astroix-tree-folder="blog/2025"]').length).toBe(1);
    expect(
      blog?.querySelector(
        '[data-astroix-tree-folder="blog/2024"] ~ ul [data-astroix-entry="2024/post"]',
      ),
    ).not.toBeNull();
    expect(blog?.querySelectorAll('[data-astroix-entry="hello-builder"]').length).toBe(1);

    unmount();
  });

  it('marks the unrouted entries the frozen resolution rows name, never disabling them', () => {
    // the corpus's unrouted truth: gallery/showcase, homepage/index, notes/scratch
    const { container, unmount } = mount(tree());

    const scratch = container.querySelector('[data-astroix-entry="scratch"]');
    expect(scratch?.hasAttribute('data-astroix-entry-unrouted')).toBe(true);
    expect(scratch?.getAttribute('title')).toBe('no route renders this entry');
    // the marker is a legend, never a disable — the row stays a click target
    expect((scratch as HTMLButtonElement | null)?.disabled).toBe(false);

    const routed = container.querySelector('[data-astroix-entry="2024/post"]');
    expect(routed?.hasAttribute('data-astroix-entry-unrouted')).toBe(false);

    unmount();
  });

  it('highlights the active entry and reports open/toggle intent', () => {
    const onOpenEntry = vi.fn<(collection: string, entryId: string) => void>();
    const onToggleFolder = vi.fn<(key: string) => void>();
    const { container, unmount } = mount(
      <EntryTree
        collections={listings}
        activeEntry={{ collection: 'blog', entryId: '2024/post' }}
        unroutedIds={unroutedIds}
        collapsedFolders={new Set()}
        onToggleFolder={onToggleFolder}
        onOpenEntry={onOpenEntry}
      />,
    );

    const active = container.querySelector('[data-astroix-entry="2024/post"]');
    expect(active?.getAttribute('data-active')).toBe('true');
    expect(active?.getAttribute('aria-current')).toBe('true');
    expect(
      container.querySelector('[data-astroix-entry="hello-builder"]')?.getAttribute('data-active'),
    ).toBe('false');

    // basename labels, full ids as the click contract
    expect(active?.textContent).toContain('post');
    expect(active?.textContent).not.toContain('2024/post');

    (active as HTMLButtonElement | null)?.click();
    expect(onOpenEntry).toHaveBeenCalledWith('blog', '2024/post');

    container.querySelector<HTMLButtonElement>('[data-astroix-tree-folder="blog/2024"]')?.click();
    expect(onToggleFolder).toHaveBeenCalledWith('blog/2024');

    unmount();
  });

  it("hides a collapsed folder's children", () => {
    const { container, unmount } = mount(
      <EntryTree
        collections={listings}
        activeEntry={null}
        unroutedIds={unroutedIds}
        collapsedFolders={new Set(['blog/2024'])}
        onToggleFolder={NOOP}
        onOpenEntry={NOOP}
      />,
    );
    const folder = container.querySelector('[data-astroix-tree-folder="blog/2024"]');
    expect(folder?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-astroix-entry="2024/post"]')).toBeNull();
    unmount();
  });
});
