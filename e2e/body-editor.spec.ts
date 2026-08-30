import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { CmView } from './entry-pane';
import { restoreEntry } from './entry-restore';

// Since #74 every doc edit persists through the auto-write loop — the
// editing tests restore the fixture entry so the specs that follow read
// pristine bytes.
const POST = join('e2e', 'fixture', 'src', 'content', 'blog', '2024', 'post.md');
// captured before any test runs: the spec opens on pristine bytes, and the
// hook below restores them even when an assertion fails mid-edit
const ORIGINAL_POST = readFileSync(POST, 'utf8');

test.afterEach(async () => {
  await restoreEntry(POST, ORIGINAL_POST, {
    absent: [' Typed in the builder.', '**Fixture**', '#### ', '[resolution]'],
  });
});

// The body editor's round-trip on the fixture entry (issue #73): the loaded
// `entry.body` renders in CodeMirror, typing and toolbar actions edit the doc,
// and native Cmd+Z undoes through toolbar and typed transactions alike (the
// undo note on the ticket — #74 builds the write loop on exactly that
// history stream).
//
// Since #72 the pane renders the schema-generated form around the editor;
// the draft lives in the pane's refs, not DOM state, so these specs assert
// the committed doc through the stashed view like editor.spec.ts.

/** The stashed-view handle as exercised in editor.spec.ts — the same change path as typing. */
// evaluate callbacks serialize alone — the view extraction inlines in each
// (the editor.spec.ts pattern); outer-scope helpers don't carry over
async function openBodyEditor(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  // the pane is selection-driven since #71 (at `/` route resolution is
  // silent) — open the payload-order entry the pane used to pick itself
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-astroix-entry="2024/post"]').click();
  const editor = page.locator('[data-astroix-body-editor="view"]');
  await expect(editor).toBeVisible();
  return editor;
}

async function readDoc(editor: Locator): Promise<string> {
  return await editor.locator('.cm-content').evaluate((el) => {
    const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: CmView }) | null)
      ?.__astroixView;
    if (view === undefined) throw new Error('editor view not stashed');
    return view.state.doc.toString();
  });
}

/** Dispatches a selection through the view and focuses the editor. */
async function setSelection(editor: Locator, anchor: number, head?: number): Promise<void> {
  await editor.locator('.cm-content').evaluate(
    (el, at) => {
      const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: CmView }) | null)
        ?.__astroixView;
      if (view === undefined) throw new Error('editor view not stashed');
      view.dispatch({ selection: { anchor: at.anchor, head: at.head } });
      view.focus();
    },
    { anchor, head },
  );
}

/** Selects `text`'s first occurrence (doc read TS-side) and focuses the editor. */
async function selectText(editor: Locator, text: string): Promise<void> {
  const from = (await readDoc(editor)).indexOf(text);
  if (from === -1) throw new Error(`not found in doc: ${text}`);
  await setSelection(editor, from, from + text.length);
}

/** Places the caret at `pos` through the view and focuses the editor. */
async function placeCursor(editor: Locator, pos: number): Promise<void> {
  await setSelection(editor, pos);
}

test('the pane opens the deterministic entry inside the schema form with the markdown toolbar', async ({
  page,
}) => {
  const editor = await openBodyEditor(page);

  // deterministic placeholder pick (payload order: collection name, then id)
  await expect(page.locator('[data-astroix-content-pane="form"] code')).toHaveText(
    'blog/2024/post',
  );
  await expect(editor.locator('.cm-content')).toContainText('Fixture post with a nested-path id');

  const toolbar = page.locator('[data-astroix-md-toolbar]');
  for (const action of ['bold', 'heading', 'link'] as const) {
    await expect(toolbar.locator(`[data-astroix-md-action="${action}"]`)).toBeVisible();
  }
});

test('typing edits the doc', async ({ page }) => {
  const editor = await openBodyEditor(page);
  const original = await readDoc(editor);

  await placeCursor(editor, original.length);
  await page.keyboard.type(' Typed in the builder.');

  // the doc is the committed truth — hard equality
  expect(await readDoc(editor)).toBe(`${original} Typed in the builder.`);
});

test('the toolbar emits markdown: bold wrap/unwrap, heading toggle, link over the placeholder', async ({
  page,
}) => {
  const editor = await openBodyEditor(page);
  const original = await readDoc(editor);
  const bolded = page.getByRole('button', { name: 'Bold (markdown)' });
  const heading = page.getByRole('button', { name: 'Heading (markdown)' });
  const link = page.getByRole('button', { name: 'Link (markdown)' });

  // bold: wrap (selection stays on the inner text), then unwrap — toggle both ways
  await selectText(editor, 'Fixture');
  await bolded.click();
  expect(await readDoc(editor)).toBe(original.replace('Fixture', '**Fixture**'));
  await selectText(editor, 'Fixture'); // inside the **…** pair now
  await bolded.click();
  expect(await readDoc(editor)).toBe(original);

  // heading: prefix toggles on, then off, and a deeper level normalizes to `## `
  await placeCursor(editor, 0);
  await heading.click();
  expect(await readDoc(editor)).toBe(`## ${original}`);
  await heading.click();
  expect(await readDoc(editor)).toBe(original);
  await placeCursor(editor, 0);
  await page.keyboard.type('#### ');
  await heading.click();
  const headingOut = `## ${original}`;
  expect(await readDoc(editor)).toBe(headingOut);

  // link: the selection wraps as [text](url) with the placeholder selected —
  // typing replaces it, proving the caret contract functionally
  await selectText(editor, 'resolution');
  await link.click();
  expect(await readDoc(editor)).toBe(headingOut.replace('resolution', '[resolution](url)'));
  await page.keyboard.type('docs');
  expect(await readDoc(editor)).toBe(headingOut.replace('resolution', '[resolution](docs)'));
});

test('native Cmd+Z undoes toolbar and typed edits back to the loaded body', async ({ page }) => {
  const editor = await openBodyEditor(page);
  const original = await readDoc(editor);

  // one toolbar transaction + one typed group on top
  await selectText(editor, 'Fixture');
  await page.getByRole('button', { name: 'Bold (markdown)' }).click();
  await page.keyboard.type('x'); // replaces the selected inner text
  expect(await readDoc(editor)).not.toBe(original);

  // the toolbar never stole focus (each button prevents its own mousedown
  // default), so the editor's own history keymap receives the undo directly —
  // CM6 binds Mod-z (Cmd locally, Ctrl on CI's Linux), hence the portable chord
  let doc = await readDoc(editor);
  for (let step = 0; step < 10 && doc !== original; step += 1) {
    await page.keyboard.press('ControlOrMeta+z');
    doc = await readDoc(editor);
  }
  expect(doc).toBe(original);
});
