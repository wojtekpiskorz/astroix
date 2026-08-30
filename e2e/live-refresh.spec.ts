import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type CmView, expectSettled, openEntry } from './entry-pane';
import { restoreEntry } from './entry-restore';
import { SRC_PORT } from './ports';

/**
 * Live-refresh lane: every push-driven flow — external IDE edits, the
 * collections list picking up content changes, the write loop's echo —
 * rides the vite hot channel (`astroix:file-changed` /
 * `astroix:content-synced` pushes from the node side), and only a
 * source-served chrome subscribes to it: the prebuilt bundle
 * dead-code-eliminates the `import.meta.hot` subscriptions because the
 * property is statically dead in a lib build. These tests moved here from
 * the main lane when #150's mode detection stopped leaking source mode
 * into it; the prebuilt gap is a real consumer-facing hole tracked in
 * #166.
 */
test.use({ baseURL: `http://localhost:${SRC_PORT}` });
test.describe.configure({ mode: 'serial' });

// every test waits out the host's content sync at least once (auto-write
// precedent)
test.slow();

const FIXTURE = join('e2e', 'src-fixture');
const POST = join(FIXTURE, 'src', 'content', 'blog', '2024', 'post.md');
const HOME_CSS = join(FIXTURE, 'src', 'pages', 'home.css');
const ENTRY_PROBE = join(FIXTURE, 'src', 'content', 'blog', 'new-entry.md');

test('the full loop: a form edit lands on disk byte-surgically and reloads the canvas', async ({
  page,
}) => {
  const pane = await openEntry(page, '2024/post');
  const original = readFileSync(POST, 'utf8');
  try {
    await pane.locator('[data-astroix-form-field="title"] input').fill('Renamed post');
    await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'saved',
      { timeout: 10_000 },
    );

    // byte-surgical: the edited line spliced, the raw date node untouched,
    // the body's leading blank line untouched — the Document API's one
    // normalization respaces the flow array (`[nested]` → `[ nested ]`)
    expect(readFileSync(POST, 'utf8')).toBe(
      [
        '---',
        'title: Renamed post',
        'date: 2024-06-01',
        'tags: [ nested ]',
        '---',
        '',
        'Fixture post with a nested-path id (`2024/post`) for route resolution.',
        '',
      ].join('\n'),
    );

    // live preview: Astro's own content sync reloads the canvas (US14) — the
    // entry click navigated it to the catch-all route (single candidate)
    const canvas = page.frameLocator('#astroix-canvas');
    await expect(canvas.locator('.blog-title')).toHaveText('Renamed post', { timeout: 15_000 });

    // the echo never fights the form: the refetched payload is our own write
    // coming back, the field keeps the value, no second write cycle starts
    await expect(pane.locator('[data-astroix-form-field="title"] input')).toHaveValue(
      'Renamed post',
    );
    await expectSettled(pane);
  } finally {
    await restoreEntry(POST, original, { absent: ['Renamed post'] });
  }
});

test('UI: a write racing an external edit reloads the form from disk (banner, typed edit dropped)', async ({
  page,
}) => {
  const pane = await openEntry(page, '2024/post');
  const original = readFileSync(POST, 'utf8');
  try {
    // the typed edit keeps arming the debounce (~300ms per pause); the
    // external write lands mid-typing — under the dirty form, before the
    // POST — so the chrome's write carries a stale hash into changed disk
    const title = pane.locator('[data-astroix-form-field="title"] input');
    // one typed char arms the 300ms debounce; the external write lands well
    // inside that window, under a now-dirty form
    await title.click();
    await page.keyboard.insertText('T');
    writeFileSync(POST, original.replace('title: Nested post', 'title: External edit'));

    await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'stale',
      { timeout: 10_000 },
    );
    // Impl #10: the disk won — the form reloaded from it, the typed edit
    // was dropped, and the 409's contents never landed as our write
    await expect(pane.locator('[data-astroix-form-field="title"] input')).toHaveValue(
      'External edit',
    );
    expect(readFileSync(POST, 'utf8')).toBe(
      original.replace('title: Nested post', 'title: External edit'),
    );

    // the reload's body half: typing after the banner must land once, with
    // the file's leading blank line still single — the phantom-blank-line
    // and compounding class (the 409 truth is payload-projected; the write
    // re-anchors the trimmed draft in the raw slice's whitespace)
    const editor = pane.locator('[data-astroix-body-editor="view"]');
    await editor.locator('.cm-content').evaluate((el) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: CmView }) | null)
        ?.__astroixView;
      if (view === undefined) throw new Error('editor view not stashed');
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
    await page.keyboard.insertText(' Typed after the 409.');
    await expect
      .poll(() => readFileSync(POST, 'utf8'), { timeout: 15_000 })
      .toBe(
        original
          .replace('title: Nested post', 'title: External edit')
          .replace('for route resolution.\n', 'for route resolution. Typed after the 409.\n'),
      );
  } finally {
    await restoreEntry(POST, original, {
      absent: ['External edit', ' Typed after the 409.'],
    });
  }
});

// #149's main-side repair, pinned: the idle post-banner user. The 409's own
// invalidation (and under #133 the deferred content-synced push) refetches
// the collections payload while the form sits clean on the disk truth — the
// pane must NOT reset onto the payload's zod projection (the delta between
// the projection and the raw file would auto-write `tone`/`priority`/
// `featured` into the file and re-serialize `date`/`tags` with no user
// action at all). One truth-space: the signal re-reads the file, finds the
// loop's truth, and nothing writes.
test('UI: an idle user post-409 writes nothing — the file keeps the external edit', async ({
  page,
}) => {
  const pane = await openEntry(page, '2024/post');
  const original = readFileSync(POST, 'utf8');
  try {
    // arm the write exactly as the racing test does: one typed char under a
    // dirty form, the external write landing inside the debounce window
    const title = pane.locator('[data-astroix-form-field="title"] input');
    await title.click();
    await page.keyboard.insertText('T');
    const external = original.replace('title: Nested post', 'title: External edit');
    writeFileSync(POST, external);

    await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'stale',
      { timeout: 10_000 },
    );
    // the banner's reload won: the form shows the disk truth
    await expect(title).toHaveValue('External edit');

    // the idle window: no typing, past every push/refetch path — the 1 s
    // render grace, the loop's own invalidation, the ssr-walk refetch
    await page.waitForTimeout(4_000);

    // byte-stability is the claim: the external edit's bytes, untouched —
    // no zod normalization, no materialized defaults, no write at all
    expect(readFileSync(POST, 'utf8')).toBe(external);
    // and no write happened: the banner is still the loop's last word
    await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'stale',
    );
  } finally {
    await restoreEntry(POST, original, { absent: ['External edit'] });
  }
});

// the mount emission's no-op contract: the halves' mount reports the truth
// they mounted on, and that draft equals the baseline — nothing schedules a
// write. Guards the truth-gated mount (#149): a ref the emission reads
// before it is seeded would turn every idle open into an empty-body write.
test('UI: opening an entry and idling writes nothing — the mount emission is a no-op', async ({
  page,
}) => {
  const pane = await openEntry(page, '2024/post');
  const original = readFileSync(POST, 'utf8');
  try {
    // past the write debounce and the payload echo's refetch
    await page.waitForTimeout(1_500);
    expect(readFileSync(POST, 'utf8')).toBe(original);
    await expectSettled(pane);
  } finally {
    await restoreEntry(POST, original);
  }
});

test('IDE edit reflects live in the open chrome editor (file→chrome sync)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Select: off').click();
  await page.frameLocator('#astroix-canvas').locator('.hero-title').click();
  await page.locator('[data-astroix-rule]', { hasText: 'home.css' }).first().click();
  const editor = page.locator('[data-astroix-editor="view"]');
  await expect(editor.locator('.cm-content')).toContainText('font-weight: 800');
  const original = readFileSync(HOME_CSS, 'utf8');

  try {
    // simulate the IDE: external write to the file the editor is showing
    writeFileSync(HOME_CSS, original.replace('font-weight: 800;', 'font-weight: 700;'));

    await expect(editor.locator('.cm-content')).toContainText('font-weight: 700;', {
      timeout: 10_000,
    });
    // the external change was ACCEPTED, not treated as a pending local write
    await expect(editor.locator('[data-astroix-write-status]')).toHaveAttribute(
      'data-astroix-write-status',
      'idle',
    );
  } finally {
    writeFileSync(HOME_CSS, original);
  }
});

// #133's live-refresh contract: the chrome's collections list picks up an
// external content edit with no reload and no tab roundtrip. The signal
// chain: the srcDir file event pushes immediately (pre-commit — the loader's
// store write is debounced 500 ms), then the data-store write itself fires
// the post-commit push whose refetch lands fresh — the poll budget must
// cover both legs plus the loader sync.
test('an external content edit live-refreshes the chrome collections list — add and remove', async ({
  page,
}) => {
  if (existsSync(ENTRY_PROBE)) {
    throw new Error('stale probe entry already on disk — restore it before re-running');
  }

  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  const blog = page.locator('[data-astroix-collection="blog"]');
  await expect(blog.locator('[data-astroix-entry="hello-builder"]')).toBeVisible();

  const probe = page.locator('[data-astroix-entry="new-entry"]');
  try {
    writeFileSync(
      ENTRY_PROBE,
      '---\ntitle: Enumeration probe\ndate: 2026-08-30\n---\n\nA body for the enumeration probe.\n',
    );
    // no reload, no remount — the pushed invalidation is the only refresh
    // path this assertion allows
    await expect(probe, 'external add never live-refreshed the sidebar').toBeVisible({
      timeout: 20_000,
    });
  } finally {
    rmSync(ENTRY_PROBE, { force: true });
  }

  await expect(probe, 'external removal never live-refreshed the sidebar').toHaveCount(0, {
    timeout: 20_000,
  });
  // the fixture must be fully restored before the suite proceeds
  await expect(blog.locator('[data-astroix-entry]')).toHaveCount(3);
});
