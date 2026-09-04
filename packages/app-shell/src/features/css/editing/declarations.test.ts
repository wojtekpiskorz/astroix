import { describe, expect, it } from 'vitest';
import { editFixture } from '../../../presentation/fixtures.ts';
import { declarationText, parseRule, selectorHeadBounds } from './declarations.ts';

/**
 * The declaration parser's units (#250, I2): the exact bounds the
 * splice planner lifts into file space — pinned against the frozen
 * corpus's own rule shapes (the global sheet's doubly-written
 * selector, the media-conditioned record that over-covers its
 * at-rule, and the scoped block) plus the fail-closed refusals.
 */

const cssSplice = editFixture('css-splice.json');
const cssScoped = editFixture('css-scoped-splice.json');

/** The edited rule's pre-write text — the second `.hero-title` in the global sheet. */
const RULE_TEXT = '.hero-title {\n  margin: 0;\n  font-size: 3rem;\n  letter-spacing: -0.02em;\n}';

describe('parseRule — the flat declaration list', () => {
  it('parses the selector and every declaration with exact bounds', () => {
    const parsed = parseRule(`${RULE_TEXT}\n\n`);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.selector).toBe('.hero-title');
    expect(parsed.declarations.map((d) => d.property)).toEqual([
      'margin',
      'font-size',
      'letter-spacing',
    ]);
    // the frozen splice range is the declaration's own text: the
    // rule starts at 101 in the file, `font-size: 3rem;` at 130
    const font = parsed.declarations.find((d) => d.property === 'font-size');
    expect(font?.text).toBe('font-size: 3rem;');
    expect(font?.value).toBe('3rem');
    expect(101 + (font?.start ?? -1)).toBe(130);
    expect(101 + (font?.end ?? -1)).toBe(146);
  });

  it('closes the body at the rule\u2019s own brace — a media record that over-covers its at-rule parses', () => {
    // the corpus's media record shape: the inner rule plus the
    // at-rule's closing brace and newline inside the range
    const mediaText = '.hero-title {\n    font-size: 2rem;\n  }\n}';
    const parsed = parseRule(mediaText);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.selector).toBe('.hero-title');
    expect(parsed.declarations).toHaveLength(1);
    expect(parsed.declarations[0]?.text).toBe('font-size: 2rem;');
  });

  it('parses the scoped block\u2019s rule from the fixture baseline', () => {
    // the scoped record [533,570) over the fixture baseline
    const text = cssScoped.baseline.contents.slice(533, 570);
    expect(text.startsWith('.hero-title')).toBe(true);
    const parsed = parseRule(text);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.declarations.map((d) => `${d.property}: ${d.value}`)).toEqual(['color: #1e293b']);
  });

  it('keeps a final declaration without a trailing semicolon honest', () => {
    const parsed = parseRule('.x { color: red }');
    expect(parsed?.declarations[0]?.text).toBe('color: red');
    expect(parsed?.declarations[0]?.end).toBe('.x { color: red'.length);
  });

  it('refuses a nested block — read-only truth for the pre-alpha', () => {
    expect(parseRule('@media print { .x { color: red } }')).toBeNull();
  });

  it('refuses shape garbage — no head, no braces, reversed braces', () => {
    expect(parseRule('{ color: red }')).toBeNull();
    expect(parseRule('.x color: red')).toBeNull();
    expect(parseRule('}.x{')).toBeNull();
  });
});

describe('selectorHeadBounds — the rename splice\u2019s target', () => {
  it('bounds the trimmed head inside the rule text', () => {
    expect(selectorHeadBounds(RULE_TEXT)).toEqual({ start: 0, end: 11 });
    expect(selectorHeadBounds('  .hero-title {color:red}')).toEqual({ start: 2, end: 13 });
    expect(selectorHeadBounds('no brace')).toBeNull();
  });
});

describe('declarationText — the frozen serialization species', () => {
  it('composes the corpus\u2019s own shape', () => {
    expect(declarationText('font-size', '3.5rem')).toBe(cssSplice.edit.replacement);
  });
});
