import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { restoreEntry } from './entry-restore';

// The content auto-write loop (issue #74, spec Impl #9): draft pause →
// serialize → whole-file write → Astro's own sync reloading the canvas; the
// hash guard (Impl #10) turns a disk race into a reload, never a corruption.
//
// Serial: the tests rewrite fixture entries on disk. Every test restores in
// its finally AND waits for the host's content sync to observe the restore —
// the next test then opens on a settled server, where the write path is
// deterministic. The disk bytes are the asserted outcome; the status chip is
// secondary (never error/stale at rest).

test.describe.configure({ mode: 'serial' });

// every test waits out the host's content sync at least once — genuinely slow
test.slow();

const POST = join('e2e', 'fixture', 'src', 'content', 'blog', '2024', 'post.md');
const SHOWCASE = join('e2e', 'fixture', 'src', 'content', 'gallery', 'showcase.md');
const SCRATCH = join('e2e', 'fixture', 'src', 'content', 'notes', 'scratch.md');

/** The stashed CM6 view handle (body-editor.spec's CmView, body-append slice). */
interface CmView {
  state: { doc: { toString: () => string; length: number } };
  dispatch: (spec: { selection?: { anchor: number } }) => void;
  focus: () => void;
}

async function openEntry(page: Page, entry: string): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator(`[data-astroix-entry="${entry}"]`).click();
  const pane = page.locator('[data-astroix-content-pane="form"]');
  await expect(pane).toBeVisible();
  // the loop's raw baseline must be loaded before any edit can schedule
  await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
    'data-astroix-write-status',
    'idle',
    { timeout: 10_000 },
  );
  return pane;
}

/** The loop came to rest without conflict or failure. */
async function expectSettled(pane: Locator): Promise<void> {
  await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
    'data-astroix-write-status',
    /(idle|saved)/,
    { timeout: 15_000 },
  );
}

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

test('a body edit writes below the closing delimiter with the frontmatter verbatim', async ({
  page,
}) => {
  const pane = await openEntry(page, '2024/post');
  const original = readFileSync(POST, 'utf8');
  try {
    const editor = pane.locator('[data-astroix-body-editor="view"]');
    await editor.locator('.cm-content').evaluate((el) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: CmView }) | null)
        ?.__astroixView;
      if (view === undefined) throw new Error('editor view not stashed');
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
    await page.keyboard.type(' Body typed in the builder.');
    // the typed suffix reaching disk is the outcome; the frontmatter slice
    // staying byte-identical is the byte-surgery claim
    const fmEnd = original.indexOf('\n---\n') + 5;
    await expect
      .poll(
        () => {
          const next = readFileSync(POST, 'utf8');
          return (
            next.endsWith(' Body typed in the builder.\n') &&
            next.startsWith(original.slice(0, fmEnd))
          );
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
    await expectSettled(pane);
  } finally {
    await restoreEntry(POST, original, { absent: [' Body typed in the builder.'] });
  }
});

test('image() round-trips untouched while a sibling field is written (gallery)', async ({
  page,
}) => {
  const pane = await openEntry(page, 'showcase');
  const original = readFileSync(SHOWCASE, 'utf8');
  try {
    await pane.locator('[data-astroix-form-field="alt"] input').fill('A finer pixel');
    await expect
      .poll(() => readFileSync(SHOWCASE, 'utf8'), { timeout: 15_000 })
      .toBe(original.replace('alt: A single pixel', 'alt: A finer pixel'))
      .catch(async () => {
        throw new Error(
          `gallery write never landed; status=${await pane.locator('[data-astroix-write-status]').getAttribute('data-astroix-write-status')} alt=${await pane.locator('[data-astroix-form-field="alt"] input').inputValue()}`,
        );
      });
    await expectSettled(pane);
  } finally {
    await restoreEntry(SHOWCASE, original, { absent: ['A finer pixel'] });
  }
});

test('the root raw field writes the whole draft (schema-less collection)', async ({ page }) => {
  const pane = await openEntry(page, 'scratch');
  const original = readFileSync(SCRATCH, 'utf8');
  try {
    // the extra key is the restore probe's marker — a unique string in
    // astro's value pool once the draft persists
    await pane
      .locator('[data-astroix-raw-field=""]')
      .fill('kind: scratchpad\npinned: false\nnote: zz-restore-probe');
    await expect
      .poll(() => readFileSync(SCRATCH, 'utf8'), { timeout: 15_000 })
      .toBe(
        [
          '---',
          'kind: scratchpad',
          'pinned: false',
          'note: zz-restore-probe',
          '---',
          '',
          'A schema-less note — any frontmatter passes through untouched.',
          '',
        ].join('\n'),
      );
    await expectSettled(pane);
  } finally {
    await restoreEntry(SCRATCH, original, { absent: ['zz-restore-probe'] });
  }
});

test('REST: the write endpoint refuses a stale hash and hands back disk truth', async ({
  page,
}) => {
  const original = readFileSync(POST, 'utf8');
  try {
    const response = await page.request.post('/__astroix/content-write', {
      data: {
        file: 'src/content/blog/2024/post.md',
        contents: '---\ntitle: Stale\n---\nbody\n',
        expected: '0'.repeat(64),
      },
    });
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { contents?: string };
    expect(body.contents).toContain('title: Nested post');
    expect(readFileSync(POST, 'utf8')).toBe(original);
  } finally {
    writeFileSync(POST, original);
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

    // the idle window: no typing, past every push/refetch path — the
    // loader leg's canvas-load-sequenced invalidation (3 s fallback bound,
    // #155), the loop's own invalidation, the ssr-walk refetch
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
