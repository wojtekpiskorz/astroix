import { describe, expect, it } from 'vitest';
import { appendRule, type SpliceEdit, SpliceRangeError, spliceText } from './splice-writer';

const css = `.hero {
  display: grid;
}

.hero-title {
  margin: 0;
}
`;

describe('spliceText', () => {
  it('replaces an exact range leaving every byte outside it identical', () => {
    const start = css.indexOf('margin: 0;');
    const edit: SpliceEdit = {
      start,
      end: start + 'margin: 0;'.length,
      replacement: 'margin: 4rem;',
    };
    const out = spliceText(css, edit);

    expect(out).toBe(css.replace('margin: 0;', 'margin: 4rem;'));
    expect(out.slice(0, edit.start)).toBe(css.slice(0, edit.start));
    expect(out.slice(edit.start + edit.replacement.length)).toBe(css.slice(edit.end));
  });

  it('replaces a whole rule keeping surrounding rules byte-identical', () => {
    const ruleText = '.hero {\n  display: grid;\n}';
    const start = css.indexOf(ruleText);
    const out = spliceText(css, {
      start,
      end: start + ruleText.length,
      replacement: '.hero {\n  display: flex;\n  gap: 2rem;\n}',
    });

    expect(out.startsWith('.hero {\n  display: flex;\n')).toBe(true);
    expect(out.endsWith('}\n\n.hero-title {\n  margin: 0;\n}\n')).toBe(true);
  });

  it('inserts purely on a zero-length range at a block boundary', () => {
    const at = css.indexOf('  margin: 0;');
    const out = spliceText(css, { start: at, end: at, replacement: '  font-weight: 800;\n' });

    expect(out).toContain('  font-weight: 800;\n  margin: 0;');
  });

  it('throws SpliceRangeError on invalid ranges — no partial output', () => {
    expect(() => spliceText(css, { start: 0, end: css.length + 1, replacement: 'x' })).toThrowError(
      SpliceRangeError,
    );
    expect(() => spliceText(css, { start: -1, end: 3, replacement: 'x' })).toThrowError(
      SpliceRangeError,
    );
    expect(() => spliceText(css, { start: 5, end: 3, replacement: 'x' })).toThrowError(
      SpliceRangeError,
    );
    expect(() => spliceText(css, { start: 0.5, end: 3, replacement: 'x' })).toThrowError(
      SpliceRangeError,
    );
  });
});

describe('appendRule', () => {
  it('adds exactly one line when the original lacks a trailing newline', () => {
    expect(appendRule('.a {}', '.b { color: red; }')).toBe('.a {}\n.b { color: red; }');
  });

  it('keeps the trailing-newline convention when the original ends with one', () => {
    expect(appendRule('.a {}\n', '.b { color: red; }')).toBe('.a {}\n.b { color: red; }\n');
  });

  it('returns the rule alone for empty content', () => {
    expect(appendRule('', '.b { color: red; }')).toBe('.b { color: red; }');
  });
});
