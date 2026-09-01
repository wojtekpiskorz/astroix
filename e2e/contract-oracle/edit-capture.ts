import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  type EntryDraft,
  parseEntryDraft,
  serializeEntry,
  splitEntryFile,
} from '../../packages/core/src/entry-writer.ts';
import { spliceText } from '../../packages/core/src/splice-writer.ts';
import type {
  ContentBodyWriteFixture,
  ContentValidateFixture,
  ContentWriteFixture,
  CssScopedSpliceFixture,
  CssSpliceFixture,
  EditConflictFixture,
  EditNegativesFixture,
} from '../behavior-contracts/schema/edit-contract.ts';
import { EDIT_CONTRACT_VERSION } from '../behavior-contracts/schema/edit-contract.ts';
import type { CssIndexFixture } from '../behavior-contracts/schema/inspection-contract.ts';
import { CID_FORM } from '../behavior-contracts/schema/inspection-contract.ts';
import { getJson, poll } from './live-capture.ts';

/**
 * The live edit-contract capture (#217, lane B2): drives a booted disposable
 * oracle's WRITE surfaces honestly — real POST /__astroix/edit splices, real
 * POST /__astroix/content-write whole-file writes, real advisory-validation
 * probes — and freezes request/response pairs plus before/after file bytes.
 * The client half of each cycle (the splice range located over observed
 * bytes, the posted `contents` serialized by the pure entry-writer over the
 * observed baseline) is computed with the same core modules the chrome's
 * auto-write loop uses: the corpus observes the oracle, and derives only
 * what the real client derives. Both the corpus writer (capture.mjs) and the
 * freeze spec (contracts-edit.spec.ts) call this same module — the
 * comparison is over one pipeline, never two.
 *
 * Determinism mechanism: the oracle is regenerated pristine on every boot;
 * REST writes are synchronous (writeFileSync before the response), so a leg
 * settles on its response plus a fresh disk read; the one asynchronous seam
 * — the scoped style module's re-transform after an .astro edit — settles
 * through a page reload and a poll on the served index, the same
 * deterministic settlement B1's capture uses (never fixed sleeps). Legs run
 * in the fixed order of this function; each leg's baseline is the disk it
 * observes at its moment, so any fixed replay reproduces every byte.
 */

/** The served index record shape — one home, the inspection contract's. */
type IndexRecord = CssIndexFixture['records'][number];

export interface EditCaptureOptions {
  /** The booted oracle's base URL (http://localhost:<port>). */
  base: string;
  /** The oracle copy's absolute root — the anchor for the scenario fs writes (never frozen). */
  root: string;
}

export interface EditCorpus {
  cssSplice: CssSpliceFixture;
  cssScopedSplice: CssScopedSpliceFixture;
  cssConflict: EditConflictFixture;
  contentFrontmatter: ContentWriteFixture;
  contentBody: ContentBodyWriteFixture;
  contentValidate: ContentValidateFixture;
  contentConflict: EditConflictFixture;
  editNegatives: EditNegativesFixture;
}

/** One frozen edit fixture file: which captured leg it freezes. */
export interface EditCorpusManifestEntry {
  file: string;
  leg: keyof EditCorpus;
}

/**
 * The edit corpus manifest — the SINGLE enumeration of the frozen edit
 * fixture set (#217), mirroring B1's CORPUS_MANIFEST discipline: capture.mjs
 * writes exactly these files, the freeze spec re-derives exactly these
 * files, and the spec asserts agreement with the schema registry's keys —
 * a leg that misses this list fails the spec, never silently stops
 * re-deriving.
 */
export const EDIT_CORPUS_MANIFEST: readonly EditCorpusManifestEntry[] = [
  { file: 'css-splice.json', leg: 'cssSplice' },
  { file: 'css-scoped-splice.json', leg: 'cssScopedSplice' },
  { file: 'css-conflict.json', leg: 'cssConflict' },
  { file: 'content-frontmatter-write.json', leg: 'contentFrontmatter' },
  { file: 'content-body-write.json', leg: 'contentBody' },
  { file: 'content-validate.json', leg: 'contentValidate' },
  { file: 'content-conflict.json', leg: 'contentConflict' },
  { file: 'edit-negatives.json', leg: 'editNegatives' },
];

// --- scenario inputs (the client-side choices a builder user makes) ---

const HOME_CSS = 'src/pages/home.css';
const INDEX_ASTRO = 'src/pages/index.astro';
const POST_MD = 'src/content/blog/2024/post.md';
const HELLO_MD = 'src/content/blog/hello-builder.md';

/** The declaration bytes leg 1 replaces — unique in home.css. */
const SPLICE_ANCHOR = 'font-size: 3rem;';
const SPLICE_REPLACEMENT = 'font-size: 3.5rem;';

/** The scoped selector leg 2 renames, and its new name. */
const RENAMED_SELECTOR = '.hero-headline';

/** The out-of-band disk changes (the IDE/agent races the guard exists for). */
const CSS_INTERFERENCE_FROM = 'gap: 1rem;';
const CSS_INTERFERENCE_TO = 'gap: 1.5rem;';
const CONTENT_INTERFERENCE_FROM = 'title: Hello builder';
const CONTENT_INTERFERENCE_TO = 'title: Hello builder (external)';

/** The stale css attempt's edit — refused, never lands. */
const CONFLICT_ANCHOR = 'border-radius: 0.5rem;';
const CONFLICT_REPLACEMENT = 'border-radius: 0.25rem;';

/**
 * Leg 4's scenario baseline: the canonical post entry with a file-only key
 * carrying a comment and quoted styling above it — the proven-preservation
 * shape of the entry-writer unit suite, observed here end-to-end through
 * the real write endpoint. Written into the oracle copy before the cycle
 * (scenario input, like B1's where-oracle config generation).
 */
const COMMENTED_POST = [
  '---',
  'title: Nested post',
  'date: 2024-06-01',
  'tags: [nested]',
  '# author comment',
  'author: "Quoted Name"',
  '---',
  '',
  'Fixture post with a nested-path id (`2024/post`) for route resolution.',
  '',
].join('\n');

const FRONTMATTER_EDIT = { key: 'title', to: 'Nested post (edited)' };
const BODY_SUFFIX = ' Body typed in the builder.';
const ADVISORY_TITLE = 'ab'; // min(3) violation — the advisory loop's flag

/** The advisory probes' drafts — the payload shapes the deleted legacy spec drove. */
const VALID_DRAFT = {
  title: 'Nested post',
  date: '2024-06-01T00:00:00.000Z',
  tags: ['nested'],
  tone: 'bold',
  priority: 0,
  featured: false,
};
const INVALID_DRAFT = {
  title: ADVISORY_TITLE,
  date: '2024-06-01T00:00:00.000Z',
  tags: ['ok', 42],
  tone: 'loud',
};

// --- capture plumbing ---

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readDisk(base: string, file: string): Promise<{ contents: string; hash: string }> {
  const payload = await getJson<{ file: string; contents: string }>(
    base,
    `/__astroix/file?file=${encodeURIComponent(file)}`,
  );
  if (payload.contents === undefined) throw new Error(`disk read of ${file} came back empty`);
  return { contents: payload.contents, hash: sha256(payload.contents) };
}

async function postJson<T>(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

function envelope<K extends string, T extends object>(
  kind: K,
  data: T,
): T & { contractVersion: string; kind: K } {
  return { contractVersion: EDIT_CONTRACT_VERSION, kind, ...data };
}

/** `expect`-less capture guard: a leg that observed the wrong shape dies named, never freezes. */
function guard(condition: boolean, what: string): asserts condition {
  if (!condition) throw new Error(`honest-capture guard failed: ${what}`);
}

function locate(contents: string, needle: string, label: string): number {
  const index = contents.indexOf(needle);
  guard(index >= 0, `${label} anchor ${JSON.stringify(needle)} missing from the observed bytes`);
  return index;
}

async function readIndex(base: string): Promise<IndexRecord[]> {
  return getJson<IndexRecord[]>(base, '/__astroix/index');
}

/** The draft the chrome would hold: the raw parse with one data key edited. */
function dataEditedDraft(parsed: EntryDraft, key: string, value: unknown): EntryDraft {
  guard(
    typeof parsed.data === 'object' && parsed.data !== null,
    'the parsed baseline data is an object',
  );
  return { data: { ...(parsed.data as Record<string, unknown>), [key]: value }, body: parsed.body };
}

/** Baseline frontmatter lines surviving verbatim in the written bytes — the preservation evidence. */
function preservedLines(before: string, after: string): string[] {
  const block = splitEntryFile(before).frontmatter ?? '';
  const afterLines = new Set(after.split('\n'));
  return block.split('\n').filter((line) => line !== '' && line !== '---' && afterLines.has(line));
}

// --- the capture: one boot, eight legs, fixed order ---

export async function captureEditCorpus(options: EditCaptureOptions): Promise<EditCorpus> {
  const { base, root } = options;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // A real document load first — the scoped style module enters the
    // client module graph only once a browser has requested it (B1's seam).
    await page.goto(base, { waitUntil: 'load' });

    // --- leg 1: css-splice — a declaration replaced in the global css ---
    const cssBaseline = await readDisk(base, HOME_CSS);
    const spliceStart = locate(cssBaseline.contents, SPLICE_ANCHOR, 'css-splice');
    const spliceRange = { start: spliceStart, end: spliceStart + SPLICE_ANCHOR.length };
    const spliceResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/edit', {
      file: HOME_CSS,
      range: spliceRange,
      replacement: SPLICE_REPLACEMENT,
      expected: cssBaseline.hash,
    });
    guard(
      spliceResponse.status === 200 && spliceResponse.body.ok === true,
      'css-splice write answered',
    );
    const cssAfter = await readDisk(base, HOME_CSS);
    guard(
      cssAfter.contents ===
        spliceText(cssBaseline.contents, {
          start: spliceRange.start,
          end: spliceRange.end,
          replacement: SPLICE_REPLACEMENT,
        }),
      'css-splice disk bytes disagree with the splice-writer cross-check',
    );
    const cssIndexAfter = await poll(
      'index payload reflecting the spliced declaration',
      () => readIndex(base),
      (records) =>
        records.some(
          (record) =>
            record.file === HOME_CSS &&
            cssAfter.contents
              .slice(record.range.start, record.range.end)
              .includes(SPLICE_REPLACEMENT),
        ),
    );

    // --- leg 2: css-scoped-splice — a selector renamed in a scoped block ---
    const scopedBeforeRecords = await poll(
      'scoped records joined on the document load',
      () => readIndex(base),
      (records) =>
        records.some(
          (record) =>
            record.scoped &&
            record.file === INDEX_ASTRO &&
            record.effectiveSelector !== null &&
            record.effectiveSelector.includes(CID_FORM.attribute),
        ),
    );
    const scopedBefore = scopedBeforeRecords.find(
      (record) =>
        record.scoped &&
        record.file === INDEX_ASTRO &&
        record.effectiveSelector !== null &&
        // coherent join only: the compiled form names the source selector it
        // compiles (the pristine boot serves a fresh module, but the guard
        // keeps a stale positional join out of the corpus by construction)
        record.effectiveSelector.startsWith(record.selector),
    );
    guard(scopedBefore !== undefined, 'the scoped index.astro record is joined');
    const astroBaseline = await readDisk(base, INDEX_ASTRO);
    guard(
      astroBaseline.contents.slice(
        scopedBefore.range.start,
        scopedBefore.range.start + scopedBefore.selector.length,
      ) === scopedBefore.selector,
      'the scoped record range must open with its own selector bytes',
    );
    const renameRange = {
      start: scopedBefore.range.start,
      end: scopedBefore.range.start + scopedBefore.selector.length,
    };
    const scopedResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/edit', {
      file: INDEX_ASTRO,
      range: renameRange,
      replacement: RENAMED_SELECTOR,
      expected: astroBaseline.hash,
    });
    guard(
      scopedResponse.status === 200 && scopedResponse.body.ok === true,
      'css-scoped-splice write answered',
    );
    // the one asynchronous seam: the scoped style module's compiled form
    // refreshes only when the module URL is fetched again (the watcher
    // invalidates; the transform runs on demand). Refetch the exact module
    // URL the join reads — the re-transform trigger, deterministic by
    // construction — then poll the served join on the STRONG predicate: a
    // positionally-joined but stale compiled selector still carries the cid
    // form while naming the pre-edit selector; only the renamed text proves
    // the module re-served.
    const styleModuleUrl = `/${INDEX_ASTRO}?astro&type=style&index=${scopedBefore.styleBlockIndex}&lang.css`;
    // the refetch rides INSIDE the poll loop (idempotent GET): a slow
    // runner's first transform can outlive a one-shot trigger, so every
    // iteration re-arms it; the budget is CI-realistic for a full module
    // re-transform on a 2-core runner (local runs finish in well under 20s)
    const scopedAfterRecords = await poll(
      'the renamed scoped selector re-joined with its cid',
      async () => {
        await fetch(`${base}${styleModuleUrl}`);
        return readIndex(base);
      },
      (records) =>
        records.some(
          (record) =>
            record.scoped &&
            record.file === INDEX_ASTRO &&
            record.selector === RENAMED_SELECTOR &&
            record.effectiveSelector?.startsWith(RENAMED_SELECTOR) === true &&
            record.effectiveSelector.includes(CID_FORM.attribute),
        ),
      60_000,
    );
    const scopedAfter = scopedAfterRecords.find(
      (record) =>
        record.scoped &&
        record.file === INDEX_ASTRO &&
        record.selector === RENAMED_SELECTOR &&
        record.effectiveSelector?.startsWith(RENAMED_SELECTOR) === true,
    );
    guard(
      scopedAfter !== undefined,
      'the renamed scoped record is joined on the recompiled module',
    );
    const astroAfter = await readDisk(base, INDEX_ASTRO);

    // --- leg 3: css-conflict — a stale expected hash over a raced disk ---
    const cssConflictBaseline = await readDisk(base, HOME_CSS);
    locate(cssConflictBaseline.contents, CSS_INTERFERENCE_FROM, 'css interference');
    const cssInterferenceContents = cssConflictBaseline.contents.replace(
      CSS_INTERFERENCE_FROM,
      CSS_INTERFERENCE_TO,
    );
    guard(
      cssInterferenceContents !== cssConflictBaseline.contents,
      'css interference changed bytes',
    );
    writeFileSync(join(root, HOME_CSS), cssInterferenceContents);
    const conflictStart = locate(cssConflictBaseline.contents, CONFLICT_ANCHOR, 'css conflict');
    const cssConflictResponse = await postJson<{
      error?: string;
      contents?: string;
    }>(base, '/__astroix/edit', {
      file: HOME_CSS,
      range: { start: conflictStart, end: conflictStart + CONFLICT_ANCHOR.length },
      replacement: CONFLICT_REPLACEMENT,
      expected: cssConflictBaseline.hash, // stale: names the pre-race disk
    });
    guard(cssConflictResponse.status === 409, 'the stale css attempt is refused');
    guard(
      cssConflictResponse.body.error === 'file changed on disk' &&
        cssConflictResponse.body.contents === cssInterferenceContents,
      'the 409 hands back the raced disk truth',
    );
    const cssRetained = await readDisk(base, HOME_CSS);
    guard(cssRetained.contents === cssInterferenceContents, 'the refused css write retained disk');

    // --- leg 4: content-frontmatter — one key edited over a commented file ---
    writeFileSync(join(root, POST_MD), COMMENTED_POST);
    const fmBaseline = await readDisk(base, POST_MD);
    guard(fmBaseline.contents === COMMENTED_POST, 'the commented variant is on disk');
    const fmParsed = parseEntryDraft(fmBaseline.contents);
    guard(fmParsed !== null, 'the commented variant parses');
    const fmDraft = dataEditedDraft(fmParsed, FRONTMATTER_EDIT.key, FRONTMATTER_EDIT.to);
    const fmWrittenContents = serializeEntry({
      raw: fmBaseline.contents,
      baseline: fmParsed,
      draft: fmDraft,
    });
    guard(fmWrittenContents !== fmBaseline.contents, 'the frontmatter edit changed the bytes');
    const fmResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/content-write', {
      file: POST_MD,
      contents: fmWrittenContents,
      expected: fmBaseline.hash,
    });
    guard(
      fmResponse.status === 200 && fmResponse.body.ok === true,
      'content-frontmatter write answered',
    );
    const fmAfter = await readDisk(base, POST_MD);
    guard(fmAfter.contents === fmWrittenContents, 'the posted frontmatter bytes landed verbatim');
    const fmPreserved = preservedLines(fmBaseline.contents, fmAfter.contents);
    guard(
      fmBaseline.contents
        .split('\n')
        .some((line) => line.trimStart().startsWith('#') && fmPreserved.includes(line)),
      'the baseline comments survived into the preserved evidence',
    );

    // --- leg 5: content-body — a body-only write, frontmatter verbatim ---
    const bodyBaseline = await readDisk(base, HELLO_MD);
    const bodyParsed = parseEntryDraft(bodyBaseline.contents);
    guard(bodyParsed !== null, 'the body baseline parses');
    const bodyDraft: EntryDraft = {
      data: bodyParsed.data,
      body: `${bodyParsed.body}${BODY_SUFFIX}`,
    };
    const bodyWrittenContents = serializeEntry({
      raw: bodyBaseline.contents,
      baseline: bodyParsed,
      draft: bodyDraft,
    });
    guard(bodyWrittenContents !== bodyBaseline.contents, 'the body edit changed the bytes');
    const bodyResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/content-write', {
      file: HELLO_MD,
      contents: bodyWrittenContents,
      expected: bodyBaseline.hash,
    });
    guard(
      bodyResponse.status === 200 && bodyResponse.body.ok === true,
      'content-body write answered',
    );
    const bodyAfter = await readDisk(base, HELLO_MD);
    guard(bodyAfter.contents === bodyWrittenContents, 'the posted body bytes landed verbatim');
    const bodyPrefix = splitEntryFile(bodyBaseline.contents).frontmatter ?? '';
    guard(bodyPrefix !== '', 'the body baseline carries a frontmatter block');

    // --- leg 6: content-validate — advisory issues, and the write they never gate ---
    const validResponse = await postJson<ContentValidateFixture['valid']['response']>(
      base,
      `/__astroix/content-validate?collection=blog`,
      VALID_DRAFT,
    );
    guard(
      validResponse.status === 200 && validResponse.body.ok === true,
      'the valid probe is clean',
    );
    const invalidResponse = await postJson<ContentValidateFixture['invalid']['response']>(
      base,
      '/__astroix/content-validate?collection=blog',
      INVALID_DRAFT,
    );
    guard(
      invalidResponse.status === 200 &&
        invalidResponse.body.ok === false &&
        invalidResponse.body.issues.some((issue) => issue.path === FRONTMATTER_EDIT.key),
      'the invalid probe flags the min-length title',
    );
    const advisoryBaseline = await readDisk(base, POST_MD);
    const advisoryParsed = parseEntryDraft(advisoryBaseline.contents);
    guard(advisoryParsed !== null, 'the advisory baseline parses');
    const advisoryDraft = dataEditedDraft(advisoryParsed, FRONTMATTER_EDIT.key, ADVISORY_TITLE);
    const advisoryWrittenContents = serializeEntry({
      raw: advisoryBaseline.contents,
      baseline: advisoryParsed,
      draft: advisoryDraft,
    });
    const advisoryResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/content-write', {
      file: POST_MD,
      contents: advisoryWrittenContents,
      expected: advisoryBaseline.hash,
    });
    guard(
      advisoryResponse.status === 200 && advisoryResponse.body.ok === true,
      'the invalid-data write still succeeds — validation never gates',
    );
    const advisoryAfter = await readDisk(base, POST_MD);
    guard(
      advisoryAfter.contents === advisoryWrittenContents,
      'the advisory proof write landed verbatim',
    );

    // --- leg 7: content-conflict — a stale expected hash over a raced entry ---
    const contentConflictBaseline = await readDisk(base, HELLO_MD);
    locate(contentConflictBaseline.contents, CONTENT_INTERFERENCE_FROM, 'content interference');
    const contentInterferenceContents = contentConflictBaseline.contents.replace(
      CONTENT_INTERFERENCE_FROM,
      CONTENT_INTERFERENCE_TO,
    );
    guard(
      contentInterferenceContents !== contentConflictBaseline.contents,
      'content interference changed bytes',
    );
    writeFileSync(join(root, HELLO_MD), contentInterferenceContents);
    const staleParsed = parseEntryDraft(contentConflictBaseline.contents);
    guard(staleParsed !== null, 'the stale baseline parses');
    const staleDraft: EntryDraft = {
      data: staleParsed.data,
      body: `${staleParsed.body}${BODY_SUFFIX}`,
    };
    const staleContents = serializeEntry({
      raw: contentConflictBaseline.contents,
      baseline: staleParsed,
      draft: staleDraft,
    });
    const contentConflictResponse = await postJson<{
      error?: string;
      contents?: string;
    }>(base, '/__astroix/content-write', {
      file: HELLO_MD,
      contents: staleContents,
      expected: contentConflictBaseline.hash, // stale: names the pre-race disk
    });
    guard(contentConflictResponse.status === 409, 'the stale content attempt is refused');
    guard(
      contentConflictResponse.body.error === 'file changed on disk' &&
        contentConflictResponse.body.contents === contentInterferenceContents,
      'the content 409 hands back the raced disk truth',
    );
    const contentRetained = await readDisk(base, HELLO_MD);
    guard(
      contentRetained.contents === contentInterferenceContents,
      'the refused content write retained disk',
    );

    // --- leg 8: edit-negatives — the 400 taxonomy, disk proven untouched ---
    const diskBefore = await readDisk(base, HOME_CSS);
    const fileLength = diskBefore.contents.length;
    const negativeCases: EditNegativesFixture['cases'] = [
      {
        surface: 'css-splice',
        request: {
          file: HOME_CSS,
          range: { start: 10, end: 5 },
          replacement: 'x',
          expected: diskBefore.hash,
        },
        response: await postNegative(base, '/__astroix/edit', {
          file: HOME_CSS,
          range: { start: 10, end: 5 },
          replacement: 'x',
          expected: diskBefore.hash,
        }),
      },
      {
        surface: 'css-splice',
        request: {
          file: HOME_CSS,
          range: { start: 0, end: fileLength + 999_999 },
          replacement: 'x',
          expected: diskBefore.hash,
        },
        response: await postNegative(base, '/__astroix/edit', {
          file: HOME_CSS,
          range: { start: 0, end: fileLength + 999_999 },
          replacement: 'x',
          expected: diskBefore.hash,
        }),
      },
      {
        surface: 'css-splice',
        request: { file: HOME_CSS, range: { start: 0, end: 1 }, expected: diskBefore.hash },
        response: await postNegative(base, '/__astroix/edit', {
          file: HOME_CSS,
          range: { start: 0, end: 1 },
          expected: diskBefore.hash,
        }),
      },
      {
        surface: 'css-splice',
        request: { file: '../outside.css', range: { start: 0, end: 1 }, replacement: 'x' },
        response: await postNegative(base, '/__astroix/edit', {
          file: '../outside.css',
          range: { start: 0, end: 1 },
          replacement: 'x',
        }),
      },
      {
        surface: 'css-splice',
        request: { file: 'src/pages/nope.css', range: { start: 0, end: 1 }, replacement: 'x' },
        response: await postNegative(base, '/__astroix/edit', {
          file: 'src/pages/nope.css',
          range: { start: 0, end: 1 },
          replacement: 'x',
        }),
      },
      {
        surface: 'content-write',
        request: { file: HELLO_MD, expected: diskBefore.hash },
        response: await postNegative(base, '/__astroix/content-write', {
          file: HELLO_MD,
          expected: diskBefore.hash,
        }),
      },
    ];
    for (const [index, leg] of negativeCases.entries()) {
      guard(
        leg.response.body.error.length > 0,
        `negative case ${index} answered with an empty error`,
      );
    }
    const diskAfter = await readDisk(base, HOME_CSS);
    guard(diskAfter.contents === diskBefore.contents, 'no negative request touched the disk');

    await page.close();
    return {
      cssSplice: envelope('css-splice', {
        file: HOME_CSS,
        baseline: cssBaseline,
        edit: {
          range: spliceRange,
          replaced: SPLICE_ANCHOR,
          replacement: SPLICE_REPLACEMENT,
          expectedHash: cssBaseline.hash,
        },
        response: spliceResponse as CssSpliceFixture['response'],
        after: cssAfter,
        indexAfter: cssIndexAfter.filter((record) => record.file === HOME_CSS),
      }),
      cssScopedSplice: envelope('css-scoped-splice', {
        file: INDEX_ASTRO,
        baseline: astroBaseline,
        indexBefore: scopedBefore,
        edit: {
          range: renameRange,
          replaced: scopedBefore.selector,
          replacement: RENAMED_SELECTOR,
          expectedHash: astroBaseline.hash,
        },
        response: scopedResponse as CssScopedSpliceFixture['response'],
        after: astroAfter,
        indexAfter: scopedAfter,
      }),
      cssConflict: envelope('edit-conflict', {
        surface: 'css-splice',
        file: HOME_CSS,
        baseline: cssConflictBaseline,
        interference: { contents: cssInterferenceContents, hash: sha256(cssInterferenceContents) },
        attempt: {
          range: { start: conflictStart, end: conflictStart + CONFLICT_ANCHOR.length },
          replaced: CONFLICT_ANCHOR,
          replacement: CONFLICT_REPLACEMENT,
          expectedHash: cssConflictBaseline.hash,
        },
        response: cssConflictResponse as EditConflictFixture['response'],
        retained: cssRetained,
      }),
      contentFrontmatter: envelope('content-write', {
        file: POST_MD,
        baseline: fmBaseline,
        draft: fmDraft,
        written: { contents: fmWrittenContents, expectedHash: fmBaseline.hash },
        response: fmResponse as ContentWriteFixture['response'],
        after: fmAfter,
        preserved: fmPreserved,
      }),
      contentBody: envelope('content-body-write', {
        file: HELLO_MD,
        baseline: bodyBaseline,
        draft: bodyDraft,
        written: { contents: bodyWrittenContents, expectedHash: bodyBaseline.hash },
        response: bodyResponse as ContentBodyWriteFixture['response'],
        after: bodyAfter,
        preservedPrefix: bodyPrefix,
      }),
      contentValidate: envelope('content-validate', {
        collection: 'blog',
        valid: { draft: VALID_DRAFT, response: validResponse.body },
        invalid: { draft: INVALID_DRAFT, response: invalidResponse.body },
        advisoryWrite: {
          file: POST_MD,
          baseline: advisoryBaseline,
          written: { contents: advisoryWrittenContents, expectedHash: advisoryBaseline.hash },
          response: advisoryResponse as ContentValidateFixture['advisoryWrite']['response'],
          after: advisoryAfter,
        },
      }),
      contentConflict: envelope('edit-conflict', {
        surface: 'content-write',
        file: HELLO_MD,
        baseline: contentConflictBaseline,
        interference: {
          contents: contentInterferenceContents,
          hash: sha256(contentInterferenceContents),
        },
        attempt: {
          contents: staleContents,
          expectedHash: contentConflictBaseline.hash,
        },
        response: contentConflictResponse as EditConflictFixture['response'],
        retained: contentRetained,
      }),
      editNegatives: envelope('edit-negatives', {
        disk: { file: HOME_CSS, before: diskBefore, after: diskAfter },
        cases: negativeCases,
      }),
    };
  } finally {
    await browser.close();
  }
}

/** Posts one negative request and freezes its 400 answer verbatim. */
async function postNegative(
  base: string,
  path: string,
  body: unknown,
): Promise<EditNegativesFixture['cases'][number]['response']> {
  const result = await postJson<{ error?: string }>(base, path, body);
  guard(
    result.status === 400 && typeof result.body.error === 'string' && result.body.error !== '',
    `negative request to ${path} answered ${result.status} instead of the 400 taxonomy`,
  );
  return { status: result.status, body: { error: result.body.error } };
}
