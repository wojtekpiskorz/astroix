import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import type { FormFieldNode } from '../src/core/form-tree';
import { restoreEntry } from './entry-restore';

const POST = join('e2e', 'fixture', 'src', 'content', 'blog', '2024', 'post.md');
const SCRATCH = join('e2e', 'fixture', 'src', 'content', 'notes', 'scratch.md');

// The schema-generated form (issue #72): the fixture's blog schema walks into
// a widget tree (REST contract), the pane renders every mapped widget from
// it, and the advisory validation loop runs inline without ever gating
// (US11/US12 — there is no save to gate in this slice; #74 wires the seam).

interface SchemaPayload {
  collection: string;
  fields: FormFieldNode[];
}

interface ValidatePayload {
  ok: boolean;
  issues: { path: string; code: string; message: string }[];
}

function node(fields: FormFieldNode[], path: string): FormFieldNode {
  const found = fields.find((field) => field.path === path);
  if (found === undefined) throw new Error(`no node at ${path}`);
  return found;
}

async function getSchema(page: Page, collection: string): Promise<SchemaPayload> {
  const response = await page.request.get('/__astroix/content-schema', {
    params: { collection },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as SchemaPayload;
}

test('GET /__astroix/content-schema walks the blog schema into the widget tree', async ({
  page,
}) => {
  // the fixture sync can lag the dev server's listen (content.spec.ts)
  await expect
    .poll(async () => (await page.request.get('/__astroix/collections')).status(), {
      timeout: 10_000,
    })
    .toBe(200);

  const { fields } = await getSchema(page, 'blog');
  expect(node(fields, 'title')).toMatchObject({ kind: 'string', required: true });
  expect(node(fields, 'date')).toMatchObject({ kind: 'raw', reason: 'date', required: true });
  expect(node(fields, 'tags')).toMatchObject({
    kind: 'array',
    item: { kind: 'string' },
    required: false,
    initial: [],
  });
  expect(node(fields, 'tone')).toMatchObject({
    kind: 'enum',
    options: ['bold', 'calm'],
    required: false,
    initial: 'bold',
  });
  expect(node(fields, 'priority')).toMatchObject({ kind: 'number', required: false, initial: 0 });
  expect(node(fields, 'featured')).toMatchObject({
    kind: 'boolean',
    required: false,
    initial: false,
  });
  const meta = node(fields, 'meta');
  expect(meta).toMatchObject({ kind: 'group', required: false });
  if (meta.kind !== 'group') throw new Error('unreachable');
  expect(node(meta.children, 'meta.source')).toMatchObject({
    kind: 'string',
    required: false,
  });
  // the deliberately-unsupported field — the raw-field convention's anchor
  expect(node(fields, 'aside')).toMatchObject({ kind: 'raw', reason: 'union', required: false });
});

test('GET /__astroix/content-schema walks homepage with its optional fieldset', async ({
  page,
}) => {
  const { fields } = await getSchema(page, 'homepage');
  expect(node(fields, 'lead')).toMatchObject({ kind: 'string', required: true });
  expect(node(fields, 'image')).toMatchObject({ kind: 'string', required: false });
  const cta = node(fields, 'cta');
  expect(cta).toMatchObject({ kind: 'group', required: false });
  if (cta.kind !== 'group') throw new Error('unreachable');
  expect(cta.children.map((child) => child.path)).toEqual(['cta.label', 'cta.href']);
});

test('the schema endpoint rejects missing or unknown collections', async ({ page }) => {
  const missing = await page.request.get('/__astroix/content-schema');
  expect(missing.status()).toBe(400);
  const unknown = await page.request.get('/__astroix/content-schema', {
    params: { collection: 'nope' },
  });
  expect(unknown.status()).toBe(400);
});

test('POST /__astroix/content-validate projects issues onto dotted paths', async ({ page }) => {
  const valid = await page.request.post('/__astroix/content-validate', {
    params: { collection: 'blog' },
    data: {
      title: 'Nested post',
      date: '2024-06-01T00:00:00.000Z',
      tags: ['nested'],
      tone: 'bold',
      priority: 0,
      featured: false,
    },
  });
  expect(valid.status()).toBe(200);
  expect(((await valid.json()) as ValidatePayload).ok).toBe(true);

  const invalid = await page.request.post('/__astroix/content-validate', {
    params: { collection: 'blog' },
    data: {
      title: 'ab', // min(3)
      date: '2024-06-01T00:00:00.000Z',
      tags: ['ok', 42], // second row is not a string
      tone: 'loud', // not in the enum
    },
  });
  const payload = (await invalid.json()) as ValidatePayload;
  expect(payload.ok).toBe(false);
  const paths = payload.issues.map((issue) => issue.path).sort();
  expect(paths).toEqual(['tags.1', 'title', 'tone']);
});

async function openFormPane(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  // the pane is selection-driven since #71 (at `/` route resolution is
  // silent) — open the payload-order entry the pane used to pick itself
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-astroix-entry="2024/post"]').click();
  const pane = page.locator('[data-astroix-content-pane="form"]');
  await expect(pane).toBeVisible();
  return pane;
}

test('the pane renders the generated form over the active entry', async ({ page }) => {
  const pane = await openFormPane(page);

  // the active entry's id rides the pane header
  await expect(pane.locator('code')).toHaveText('blog/2024/post');

  const title = pane.locator('[data-astroix-form-field="title"] input');
  await expect(title).toHaveValue('Nested post');
  await expect(pane.locator('[data-astroix-form-field="priority"] input')).toHaveValue('0');
  await expect(
    pane.locator('[data-astroix-form-field="featured"] [role="checkbox"]'),
  ).toHaveAttribute('aria-checked', 'false');
  await expect(pane.locator('[data-astroix-form-field="tags.0"] input')).toHaveValue('nested');
  await expect(pane.locator('[data-astroix-form-field="meta.source"] input')).toHaveValue('');
  await expect(pane.locator('[data-astroix-form-field="tone"] [role="combobox"]')).toContainText(
    'bold',
  );

  // the raw fields: the date's zod output as YAML, the union's reason marked
  const date = pane.locator('[data-astroix-raw-field="date"]');
  await expect(date).toHaveValue(/2024-06-01/);
  await expect(date).toHaveAttribute('data-astroix-raw-reason', 'date');
  await expect(pane.locator('[data-astroix-raw-field="aside"]')).toHaveAttribute(
    'data-astroix-raw-reason',
    'union',
  );

  // the body editor still owns the lower half of the pane
  await expect(pane.locator('[data-astroix-body-editor="view"]')).toBeVisible();
});

test('inline validation shows issues per field and never gates editing', async ({ page }) => {
  const pane = await openFormPane(page);
  const title = pane.locator('[data-astroix-form-field="title"] input');
  await expect(title).toHaveValue('Nested post');
  const original = readFileSync(POST, 'utf8');

  // break the min(3) contract and blur — the flush path validates immediately
  await title.fill('ab');
  await title.blur();
  const issue = pane.locator('[data-astroix-field-issue="title"]');
  await expect(issue).toBeVisible();
  await expect(issue).toContainText(/small/i);

  // US12: the violating draft is editable — nothing disabled, nothing blocked
  await title.fill('abc');
  await expect(title).toHaveValue('abc');
  await expect(issue).toBeHidden();
  // since #74 the violating draft also lands on disk (~300ms after the
  // pause, Impl #9) — restore the fixture for the specs that follow
  await restoreEntry(POST, original);
});

test('enum select and repeatable rows edit the draft', async ({ page }) => {
  const pane = await openFormPane(page);
  const original = readFileSync(POST, 'utf8');

  // enum: open the popup (portaled — the .dark re-scope keeps tokens on it)
  const tone = pane.locator('[data-astroix-form-field="tone"] [role="combobox"]');
  await tone.click();
  await page.getByRole('option', { name: 'calm' }).click();
  await expect(tone).toContainText('calm');

  // array: a second row appears, edits, and removes
  await pane.locator('[data-astroix-array-add="tags"]').click();
  const secondRow = pane.locator('[data-astroix-form-field="tags.1"] input');
  await expect(secondRow).toHaveValue('');
  await secondRow.fill('second');
  await expect(secondRow).toHaveValue('second');
  await pane.locator('[data-astroix-array-remove="1"]').click();
  await expect(pane.locator('[data-astroix-form-field="tags.1"]')).toHaveCount(0);
  await expect(pane.locator('[data-astroix-form-field="tags.0"] input')).toHaveValue('nested');
  await restoreEntry(POST, original);
});

test('the raw field flags YAML syntax errors locally', async ({ page }) => {
  const pane = await openFormPane(page);
  const original = readFileSync(POST, 'utf8');

  const aside = pane.locator('[data-astroix-raw-field="aside"]');
  await aside.fill('a: [');
  const syntaxIssue = pane.locator('[data-astroix-field-issue="aside"]');
  await expect(syntaxIssue).toBeVisible();
  await expect(syntaxIssue).toContainText('YAML');

  // recovering parses cleanly — the local flag clears (and, since #74,
  // the parsed value persists — restore for the specs that follow)
  await aside.fill('a plain value');
  await expect(syntaxIssue).toBeHidden();
  await restoreEntry(POST, original);
});

test('a schema-less collection degrades to the root raw field over the whole draft', async ({
  page,
}) => {
  // REST: the walk's every-collection-opens promise
  const { fields } = await getSchema(page, 'notes');
  expect(fields).toEqual([
    { kind: 'raw', path: '', label: 'frontmatter', required: true, reason: 'unwalkable' },
  ]);

  // the pane: the root raw textarea holds the entry's whole frontmatter as
  // YAML and edits replace the draft itself (no phantom '' key — round 2)
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-astroix-entry="scratch"]').click();
  const pane = page.locator('[data-astroix-content-pane="form"]');
  await expect(pane).toBeVisible();
  const scratchOriginal = readFileSync(SCRATCH, 'utf8');

  const root = pane.locator('[data-astroix-raw-field=""]');
  await expect(root).toHaveValue(/kind: scratchpad/);
  await expect(root).toHaveAttribute('data-astroix-raw-reason', 'unwalkable');

  // editing the YAML replaces the whole draft — a syntax error stays local
  await root.fill('pinned: false');
  await expect(pane.locator('[data-astroix-field-issue=""]')).toBeHidden();
  await root.fill('a: [');
  await expect(pane.locator('[data-astroix-field-issue=""]')).toBeVisible();
  await root.fill('kind: scratchpad');
  await expect(pane.locator('[data-astroix-field-issue=""]')).toBeHidden();
  // since #74 the parsed draft persists — restore the fixture entry
  await restoreEntry(SCRATCH, scratchOriginal);
});

test('the function-schema arm: image() marks a read-only metadata node end to end', async ({
  page,
}) => {
  // REST: the walker marks the stubbed image() through membership — the
  // runtime handoff astro's canonical schema form exists for
  const { fields } = await getSchema(page, 'gallery');
  expect(node(fields, 'hero')).toMatchObject({ kind: 'image', required: true });
  expect(node(fields, 'alt')).toMatchObject({ kind: 'string', required: true });

  // the pane: astro's own parse resolved the field to real metadata; the
  // widget renders it read-only — no input, src/width/height from entry.data
  await page.goto('/');
  await page.getByRole('tab', { name: 'Content' }).click();
  await expect(page.locator('[data-astroix-entries="ready"]')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-astroix-entry="showcase"]').click();
  const pane = page.locator('[data-astroix-content-pane="form"]');
  await expect(pane).toBeVisible();

  const meta = pane.locator('[data-astroix-image-field="meta"]');
  await expect(meta).toBeVisible();
  await expect(meta).toContainText('pixel.png');
  // width/height asserted per row — a resolution regression must fail, not
  // pass on a stray '1' somewhere in the block (round 5)
  // :text-is anchors on the dt label — the dev image src can carry a
  // width-bearing query param, so substring filtering would match it too
  await expect(meta.locator('div:has(> dt:text-is("width")) > dd')).toHaveText('1');
  await expect(meta.locator('div:has(> dt:text-is("height")) > dd')).toHaveText('1');
  await expect(pane.locator('[data-astroix-form-field="hero"] input')).toHaveCount(0);
});
