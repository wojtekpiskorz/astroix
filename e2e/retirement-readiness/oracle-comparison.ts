import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spliceText } from '../../packages/core/src/splice-writer.ts';
import type {
  CssSpliceFixture,
  EditConflictFixture,
} from '../behavior-contracts/schema/edit-contract.ts';
import type {
  CollectionsFixture,
  CssIndexFixture,
  RawTruthFixture,
  RouteResolutionFixture,
  RoutesFixture,
} from '../behavior-contracts/schema/inspection-contract.ts';
import { recomputeEntryResolutions } from './entry-resolutions.ts';

/**
 * The readiness live-comparison leg (#214, AC-1/AC-2): runs against a
 * booted disposable oracle and compares its live evidence with the frozen
 * contracts — an INDEPENDENT second implementation of the comparison,
 * deliberately not the B-lane capture pipeline. The read side deep-compares
 * the served inspection payloads (index join, collections, routes, raw
 * truth) against the frozen corpus and recomputes route resolution through
 * the retained resolver over the live payloads; the write side reproduces
 * the frozen css-splice and css-conflict cycles over the pristine oracle
 * and holds the live responses and disk bytes to the frozen evidence. The
 * legacy runtime is never imported — it only serves the oracle this leg
 * talks to over HTTP, and the oracle copy dies with the boot.
 *
 * The oracle is regenerated pristine on every boot (#213), so the frozen
 * baselines hold byte-for-byte; leg order mirrors the capture's (splice
 * before conflict) because the frozen conflict baseline is the post-splice
 * disk.
 */

export interface OracleHandle {
  base: string;
  dir: string;
}

/** The comparison's evidence rows — every one must hold for readiness. */
export interface ComparisonRow {
  what: string;
  held: boolean;
}

const CONTRACTS_DIR = join('e2e', 'behavior-contracts');

function frozenJson<T>(relative: string): T {
  // plain JSON.parse is enough here — the contracts leg already validated
  // every fixture through its schema; this leg compares live evidence
  // against those same frozen bytes
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, relative), 'utf8')) as T;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll<T>(
  description: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`oracle comparison never became ready: ${description}`);
    }
    await sleep(250);
  }
}

async function getJson<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
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

/**
 * Relativize astro's `image()` projection (`/@fs<root>/src/...` → `/src/...`).
 * PINNED COPY of `scrubAbsolutePaths` in `e2e/contract-oracle/live-capture.ts`
 * (outside this suite's owned paths, deliberately not imported): the two
 * must move together — a scrub change on either side re-churns what the
 * deep-compares see against the frozen bytes.
 */
function scrubAbsolutePaths<T>(value: T, root: string): T {
  const scrub = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const prefix = `/@fs${root}`;
      return node.startsWith(prefix) ? node.slice(prefix.length) : node;
    }
    if (Array.isArray(node)) return node.map((item) => scrub(item));
    if (typeof node === 'object' && node !== null) {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) scrubbed[key] = scrub(item);
      return scrubbed;
    }
    return node;
  };
  return scrub(value) as T;
}

/** Runs the whole live comparison; throws named errors, returns the evidence rows. */
export async function compareOracleEvidence(
  handle: OracleHandle,
): Promise<readonly ComparisonRow[]> {
  const { base, dir } = handle;
  const frozenIndex = frozenJson<CssIndexFixture>('inspection/css-index.attribute.json');
  const frozenCollections = frozenJson<CollectionsFixture>('inspection/collections.json');
  const frozenRoutes = frozenJson<RoutesFixture>('inspection/routes.json');
  const frozenResolution = frozenJson<RouteResolutionFixture>('inspection/route-resolution.json');
  const frozenRawTruth = frozenJson<RawTruthFixture>('inspection/raw-truth.json');
  const frozenSplice = frozenJson<CssSpliceFixture>('edit/css-splice.json');
  const frozenConflict = frozenJson<EditConflictFixture>('edit/css-conflict.json');

  // --- read side: the served payloads vs the frozen corpus ---
  const liveIndex = await poll(
    'index payload with joined scoped selectors',
    () => getJson<CssIndexFixture['records']>(base, '/__astroix/index'),
    (records) =>
      records.some((record) => record.scoped) &&
      records
        .filter((record) => record.scoped)
        .every((record) => record.effectiveSelector !== null),
  );

  const liveCollections = scrubAbsolutePaths(
    await poll(
      'collections payload fully synced',
      () => getJson<CollectionsFixture['collections']>(base, '/__astroix/collections'),
      (payload) => payload.find((collection) => collection.name === 'blog')?.entries.length === 3,
    ),
    dir,
  );

  const liveRoutes = await poll(
    'routes payload with the getStaticPaths enumeration landed',
    () => getJson<RoutesFixture['routes']>(base, '/__astroix/routes'),
    (payload) =>
      payload.every(
        (route) =>
          !(route.params.length === 1 && route.rendering === 'prerendered') ||
          route.renders !== undefined,
      ),
  );

  const helloPath = 'src/content/blog/hello-builder.md';
  const liveHello = await getJson<RawTruthFixture['reads'][number]>(
    base,
    `/__astroix/file?file=${encodeURIComponent(helloPath)}`,
  );
  const frozenHello = frozenRawTruth.reads.find((read) => read.file === helloPath);

  // route resolution recomputed through the RETAINED resolver over live
  // payloads (the shared composition both readiness legs deep-compare with)
  const recomputed = recomputeEntryResolutions(liveCollections, liveRoutes);

  // --- write side: reproduce the frozen css-splice cycle ---
  const baseline = await getJson<{ contents: string }>(
    base,
    `/__astroix/file?file=${encodeURIComponent(frozenSplice.file)}`,
  );
  if (baseline.contents !== frozenSplice.baseline.contents) {
    throw new Error('live oracle baseline drifted from the frozen css-splice baseline');
  }
  const spliceResponse = await postJson<{ ok?: boolean }>(base, '/__astroix/edit', {
    file: frozenSplice.file,
    range: frozenSplice.edit.range,
    replacement: frozenSplice.edit.replacement,
    expected: frozenSplice.edit.expectedHash,
  });
  const after = await getJson<{ contents: string }>(
    base,
    `/__astroix/file?file=${encodeURIComponent(frozenSplice.file)}`,
  );

  // --- write side: reproduce the frozen css-conflict cycle over the raced disk ---
  writeFileSync(join(dir, frozenConflict.file), frozenConflict.interference.contents);
  const conflictResponse = await postJson<{ error?: string; contents?: string }>(
    base,
    '/__astroix/edit',
    {
      file: frozenConflict.file,
      range: frozenConflict.attempt.range,
      replacement: frozenConflict.attempt.replacement,
      expected: frozenConflict.attempt.expectedHash,
    },
  );
  const retained = await getJson<{ contents: string }>(
    base,
    `/__astroix/file?file=${encodeURIComponent(frozenConflict.file)}`,
  );

  return [
    {
      what: 'live index payload equals the frozen css-index corpus (selector + inspection evidence)',
      held: JSON.stringify(liveIndex) === JSON.stringify(frozenIndex.records),
    },
    {
      what: 'live collections payload equals the frozen collections corpus',
      held: JSON.stringify(liveCollections) === JSON.stringify(frozenCollections.collections),
    },
    {
      what: 'live routes payload equals the frozen routes corpus',
      held: JSON.stringify(liveRoutes) === JSON.stringify(frozenRoutes.routes),
    },
    {
      what: 'live raw-truth read equals the frozen read for the canonical entry',
      held: frozenHello !== undefined && JSON.stringify(liveHello) === JSON.stringify(frozenHello),
    },
    {
      what: 'the retained route resolver reproduces the frozen resolutions over live payloads',
      held: JSON.stringify(recomputed) === JSON.stringify(frozenResolution.entryResolutions),
    },
    {
      what: 'the live splice cycle reproduces the frozen css-splice contract (response, bytes, hash, splice-writer cross-check)',
      held:
        spliceResponse.status === 200 &&
        spliceResponse.body.ok === true &&
        after.contents === frozenSplice.after.contents &&
        sha256(after.contents) === frozenSplice.after.hash &&
        after.contents ===
          spliceText(baseline.contents, {
            start: frozenSplice.edit.range.start,
            end: frozenSplice.edit.range.end,
            replacement: frozenSplice.edit.replacement,
          }),
    },
    {
      what: 'the live conflict cycle reproduces the frozen css-conflict contract (409, disk-truth handback, retention)',
      held:
        conflictResponse.status === 409 &&
        conflictResponse.body.error === frozenConflict.response.body.error &&
        conflictResponse.body.contents === frozenConflict.interference.contents &&
        retained.contents === frozenConflict.retained.contents &&
        sha256(retained.contents) === frozenConflict.retained.hash,
    },
  ];
}
