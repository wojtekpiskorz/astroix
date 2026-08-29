import { expect, type Locator, type Page, test } from '@playwright/test';

// The body editor's round-trip on the fixture entry (issue #73): the loaded
// `entry.body` renders in CodeMirror, typing and toolbar actions edit the doc,
// the emitted-markdown seam fires, and native Cmd+Z undoes through toolbar and
// typed transactions alike (the undo note on the ticket — #74 builds the
// write loop on exactly that history stream).
//
// No disk writes here: persistence is #74; this slice ends at the emit seam
// (`data-astroix-body-emitted` mirrors the last emitted markdown's length,
// the doc itself is asserted through the stashed view like editor.spec.ts).

/** The stashed-view handle as exercised in editor.spec.ts — the same change path as typing. */
interface CmView {
  state: { doc: { toString: () => string; length: number } };
  dispatch: (spec: { selection?: { anchor: number; head?: number } }) => void;
  focus: () => void;
}

// evaluate callbacks serialize alone — the view extraction inlines in each
// (the editor.spec.ts pattern); outer-scope helpers don't carry over
async function openBodyEditor(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  const editor = page.locator('[data-astroix-body-editor="view"]');
  // generous: the content sync can lag the dev server's listen (content.spec.ts)
  await expect(editor).toBeVisible({ timeout: 10_000 });
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

async function emittedLength(page: Page): Promise<number> {
  const value = await page
    .locator('[data-astroix-body-emitted]')
    .getAttribute('data-astroix-body-emitted');
  if (value === null) throw new Error('emit seam not rendered');
  return Number(value);
}

test('the pane edits the first body-bearing entry with the markdown toolbar', async ({ page }) => {
  const editor = await openBodyEditor(page);

  // deterministic placeholder pick (payload order: collection name, then id)
  await expect(page.locator('[data-astroix-content-pane="body"] code')).toHaveText(
    'blog/2024/post',
  );
  await expect(editor.locator('.cm-content')).toContainText('Fixture post with a nested-path id');

  const toolbar = page.locator('[data-astroix-md-toolbar]');
  for (const action of ['bold', 'heading', 'link'] as const) {
    await expect(toolbar.locator(`[data-astroix-md-action="${action}"]`)).toBeVisible();
  }
});

test('typing edits the doc and fires the emitted-markdown seam', async ({ page }) => {
  const editor = await openBodyEditor(page);
  const original = await readDoc(editor);
  expect(await emittedLength(page)).toBe(original.length);

  await placeCursor(editor, original.length);
  await page.keyboard.type(' Typed in the builder.');

  // the doc is the committed truth — hard equality
  expect(await readDoc(editor)).toBe(`${original} Typed in the builder.`);
  // the seam's pane state renders through React — poll for its commit (slow
  // runners flush the re-render behind Playwright's next command); a dead
  // seam stays at the initial length and times out
  await expect
    .poll(() => emittedLength(page), {
      timeout: 5_000,
      message: 'emitted-markdown seam never carried the typed doc',
    })
    .toBe(original.length + ' Typed in the builder.'.length);
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
  await expect
    .poll(() => emittedLength(page), { timeout: 5_000, message: 'bold wrap never emitted' })
    .toBe(original.length + 4);
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
