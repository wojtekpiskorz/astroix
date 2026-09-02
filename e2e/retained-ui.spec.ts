import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import { parseEntryDraft, serializeEntry } from '../packages/core/src/entry-writer.ts';
import { collectImagePaths, type FormFieldNode } from '../packages/core/src/form-tree.ts';
import { skipWithoutChromium } from './contract-oracle/live-capture.ts';
import { MAIN_PORT, withOracleServer } from './contract-oracle/oracle-server.ts';

/**
 * The focused legacy-integration UI regression (#219, AC-3): the retained
 * presentation now lives in packages/app-shell behind prop-driven widgets,
 * and the integration chrome renders it through compatibility adapters —
 * this suite proves the product loop still works END TO END through the
 * real chrome over the real endpoints. It boots the disposable oracle
 * itself (the one-home pattern of the no-E2E interval: playwright carries
 * no webServers, oracle-server.ts owns the evidence producer's lifecycle)
 * and drives the two verticals through the same surfaces the frozen B1/B2
 * corpora describe — the rule list's matched structure (winner, media
 * badge, multi-place), the entry tree's folders and unrouted markers, the
 * form's auto-write, and the editor's splice write landing on disk.
 *
 * Each test boots its own regenerated oracle: the prep pass is
 * rm-and-recreate, so writes die with the boot — no restore dance, every
 * run starts pristine (#213's determinism contract).
 */

/** The stashed CM6 view handle the editor-driving specs use (the e2e DOM contract). */
interface CmView {
  state: { doc: { toString: () => string; length: number } };
  dispatch: (spec: { selection?: { anchor: number; head?: number } }) => void;
  focus: () => void;
}

/**
 * The chrome-boot gate (#158's contention family): the canvas iframe exists
 * only once the chrome shell mounts — wait it out with a boot-naming error,
 * with one reload hop to recover a request-scoped stall (the deleted
 * boot-gate.ts essence, inlined for this suite).
 */
async function waitForChromeBoot(page: Page): Promise<void> {
  const canvas = page.locator('#astroix-canvas');
  const booted = await canvas
    .waitFor({ state: 'visible', timeout: 105_000 })
    .then(() => true)
    .catch(() => false);
  if (!booted) {
    await page.reload();
    await expect(canvas, 'chrome boot: the builder shell never mounted').toBeVisible({
      timeout: 105_000,
    });
  }
}

/** Opens the Content tab and waits until the entry list is ready to click. */
async function openContentTab(page: Page): Promise<void> {
  // the entry click navigates only when the routes query has resolved; the
  // listener arms before the click that triggers the query
  const routesLoaded = page.waitForResponse(
    (response) => response.url().includes('/__astroix/routes') && response.status() === 200,
    { timeout: 15_000 },
  );
  await page.getByRole('tab', { name: 'Content' }).click();
  await routesLoaded;
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 15_000 });
}

test('CSS vertical: rule list through the adapter, editor open, splice write lands on disk', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  await withOracleServer('main', MAIN_PORT, async ({ base, dir }) => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(base);
      await waitForChromeBoot(page);

      // select mode on, click the hero title in the canvas
      await page.getByText('Select: off').click();
      const canvas = page.frameLocator('#astroix-canvas');
      await canvas.locator('.hero-title').click();

      // the retained rule list (widget + adapter + matcher + real index
      // payload): the frozen css-index contract's shape for this element —
      // three home.css places + the scoped rule, one winner, one media
      // badge, three multi-place hints, cid hashes never displayed
      const rules = page.locator('[data-astroix-rule]');
      await expect(rules).toHaveCount(4);
      await expect(page.locator('[data-astroix-winner="true"]')).toHaveCount(1);
      await expect(rules.first()).toContainText('src/pages/index.astro');
      await expect(page.locator('[data-astroix-media="(max-width: 640px)"]')).toHaveCount(1);
      await expect(page.locator('[data-astroix-multi]')).toHaveCount(3);
      await expect(page.locator('[data-astroix-rules]')).not.toContainText('data-astro-cid');
      await expect(page.locator('[data-astroix-selection]')).toContainText('hero-title');

      // open a home.css rule: the editor mounts with the moved header and
      // range chips, and the loop reaches idle
      await rules.nth(1).click();
      await expect(page.locator('[data-astroix-editor="view"]')).toBeVisible();
      await expect(page.locator('[data-astroix-editor="view"]')).toContainText(
        'src/pages/home.css',
      );
      await expect(page.locator('[data-astroix-write-status]')).toHaveAttribute(
        'data-astroix-write-status',
        'idle',
        { timeout: 15_000 },
      );
      // the clicked file styles the element in three places — three chips
      await expect(page.locator('[data-astroix-range-chip]')).toHaveCount(3);

      // type at the editor's end: one contiguous splice per pause (the B2
      // css-splice discipline — everything before it survives byte-identical)
      const cssPath = join(dir, 'src', 'pages', 'home.css');
      const original = readFileSync(cssPath, 'utf8');
      const suffix = '\n/* retained-ui regression */\n';
      await page.locator('[data-astroix-editor="view"] .cm-content').evaluate((el) => {
        const view = (el.closest('.cm-editor') as (HTMLElement & { __astroixView?: CmView }) | null)
          ?.__astroixView;
        if (view === undefined) throw new Error('editor view not stashed');
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.focus();
      });
      await page.keyboard.type(suffix);
      await expect
        .poll(() => readFileSync(cssPath, 'utf8'), { timeout: 15_000 })
        .toBe(`${original}${suffix}`);
      await expect(page.locator('[data-astroix-write-status]')).toHaveAttribute(
        'data-astroix-write-status',
        /(idle|saved)/,
        { timeout: 15_000 },
      );
    } finally {
      await browser.close();
    }
  });
});

test('Content vertical: entry tree through the adapter, form auto-write lands verbatim', {
  tag: '@oracle-boot',
}, async () => {
  skipWithoutChromium();
  test.setTimeout(240_000);
  await withOracleServer('main', MAIN_PORT, async ({ base, dir }) => {
    const browser: Browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.goto(base);
      await waitForChromeBoot(page);
      await openContentTab(page);

      // the retained entry tree (widget + adapter over the real collections
      // and routes payloads): nested ids under their year folders, flat ids
      // bare, and the frozen route-resolution corpus's unrouted truth —
      // scratch renders the marker, the routed posts do not
      await expect(page.locator('[data-astroix-tree-folder="blog/2024"]')).toBeVisible();
      await expect(page.locator('[data-astroix-entry="hello-builder"]')).toBeVisible();
      await expect(page.locator('[data-astroix-entry="scratch"]')).toHaveAttribute(
        'data-astroix-entry-unrouted',
        'true',
      );
      await expect(page.locator('[data-astroix-entry="2024/post"]')).not.toHaveAttribute(
        'data-astroix-entry-unrouted',
        'true',
      );

      // open an entry: the pane mounts on the raw truth, the loop idles
      await page.locator('[data-astroix-entry="hello-builder"]').click();
      const pane = page.locator('[data-astroix-content-pane="form"]');
      await expect(pane).toBeVisible();
      await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
        'data-astroix-write-status',
        'idle',
        { timeout: 15_000 },
      );

      // the retained form widgets: edit the title, the auto-write loop
      // lands the whole-file write. Expected bytes are DERIVED with the
      // same pure core modules the chrome's loop serializes through (the
      // B2 derived-vs-observed doctrine — e.g. the serializer's flow-array
      // spacing `tags: [ meta ]` is frozen corpus behavior, not drift)
      const entryPath = join(dir, 'src', 'content', 'blog', 'hello-builder.md');
      const original = readFileSync(entryPath, 'utf8');
      const baseline = parseEntryDraft(original);
      if (baseline === null) throw new Error('oracle entry does not parse as an entry draft');
      const schema = (await (
        await page.request.get(`${base}/__astroix/content-schema`, {
          params: { collection: 'blog' },
        })
      ).json()) as { fields: FormFieldNode[] };
      const expected = serializeEntry({
        raw: original,
        baseline,
        draft: {
          data: { ...(baseline.data as Record<string, unknown>), title: 'Hello builder, retitled' },
          body: baseline.body,
        },
        protectedPaths: collectImagePaths(schema.fields),
      });
      await pane.locator('[data-astroix-form-field="title"] input').fill('Hello builder, retitled');
      await expect.poll(() => readFileSync(entryPath, 'utf8'), { timeout: 15_000 }).toBe(expected);
      await expect(pane.locator('[data-astroix-write-status]')).toHaveAttribute(
        'data-astroix-write-status',
        /(idle|saved)/,
        { timeout: 15_000 },
      );

      // the root raw field renders for the schema-less collection (the
      // frozen content-schemas walk: one raw field at the root)
      await page.locator('[data-astroix-entry="scratch"]').click();
      await expect(page.locator('[data-astroix-raw-field=""]')).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await browser.close();
    }
  });
});
