import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { CssRuleRecord, SourceFile } from '@wojciechpiskorz/astroix-core';
import postcss from 'postcss';
import {
  type DevCssSeamEntry,
  readClientEnvironment,
  readTransformedModule,
  readViteClientCss,
} from '../seam-readers';

/**
 * The certification styles join (#225): composes the adapter's surfaces —
 * the static source index (`packages/core` buildCssIndex, the frozen
 * editing truth) × `virtual:astro:dev-css` entries × the client
 * environment's compiled-CSS transforms — into index-payload records
 * shaped exactly like the frozen inspection corpora
 * (`e2e/behavior-contracts/inspection/css-index.*.json`). This is the
 * layer-owned proof that the ADAPTER SURFACES can produce
 * contract-shaped results; productizing the join is the later styles
 * lane's (`astro-project-adapter/styles/`), which must land the same
 * fail-closed checks this join proves.
 *
 * Every mismatch fails closed (#206 invalidation rule 4 discipline):
 * absent route CSS module, rule-count disagreement, rule reordering, and
 * selector-identity drift are all rejections — never a synthesized or
 * partially joined payload.
 */

/** One index-payload record — the frozen corpus record shape. */
export interface IndexPayloadRecord extends CssRuleRecord {
  readonly effectiveSelector: string | null;
}

/** The join's working copy: same fields, the joined selector still mutable. */
interface MutablePayloadRecord extends Omit<IndexPayloadRecord, 'effectiveSelector'> {
  effectiveSelector: string | null;
}

/** A scoped block's compiled CSS entry after the client-environment transform. */
export interface CompiledCssEntry {
  readonly entry: DevCssSeamEntry;
  readonly compiledContent: string;
}

/**
 * Reads the project's CSS sources for the static index — the same
 * `.astro`/`.css` walk the editing domain indexes.
 */
export async function readSourceFiles(projectRoot: string): Promise<SourceFile[]> {
  const files = await collectSourceFiles(join(projectRoot, 'src'));
  const sources: SourceFile[] = [];
  for (const file of files) {
    sources.push({
      file: relative(projectRoot, file).split(sep).join('/'),
      contents: await readFile(file, 'utf8'),
    });
  }
  return sources;
}

/**
 * Transforms every scoped-style dev-css entry in the client environment
 * and proves graph ownership: the same module the transform produced is
 * the one the client module graph holds (the #206 private-seam
 * discipline — the compiled-CSS read path is never trusted without its
 * graph proof).
 *
 * The route's PAGE is primed in the client environment first (#206
 * implementation constraint 2): the scoped style modules only enter the
 * client graph as imports of the page module, so their URLs are
 * transformable there only after the page itself has been transformed.
 */
export async function compileCssEntries(
  clientEnvironment: unknown,
  entries: readonly DevCssSeamEntry[],
  options: { readonly routeComponent: string },
): Promise<CompiledCssEntry[]> {
  const client = readClientEnvironment(clientEnvironment);
  const pageUrl = `/${options.routeComponent.replace(/^\/+/, '')}`;
  const pageTransform = await client.transformRequest(pageUrl);
  if (pageTransform === null) {
    throw new Error(`the client environment did not transform the route page ${pageUrl}`);
  }
  const compiled: CompiledCssEntry[] = [];
  for (const entry of entries) {
    if (!entry.id.includes('?astro&type=style&index=')) continue;
    const transformed = await client.transformRequest(entry.url);
    if (transformed === null) {
      throw new Error(
        `the client environment did not transform the scoped style module ${entry.url}`,
      );
    }
    const content = readViteClientCss(transformed.code);
    const resolved = await client.pluginContainer.resolveId(entry.url);
    const resolvedId = (resolved as { id?: unknown } | null)?.id;
    if (typeof resolvedId !== 'string') {
      throw new Error(
        `the client environment did not resolve the scoped style module ${entry.url}`,
      );
    }
    const graphModule = readTransformedModule(client.moduleGraph, resolvedId);
    const byUrl = await client.moduleGraph.getModuleByUrl(entry.url);
    if (byUrl !== graphModule.node || graphModule.code !== transformed.code) {
      throw new Error(
        `the client module graph does not own the transformed scoped style module ${entry.url}`,
      );
    }
    compiled.push({ entry, compiledContent: content });
  }
  return compiled;
}

/**
 * Joins the static index with the compiled scoped selectors. Scoped
 * records group by `(file, styleBlockIndex)`; each group must find its
 * module's compiled entry (`{file}.astro?astro&type=style&index={N}`),
 * match it in rule count and order, and every compiled selector must
 * preserve its source selector modulo the compiler's scope token. Any
 * disagreement rejects; nothing is guessed.
 */
export function joinIndexPayload(
  staticRecords: readonly CssRuleRecord[],
  compiledEntries: readonly CompiledCssEntry[],
  options: { readonly requiredScopedFiles?: readonly string[] } = {},
): IndexPayloadRecord[] {
  const requiredScopedFiles = new Set(options.requiredScopedFiles ?? []);
  // The working copies are mutable (the join fills effectiveSelector in
  // place); the returned array is the frozen record shape.
  const payload: MutablePayloadRecord[] = staticRecords.map((record) => ({
    ...record,
    effectiveSelector: null,
  }));
  const blocks = new Map<string, { positions: number[]; record: IndexPayloadRecord }>();
  for (const [position, record] of payload.entries()) {
    if (!record.scoped || record.styleBlockIndex === null) continue;
    const key = `${record.file}\0${record.styleBlockIndex}`;
    const block = blocks.get(key) ?? { positions: [], record };
    block.positions.push(position);
    blocks.set(key, block);
  }

  for (const block of blocks.values()) {
    const token = `${block.record.file}?astro&type=style&index=${block.record.styleBlockIndex}`;
    const compiled = compiledEntries.find((candidate) =>
      normalizedId(candidate.entry.id).includes(token),
    );
    if (compiled === undefined) {
      if (requiredScopedFiles.has(block.record.file)) {
        throw new Error(
          `the active route's compiled CSS module is absent for ${block.record.file} style block ${block.record.styleBlockIndex}`,
        );
      }
      continue;
    }
    const selectors = selectorsOf(compiled.compiledContent);
    if (selectors.length !== block.positions.length) {
      throw new Error(
        `compiled CSS rule count ${selectors.length} does not match static scoped rule count ${block.positions.length} for ${block.record.file} style block ${block.record.styleBlockIndex}`,
      );
    }
    for (const [index, position] of block.positions.entries()) {
      const effectiveSelector = selectors[index];
      const record = payload[position];
      if (effectiveSelector === undefined || record === undefined) {
        throw new Error(
          `the styles join walked out of range for ${block.record.file} style block ${block.record.styleBlockIndex} (rule ${index}, payload position ${position})`,
        );
      }
      if (sourceSelectorOf(effectiveSelector) !== normalizedSelector(record.selector)) {
        throw new Error(
          `compiled selector ${effectiveSelector} does not preserve source selector ${record.selector} at rule ${index} for ${block.record.file} style block ${block.record.styleBlockIndex}`,
        );
      }
      record.effectiveSelector = effectiveSelector;
    }
  }
  return payload;
}

/** The scope-hash normalizer from the #206 proof: hashes are per-path, not contract identity. */
export function normalizeScopeToken(selector: string): string {
  return selector
    .replaceAll(/data-astro-cid-[a-z0-9]+/g, 'data-astro-cid-<scope>')
    .replaceAll(/\.astro-[a-z0-9]+/g, '.astro-<scope>');
}

/** Records as comparable data: scope-normalized, field-sorted. */
export function comparableRecords(records: readonly IndexPayloadRecord[]): unknown[] {
  return records
    .map((record) => ({
      ...record,
      effectiveSelector:
        record.effectiveSelector === null ? null : normalizeScopeToken(record.effectiveSelector),
    }))
    .sort((left, right) =>
      left.file === right.file
        ? left.range.start - right.range.start
        : left.file < right.file
          ? -1
          : 1,
    );
}

function selectorsOf(css: string): string[] {
  const selectors: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    selectors.push(rule.selector);
  });
  return selectors;
}

function sourceSelectorOf(effectiveSelector: string): string {
  return normalizedSelector(
    effectiveSelector
      .replaceAll(/:where\(\[data-astro-cid-[a-z0-9]+\]\)/g, '')
      .replaceAll(/\[data-astro-cid-[a-z0-9]+\]/g, '')
      .replaceAll(/:where\(\.astro-[a-z0-9]+\)/g, ''),
  );
}

function normalizedSelector(selector: string): string {
  return selector.replaceAll(/\s+/g, ' ').trim();
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)));
    else if (entry.name.endsWith('.astro') || entry.name.endsWith('.css')) files.push(path);
  }
  return files.sort();
}

function normalizedId(id: string): string {
  return id.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
}
