import type { CssRuleRecord } from '@wojciechpiskorz/astroix-core';
import postcss from 'postcss';
import type { AdapterErrorDetails } from '../../adapter-error';
import { AdapterError } from '../../adapter-error';

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
 * selector that does not reduce to its source form, and compiled CSS
 * that does not parse are all compatibility events, never a partially
 * joined payload. The shapes this join accepts are the ones the E1
 * certification suite proved byte-equal against the frozen inspection
 * corpora (`e2e/behavior-contracts/inspection/css-index.*.json`, #225).
 */

const SEAM_JOIN_BLOCK = 'styles join block correspondence (static scoped block ↔ compiled module)';
const SEAM_JOIN_RULES = 'styles join rule correspondence (count, order, selector identity)';
const SEAM_JOIN_RULE_SHAPE = 'styles join compiled CSS rule shape';

/** The module-id token that names one compiled scoped-style block. */
const STYLE_BLOCK_TOKEN = '?astro&type=style&index=';

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

/**
 * Joins the static index with the compiled scoped selectors. Scoped
 * records group by `(file, styleBlockIndex)`; each group correlates with
 * its compiled module (`{file}.astro?astro&type=style&index={N}`) by
 * index, then rules correlate by count, order, and selector identity.
 * Files whose blocks have no compiled modules at all are simply not
 * loaded on the route — their scoped records join null (contract shape);
 * a file with SOME compiled modules must have them all.
 */
/** The join's working copy: same fields, the joined selector still mutable. */
type MutableSelectorRecord = Omit<EffectiveSelectorRecord, 'effectiveSelector'> & {
  effectiveSelector: string | null;
};

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
  const blocks = new Map<string, { file: string; blockIndex: number; positions: number[] }>();
  for (const [position, record] of payload.entries()) {
    if (!record.scoped || record.styleBlockIndex === null) continue;
    const key = `${record.file}\0${record.styleBlockIndex}`;
    const block = blocks.get(key) ?? {
      file: record.file,
      blockIndex: record.styleBlockIndex,
      positions: [],
    };
    block.positions.push(position);
    blocks.set(key, block);
  }
  const filesOnRoute = new Set(
    [...blocks.values()]
      .map((block) => block.file)
      .filter((file) =>
        compiledModules.some((module) =>
          normalizedId(module.id).includes(`${file}${STYLE_BLOCK_TOKEN}`),
        ),
      ),
  );

  for (const block of blocks.values()) {
    const module = compiledModules.find((candidate) =>
      carriesBlockIndex(normalizedId(candidate.id), block.file, block.blockIndex),
    );
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
    const selectors = compiledRuleSelectors(module.compiledCss, block);
    if (selectors.length !== block.positions.length) {
      throw rulesRejection(
        `${block.positions.length} compiled rules for block ${block.blockIndex} of ${block.file} (the static rule count)`,
        `a compiled rule count of ${selectors.length}`,
      );
    }
    for (const [index, position] of block.positions.entries()) {
      const effectiveSelector = selectors[index];
      const record = payload[position];
      if (effectiveSelector === undefined || record === undefined) {
        throw rulesRejection(
          `every rule of block ${block.blockIndex} of ${block.file} to pair with a compiled rule in order`,
          `a walk out of range at rule ${index} (payload position ${position})`,
        );
      }
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
  return payload;
}

/**
 * Whether a module id names `file`'s compiled block `blockIndex`. The
 * block index must end at the id (or at the next query parameter) — a
 * bare substring match would correlate block 1 with block 10.
 */
function carriesBlockIndex(id: string, file: string, blockIndex: number): boolean {
  const at = id.indexOf(`${file}${STYLE_BLOCK_TOKEN}`);
  if (at === -1) return false;
  const rest = id.slice(at + file.length + STYLE_BLOCK_TOKEN.length);
  return rest === String(blockIndex) || rest.startsWith(`${blockIndex}&`);
}

function compiledRuleSelectors(css: string, block: StyleBlockIdentity): string[] {
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
      { cause },
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

interface StyleBlockIdentity {
  readonly file: string;
  readonly blockIndex: number;
}

function blockRejection(expected: string, observed: string): AdapterError {
  return stylesJoinRejected(SEAM_JOIN_BLOCK, expected, observed);
}

function rulesRejection(expected: string, observed: string): AdapterError {
  return stylesJoinRejected(SEAM_JOIN_RULES, expected, observed);
}

/**
 * The join's rejection constructor — the adapter's seam idiom (#225):
 * `{seam, seamClass, expected, observed}` with structural descriptions,
 * never values. Shared by the join's modules so every rejection the
 * styles surface can throw carries the same closed shape.
 */
export function stylesJoinRejected(
  seam: string,
  expected: string,
  observed: string,
  extra?: { readonly cause?: unknown },
): AdapterError {
  const details: AdapterErrorDetails = {
    seam,
    seamClass: 'fail-closed private',
    expected,
    observed,
  };
  return new AdapterError(
    'seam-rejected',
    `AstroProjectAdapter seam rejection at ${seam}: expected ${expected}; observed ${observed}`,
    details,
    { cause: extra?.cause },
  );
}
