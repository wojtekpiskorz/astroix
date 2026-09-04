import type { CssRuleRecord } from '@wojciechpiskorz/astroix-core';
import postcss from 'postcss';
import { type AdapterError, seamRejection } from '../../adapter-error';

/**
 * The styles join's pure correspondence core (#226, ADR-0005 `styles`
 * inspection: "the static source index joined with effective selectors
 * from real Astro output"): editable source ranges (the static index —
 * the edit truth) and the selectors that actually match rendered nodes
 * (the client environment's compiled CSS) are two different truths, and
 * this module joins them with strict correspondence checks — nothing is
 * synthesized and nothing is guessed.
 *
 * The compiler-derived forms are CONSUMED, never generated (the #226
 * migration policy): the default `attribute` form
 * (`.x[data-astro-cid-*]`) and the configured `where` form
 * (`.x:where(.astro-*)`) arrive in the compiled CSS and flow into
 * `effectiveSelector` verbatim; Astroix strips a scope token only to
 * VERIFY that a compiled selector preserves its source selector, never
 * to construct one. There is no legacy scoped-hash synthesis and no
 * source-map assumption (dev CSS generates no sourcemaps — the static
 * index is the only mapping to disk).
 *
 * Every disagreement fails closed as a `seam-rejected` AdapterError in
 * the adapter's idiom (`{seam, seamClass, expected, observed}`, with
 * structural observed descriptions — never values, never content dumps):
 * a missing compiled module for the active route's own scoped block, a
 * loaded file with an absent block module, a rule-count disagreement, a
 * selector that does not reduce to its source form, compiled CSS that
 * does not parse, and — the hollow-payload cross-check (#302) — compiled
 * scoped modules that correlate with no walked static block are all
 * compatibility events, never a partially joined payload. The shapes
 * this join accepts are the ones the E1 certification suite proved
 * byte-equal against the frozen inspection corpora
 * (`e2e/behavior-contracts/inspection/css-index.*.json`, #225).
 */

const SEAM_JOIN_BLOCK = 'styles join block correspondence (static scoped block ↔ compiled module)';
const SEAM_JOIN_RULES = 'styles join rule correspondence (count, order, selector identity)';
const SEAM_JOIN_RULE_SHAPE = 'styles join compiled CSS rule shape';
const SEAM_JOIN_WALK_CORRESPONDENCE =
  'styles join source-walk correspondence (compiled scoped modules ↔ walked static sources)';

/**
 * The query token that marks a compiled scoped `<style>` block in a
 * module id (`{file}.astro?astro&type=style&index={N}`) — one compiler
 * fact, shared by the join's block correlation and the client
 * transform's scoped-entry filter.
 */
export const STYLE_BLOCK_TOKEN = '?astro&type=style&index=';

/**
 * The compiler's scope token — the attribute strategy's
 * `[data-astro-cid-*]` or the where strategy's `.astro-*` class. A joined
 * scoped selector must carry one (the frozen corpora's identity
 * invariant): the compiler-derived form is consumed, so a scoped rule
 * whose compiled selector carries no token at all is a correspondence
 * break, not a pass.
 */
const SCOPE_TOKEN = /\[data-astro-cid-[a-z0-9]+\]|\.astro-[a-z0-9]+/;

/**
 * One served record of the index payload (CONTEXT.md): an edit-truth rule
 * plus its join result — the compiled selector as the canvas DOM matches
 * it, or null when the block's module is not in the route's client graph
 * (and always null for global rules).
 */
export interface EffectiveSelectorRecord extends CssRuleRecord {
  readonly effectiveSelector: string | null;
}

/**
 * One compiled scoped-style module, as the client environment produced
 * it: the route-associated virtual CSS's module `id` (the block
 * correlation key) and `url` (the transform target), plus the CSS the
 * client transform shipped. The virtual module's *content* is
 * deliberately absent — the adapter takes route order, IDs, and URLs
 * from the virtual CSS (#226) and the effective selectors from the
 * client environment's compiled output.
 */
export interface CompiledStyleModule {
  readonly id: string;
  readonly url: string;
  readonly compiledCss: string;
}

/** Correspondence options: which files' scoped blocks must be loaded on the route. */
export interface JoinEffectiveSelectorsOptions {
  /**
   * Files whose scoped blocks MUST have compiled modules on this route —
   * the active route's own component. A missing module for one of these
   * is a fail-closed rejection, never a null join.
   */
  readonly requiredScopedFiles?: readonly string[];
}

/** The join's working copy: same fields, the joined selector still mutable. */
type MutableSelectorRecord = Omit<EffectiveSelectorRecord, 'effectiveSelector'> & {
  effectiveSelector: string | null;
};

/** One static scoped block: the `(file, style block)` group and its records, in source order. */
interface ScopedBlock {
  readonly file: string;
  readonly blockIndex: number;
  readonly records: MutableSelectorRecord[];
}

/**
 * Joins the static index with the compiled scoped selectors. Scoped
 * records group by `(file, styleBlockIndex)`; compiled modules index to
 * their block by module id; then each block's rules correlate with its
 * module's compiled rules by count, order, and selector identity. Files
 * whose blocks have no compiled modules at all are simply not loaded on
 * the route — their scoped records join null (contract shape); a file
 * with SOME compiled modules must have them all.
 *
 * The hollow-payload cross-check (#302): a route whose dev-css set
 * yields compiled scoped modules that correlate with NO static scoped
 * block — the walk read a source tree the compiler did not, the
 * custom-`srcDir` shape while the walk stays `src/`-rooted — rejects
 * instead of minting a revision for an empty-or-partial all-null
 * payload. Zero correlation is the reject condition; a partially
 * unknown dev-css set (some modules correlate) stays the null-join
 * shape above.
 */
export function joinEffectiveSelectors(
  staticRecords: readonly CssRuleRecord[],
  compiledModules: readonly CompiledStyleModule[],
  options: JoinEffectiveSelectorsOptions = {},
): EffectiveSelectorRecord[] {
  const requiredScopedFiles = new Set(options.requiredScopedFiles ?? []);
  const payload: MutableSelectorRecord[] = staticRecords.map((record) => ({
    ...record,
    effectiveSelector: null,
  }));
  const blocks = groupScopedBlocks(payload);
  const modulesByBlock = indexStyleBlockModules(compiledModules, blocks);
  if (compiledModules.length > 0 && modulesByBlock.size === 0) {
    throw walkCorrespondenceRejection(
      'a static scoped block for at least one file the compiled scoped modules name',
      'compiled scoped modules correlating with no static scoped block (the source walk and the compiler observed different source trees)',
    );
  }
  const filesOnRoute = new Set(
    [...modulesByBlock.keys()].map((key) => key.slice(0, key.lastIndexOf('\0'))),
  );
  for (const block of blocks.values()) {
    const module = modulesByBlock.get(blockKey(block.file, block.blockIndex));
    if (module === undefined) {
      if (requiredScopedFiles.has(block.file)) {
        throw blockRejection(
          `a compiled module carrying the style-block index of block ${block.blockIndex} of ${block.file} (the active route's CSS)`,
          'no compiled module for that block in the route CSS set',
        );
      }
      if (filesOnRoute.has(block.file)) {
        throw blockRejection(
          `a compiled module for block ${block.blockIndex} of ${block.file} (the file has compiled modules on this route)`,
          'a file with compiled modules on the route whose style block has no compiled module',
        );
      }
      continue; // not loaded on this route — the null join is contract shape
    }
    correlateStyleBlock(block, module);
  }
  return payload;
}

/** The block map key — `file` cannot contain `\0`, so the split is unambiguous. */
function blockKey(file: string, blockIndex: number): string {
  return `${file}\0${blockIndex}`;
}

/** Groups the payload's scoped records by `(file, style block)` — the static side of the correspondence. */
function groupScopedBlocks(payload: readonly MutableSelectorRecord[]): Map<string, ScopedBlock> {
  const blocks = new Map<string, ScopedBlock>();
  for (const record of payload) {
    if (!record.scoped || record.styleBlockIndex === null) continue;
    const key = blockKey(record.file, record.styleBlockIndex);
    const block = blocks.get(key) ?? {
      file: record.file,
      blockIndex: record.styleBlockIndex,
      records: [],
    };
    block.records.push(record);
    blocks.set(key, block);
  }
  return blocks;
}

/**
 * Indexes the compiled modules by their static style block. A module
 * correlates with the LONGEST block file its id carries at a path
 * boundary (`/` before the file, or the id's start): a bare substring
 * match would correlate `src/pages/index.astro` with a module of
 * `src/pages/sub/src/pages/index.astro`, and a mid-segment embedding
 * (`…/xsrc/pages/index.astro`) with a file it does not name. The block
 * index must end at the id or at the next query parameter, so block 1
 * never correlates with block 10.
 */
function indexStyleBlockModules(
  compiledModules: readonly CompiledStyleModule[],
  blocks: Map<string, ScopedBlock>,
): Map<string, CompiledStyleModule> {
  const blockFiles = [
    ...new Set([...blocks.keys()].map((key) => key.slice(0, key.lastIndexOf('\0')))),
  ].sort((left, right) => right.length - left.length);
  const modulesByBlock = new Map<string, CompiledStyleModule>();
  for (const module of compiledModules) {
    const id = normalizedId(module.id);
    for (const file of blockFiles) {
      const at = boundaryIndexOf(id, `${file}${STYLE_BLOCK_TOKEN}`);
      if (at === -1) continue;
      const indexMatch = id
        .slice(at + file.length + STYLE_BLOCK_TOKEN.length)
        .match(/^(\d+)(?:&|$)/);
      if (indexMatch === null) continue;
      modulesByBlock.set(blockKey(file, Number(indexMatch[1])), module);
      break; // the longest matching file owns the module
    }
  }
  return modulesByBlock;
}

/** The first occurrence of `needle` in `id` that starts a path segment (`/` before it, or the id's start), or -1. */
function boundaryIndexOf(id: string, needle: string): number {
  let at = id.indexOf(needle);
  while (at > 0 && id[at - 1] !== '/') {
    at = id.indexOf(needle, at + 1);
  }
  return at;
}

/**
 * Correlates one scoped block with its compiled module: rules pair by
 * count, order, and selector identity — every disagreement rejects, the
 * joined selector is consumed verbatim, and a scope token is stripped
 * only to VERIFY the compiled selector reduces to its source form.
 */
function correlateStyleBlock(block: ScopedBlock, module: CompiledStyleModule): void {
  const selectors = compiledRuleSelectors(module.compiledCss, block);
  if (selectors.length !== block.records.length) {
    throw rulesRejection(
      `${block.records.length} compiled rules for block ${block.blockIndex} of ${block.file} (the static rule count)`,
      `a compiled rule count of ${selectors.length}`,
    );
  }
  // Equal rule counts proven above — the positional pairing walks both
  // sides as dense sequences (iterator values, never indexed lookups),
  // so the equal-length invariant is the one guard and it is visible
  // exactly once, four lines up.
  for (const [record, effectiveSelector, index] of pairPositional(block.records, selectors)) {
    if (!SCOPE_TOKEN.test(effectiveSelector)) {
      throw rulesRejection(
        `compiled rule ${index} of block ${block.blockIndex} of ${block.file} to carry the compiler's scope token`,
        'a compiled selector that carries no scope token for a scoped rule',
      );
    }
    if (sourceSelectorOf(effectiveSelector) !== normalizedSelector(record.selector)) {
      throw rulesRejection(
        `compiled rule ${index} of block ${block.blockIndex} of ${block.file} to reduce to its source selector`,
        'a compiled selector that does not reduce to its source selector',
      );
    }
    record.effectiveSelector = effectiveSelector;
  }
}

/**
 * Pairs two dense arrays positionally, yielding each pair with its
 * index. Iterator values only — never indexed lookups — so pairing
 * equal-length arrays needs no element-existence re-checks.
 */
function* pairPositional<T, U>(
  left: readonly T[],
  right: readonly U[],
): Generator<[T, U, number], void, undefined> {
  const leftValues = left.values();
  const rightValues = right.values();
  for (let index = 0; ; index += 1) {
    const leftNext = leftValues.next();
    const rightNext = rightValues.next();
    if (leftNext.done === true || rightNext.done === true) return;
    yield [leftNext.value, rightNext.value, index];
  }
}

function compiledRuleSelectors(css: string, block: ScopedBlock): string[] {
  const selectors: string[] = [];
  try {
    postcss.parse(css).walkRules((rule) => {
      selectors.push(rule.selector);
    });
  } catch (cause) {
    throw stylesJoinRejected(
      SEAM_JOIN_RULE_SHAPE,
      `parseable CSS rules in the compiled module for block ${block.blockIndex} of ${block.file}`,
      'compiled CSS that does not parse as a stylesheet',
      cause,
    );
  }
  return selectors;
}

/**
 * Reduces a compiled selector to its source form by removing the
 * compiler's scope token — the verification direction ONLY (the effective
 * selector itself is served verbatim; Astroix never builds one). The
 * strip set is the certification-proven one (#225): the `attribute`
 * strategy's `[data-astro-cid-*]` (bare or in `:where()`) and the `where`
 * strategy's `:where(.astro-*)`.
 */
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

function normalizedId(id: string): string {
  return id.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
}

function blockRejection(expected: string, observed: string): AdapterError {
  return stylesJoinRejected(SEAM_JOIN_BLOCK, expected, observed);
}

function rulesRejection(expected: string, observed: string): AdapterError {
  return stylesJoinRejected(SEAM_JOIN_RULES, expected, observed);
}

function walkCorrespondenceRejection(expected: string, observed: string): AdapterError {
  return stylesJoinRejected(SEAM_JOIN_WALK_CORRESPONDENCE, expected, observed);
}

/**
 * The join's rejection entry — the adapter's seam-rejection home
 * (`seamRejection`, #311/#315) under the styles join's fixed
 * `fail-closed private` seam class: one line of delegation, so the
 * message template and the closed `{seam, seamClass, expected,
 * observed}` details shape can never drift between the adapter's
 * surfaces. Shared by the join's and convergence's modules so every
 * rejection the styles surface throws is born at the one home.
 */
export function stylesJoinRejected(
  seam: string,
  expected: string,
  observed: string,
  cause?: unknown,
): AdapterError {
  return seamRejection(seam, 'fail-closed private', expected, observed, cause);
}
