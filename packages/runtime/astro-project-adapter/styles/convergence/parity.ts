import type { CssRuleRecord } from '@wojciechpiskorz/astroix-core';
import postcss from 'postcss';
import type { CompiledStyleModule, EffectiveSelectorRecord } from '../join/effective-selector-join';
import { STYLE_BLOCK_TOKEN, stylesJoinRejected } from '../join/effective-selector-join';

/**
 * The convergence layer's pure parity core (#227, extending the #226 join's
 * correspondence checks): disk source truth (the static index — the edit
 * truth) and transformed graph truth (the client environment's compiled
 * scoped-style modules) are two observations of one world, and after a
 * watcher invalidation the first can advance before the second (the B2
 * lesson, #217: some platforms' vite watchers never re-serve the
 * transformed style module, so watcher liveness NEVER implies
 * convergence). This module verifies parity per pass and classifies the
 * disagreement, so the convergence protocol can reject a torn world
 * instead of serving or synthesizing it — a transient mismatch can never
 * silently downgrade selector or source-range accuracy.
 *
 * The mismatch categories (#227 AC): `compiler-source` (the compiled form
 * breaks the compiler↔source correspondence itself — CSS that does not
 * parse, or a scoped rule whose compiled selector carries no scope
 * token), `module-presence` (a scoped block that must be loaded on the
 * route has no compiled module), `rule-count` (a correlated block's
 * compiled rule count disagrees with its static count), `order` (the same
 * selector multiset in a different sequence — positional pairing cannot
 * hold), and `selector-identity` (a compiled selector with no source
 * counterpart — one truth advanced past the other). All five reject; none
 * is ever served.
 *
 * The block correlation here mirrors the join's certified keying
 * (`indexStyleBlockModules` in `effective-selector-join.ts`, #226): blocks
 * group by `(file, style block)` on the static side, and a compiled
 * module correlates with the longest block file its id carries at a path
 * boundary. The join re-runs its own correspondence after this verifier
 * passes, so a correlation drift between the two walks surfaces as the
 * join's fail-closed rejection — never as silently wrong data.
 */

/** The closed mismatch category set — every styles divergence is one of these or a seam rejection. */
export const STYLES_MISMATCH_CATEGORIES = [
  'compiler-source',
  'module-presence',
  'rule-count',
  'order',
  'selector-identity',
] as const;

export type StylesMismatchCategory = (typeof STYLES_MISMATCH_CATEGORIES)[number];

/** One classified parity disagreement — structural descriptions, never content dumps. */
export interface StylesMismatch {
  readonly category: StylesMismatchCategory;
  readonly expected: string;
  readonly observed: string;
  /** The static scoped block the disagreement was found in (project-relative file). */
  readonly block?: { readonly file: string; readonly blockIndex: number };
  /** The upstream rejection when the mismatch wraps one (kept for the runtime plane's logs). */
  readonly cause?: unknown;
}

/** Parity options: which files' scoped blocks must be loaded on the route. */
export interface ParityOptions {
  /**
   * Files whose scoped blocks MUST have compiled modules — the active
   * route's own component. Absence is a `module-presence` mismatch,
   * never a null join.
   */
  readonly requiredScopedFiles?: readonly string[];
}

/** One static scoped block: the `(file, style block)` group and its records, in source order. */
interface ScopedBlock {
  readonly file: string;
  readonly blockIndex: number;
  readonly records: CssRuleRecord[];
}

/**
 * Verifies parity between the static index and the compiled scoped-style
 * modules: every scoped block that must be loaded on the route has its
 * module, and each correlated block's compiled rules reduce to its source
 * rules by count, order, and selector identity, each carrying the
 * compiler's scope token. Returns the classified mismatch, or null when
 * the two truths agree.
 */
export function verifyStylesParity(
  staticRecords: readonly CssRuleRecord[],
  compiledModules: readonly CompiledStyleModule[],
  options: ParityOptions = {},
): StylesMismatch | null {
  const requiredScopedFiles = new Set(options.requiredScopedFiles ?? []);
  const blocks = groupScopedBlocks(staticRecords);
  const modulesByBlock = indexStyleBlockModules(compiledModules, blocks);
  const filesOnRoute = new Set(
    [...modulesByBlock.keys()].map((key) => key.slice(0, key.lastIndexOf('\0'))),
  );
  for (const block of blocks.values()) {
    const module = modulesByBlock.get(blockKey(block.file, block.blockIndex));
    if (module === undefined) {
      if (requiredScopedFiles.has(block.file) || filesOnRoute.has(block.file)) {
        return mismatch('module-presence', block, {
          expected: `a compiled module for block ${block.blockIndex} of ${block.file} (the route's scoped CSS set)`,
          observed: 'no compiled module for that block in the route CSS set',
        });
      }
      continue; // not loaded on this route — the null join is contract shape
    }
    const verified = verifyBlockParity(block, module);
    if (verified !== null) return verified;
  }
  return null;
}

/**
 * Verifies one correlated block: the compiled CSS parses, every compiled
 * selector carries the compiler's scope token, and the stripped compiled
 * selector sequence matches the source sequence — count, order, identity.
 */
function verifyBlockParity(block: ScopedBlock, module: CompiledStyleModule): StylesMismatch | null {
  const selectors = compiledRuleSelectors(module.compiledCss);
  if (selectors === null) {
    return mismatch('compiler-source', block, {
      expected: `parseable CSS rules in the compiled module for block ${block.blockIndex} of ${block.file}`,
      observed: 'compiled CSS that does not parse as a stylesheet',
    });
  }
  for (const [index, selector] of selectors.entries()) {
    if (!SCOPE_TOKEN.test(selector)) {
      return mismatch('compiler-source', block, {
        expected: `compiled rule ${index} of block ${block.blockIndex} of ${block.file} to carry the compiler's scope token`,
        observed: 'a compiled selector that carries no scope token for a scoped rule',
      });
    }
  }
  if (selectors.length !== block.records.length) {
    return mismatch('rule-count', block, {
      expected: `${block.records.length} compiled rules for block ${block.blockIndex} of ${block.file} (the static rule count)`,
      observed: `a compiled rule count of ${selectors.length}`,
    });
  }
  const compiledSequence = selectors.map((selector) => sourceSelectorOf(selector));
  const sourceSequence = block.records.map((record) => normalizedSelector(record.selector));
  if (!sequencesEqual(compiledSequence, sourceSequence)) {
    // Equal counts proven above: either the same rules in a different
    // order (positional pairing cannot hold — but no truth advanced), or a
    // selector with no counterpart on the other side (one truth moved).
    const category: StylesMismatchCategory = multisetsEqual(compiledSequence, sourceSequence)
      ? 'order'
      : 'selector-identity';
    return mismatch(category, block, {
      expected: `block ${block.blockIndex} of ${block.file} to pair its rules positionally (compiled selectors reducing to the source sequence)`,
      observed:
        category === 'order'
          ? 'the same selectors in a different order on the two sides'
          : 'a compiled selector with no source counterpart (one truth advanced past the other)',
    });
  }
  return null;
}

/**
 * Verifies the joined payload did not downgrade against the parity it was
 * built from (#227 AC: a transient mismatch can never silently downgrade
 * selector or source-range accuracy): every static record survives
 * verbatim with its source fields, and the effective selector is present
 * exactly where parity proved a compiled module, carrying the scope
 * token. A break here is an invariant break between this verifier and
 * the join — a fail-closed seam rejection, never a transient mismatch.
 */
export function verifyJoinedPayload(
  staticRecords: readonly CssRuleRecord[],
  compiledModules: readonly CompiledStyleModule[],
  joined: readonly EffectiveSelectorRecord[],
): void {
  const downgrade = joinedPayloadMismatch(staticRecords, compiledModules, joined);
  if (downgrade !== null) {
    throw stylesJoinRejected(
      'styles convergence payload correspondence (joined records ↔ static index parity)',
      downgrade.expected,
      downgrade.observed,
    );
  }
}

function joinedPayloadMismatch(
  staticRecords: readonly CssRuleRecord[],
  compiledModules: readonly CompiledStyleModule[],
  joined: readonly EffectiveSelectorRecord[],
): { expected: string; observed: string } | null {
  if (joined.length !== staticRecords.length) {
    return {
      expected: `the joined payload to carry every static record (${staticRecords.length})`,
      observed: `a joined record count of ${joined.length}`,
    };
  }
  const blocksWithModules = blockKeysWithModules(compiledModules, groupScopedBlocks(staticRecords));
  for (const [record, joinedRecord] of pairPositional(staticRecords, joined)) {
    if (!sourceFieldsEqual(record, joinedRecord)) {
      return {
        expected: `joined record for ${record.selector} of ${record.file} to carry its static source fields verbatim (selector, range, line, media, scoped, block)`,
        observed: 'a joined record whose source-side fields differ from the static index',
      };
    }
    const blockKeyOfRecord =
      record.scoped && record.styleBlockIndex !== null
        ? blockKey(record.file, record.styleBlockIndex)
        : null;
    const mustJoin = blockKeyOfRecord !== null && blocksWithModules.has(blockKeyOfRecord);
    if (
      mustJoin &&
      (joinedRecord.effectiveSelector === null || !SCOPE_TOKEN.test(joinedRecord.effectiveSelector))
    ) {
      return {
        expected: `a compiler-derived effective selector (scope token intact) for ${record.selector} of ${record.file}, which parity proved loaded on the route`,
        observed: 'a null or unscoped effective selector where parity proved a compiled module',
      };
    }
    if (!mustJoin && joinedRecord.effectiveSelector !== null) {
      return {
        expected: `a null effective selector for ${record.selector} of ${record.file}, whose block has no compiled module on the route`,
        observed: 'an effective selector where no compiled module exists to derive it from',
      };
    }
  }
  return null;
}

function sourceFieldsEqual(record: CssRuleRecord, joined: EffectiveSelectorRecord): boolean {
  return (
    record.selector === joined.selector &&
    record.file === joined.file &&
    record.range.start === joined.range.start &&
    record.range.end === joined.range.end &&
    record.line === joined.line &&
    record.media === joined.media &&
    record.scoped === joined.scoped &&
    record.styleBlockIndex === joined.styleBlockIndex
  );
}

/** The static blocks that have compiled modules on the route — the must-join set. */
function blockKeysWithModules(
  compiledModules: readonly CompiledStyleModule[],
  blocks: Map<string, ScopedBlock>,
): Set<string> {
  return new Set(indexStyleBlockModules(compiledModules, blocks).keys());
}

/** The block map key — `file` cannot contain `\0`, so the split is unambiguous. */
function blockKey(file: string, blockIndex: number): string {
  return `${file}\0${blockIndex}`;
}

function groupScopedBlocks(records: readonly CssRuleRecord[]): Map<string, ScopedBlock> {
  const blocks = new Map<string, ScopedBlock>();
  for (const record of records) {
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
 * Indexes compiled modules by their static style block — the join's
 * certified keying (#226), mirrored here because the classifier must
 * correlate at the same granularity the join does: a module correlates
 * with the LONGEST block file its id carries at a path boundary, and the
 * block index must end at the id or at the next query parameter.
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
 * The compiled selectors of one module's CSS, or null when it does not
 * parse — the compiler/source correspondence itself is broken.
 */
function compiledRuleSelectors(css: string): string[] | null {
  const selectors: string[] = [];
  try {
    postcss.parse(css).walkRules((rule) => {
      selectors.push(rule.selector);
    });
  } catch {
    return null;
  }
  return selectors;
}

/**
 * The compiler's scope token (the certification-proven form, #225/#226):
 * the attribute strategy's `[data-astro-cid-*]` or the where strategy's
 * `.astro-*` class.
 */
const SCOPE_TOKEN = /\[data-astro-cid-[a-z0-9]+\]|\.astro-[a-z0-9]+/;

/**
 * Reduces a compiled selector to its source form — the verification
 * direction ONLY. The strip set is the certification-proven one, mirrored
 * from the join: `:where([data-astro-cid-*])`, bare `[data-astro-cid-*]`,
 * and `:where(.astro-*)`.
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

function sequencesEqual(left: readonly string[], right: readonly string[]): boolean {
  for (const [leftValue, rightValue] of pairPositional(left, right)) {
    if (leftValue !== rightValue) return false;
  }
  return true;
}

/** Multiset equality by code-unit sort — equal counts proven by the caller. */
function multisetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return sequencesEqual(leftSorted, rightSorted);
}

function mismatch(
  category: StylesMismatchCategory,
  block: ScopedBlock,
  descriptions: { expected: string; observed: string },
): StylesMismatch {
  return {
    category,
    expected: descriptions.expected,
    observed: descriptions.observed,
    block: { file: block.file, blockIndex: block.blockIndex },
  };
}

/**
 * Pairs two dense arrays positionally. Iterator values only — never
 * indexed lookups — so pairing equal-length arrays needs no
 * element-existence re-checks.
 */
function* pairPositional<T, U>(left: readonly T[], right: readonly U[]): Generator<[T, U]> {
  const leftValues = left.values();
  const rightValues = right.values();
  for (;;) {
    const leftNext = leftValues.next();
    const rightNext = rightValues.next();
    if (leftNext.done === true || rightNext.done === true) return;
    yield [leftNext.value, rightNext.value];
  }
}
