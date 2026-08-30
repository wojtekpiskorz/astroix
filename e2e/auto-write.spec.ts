import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type CmView, expectSettled, openEntry } from './entry-pane';
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
//
// The push-driven half of the loop (the write's echo through the hot
// channel, the stale banner, the mount-emission guard) lives in
// live-refresh.spec.ts on the source lane since #150 — this lane boots the
// prebuilt chrome, whose bundle has no hot subscriptions.

test.describe.configure({ mode: 'serial' });

// every test waits out the host's content sync at least once — genuinely slow
test.slow();

const POST = join('e2e', 'fixture', 'src', 'content', 'blog', '2024', 'post.md');
const SHOWCASE = join('e2e', 'fixture', 'src', 'content', 'gallery', 'showcase.md');
const SCRATCH = join('e2e', 'fixture', 'src', 'content', 'notes', 'scratch.md');

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

// #149's main-side repair, pinned: the idle post-banner user. The 409's own
// invalidation (and under #133 the deferred content-synced push) refetches
// the collections payload while the form sits clean on the disk truth — the
// pane must NOT reset onto the payload's zod projection (the delta between
// the projection and the raw file would auto-write `tone`/`priority`/
// `featured` into the file and re-serialize `date`/`tags` with no user
// action at all). One truth-space: the signal re-reads the file, finds the
// loop's truth, and nothing writes.
// the mount emission's no-op contract: the halves' mount reports the truth
// they mounted on, and that draft equals the baseline — nothing schedules a
// write. Guards the truth-gated mount (#149): a ref the emission reads
// before it is seeded would turn every idle open into an empty-body write.
