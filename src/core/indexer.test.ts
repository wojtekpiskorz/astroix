import { describe, expect, it } from 'vitest';
import { buildCssIndex, type SourceFile } from './indexer';

const homeCss = `.hero {
  display: grid;
  gap: 1rem;
}

.hero-title {
  margin: 0;
  font-size: 3rem;
}

@media (max-width: 640px) {
  .hero-title {
    font-size: 2rem;
  }
}
`;

const pageAstro = `---
const x = 1;
---
<h1 class="hero-title">x</h1>
<style>
  .hero-title {
    color: #1e293b;
  }
</style>
<style is:global>
  .hero-lead { color: #475569; }
</style>
<style is:inline>
  .hero-cta { color: #0f172a; }
</style>
<style>
  .hero-title { font-weight: 800; }
</style>
`;

describe('buildCssIndex — global css files', () => {
  it('records rules with file, range and media condition', () => {
    const index = buildCssIndex([{ file: 'src/pages/home.css', contents: homeCss }]);

    expect(index.map((r) => r.selector)).toEqual(['.hero', '.hero-title', '.hero-title']);
    expect(index.every((r) => r.file === 'src/pages/home.css')).toBe(true);
    expect(index.map((r) => r.media)).toEqual([null, null, '(max-width: 640px)']);
    expect(index.every((r) => r.scoped === false && r.styleBlockIndex === null)).toBe(true);
    // lines are one-based and point at each rule's selector line
    expect(index.map((r) => r.line)).toEqual([1, 6, 12]);
  });

  it('ranges slice the exact rule text out of the source file', () => {
    const index = buildCssIndex([{ file: 'home.css', contents: homeCss }]);

    for (const rule of index) {
      const text = homeCss.slice(rule.range.start, rule.range.end);
      expect(text.startsWith(rule.selector)).toBe(true);
      expect(text.endsWith('}')).toBe(true);
    }
    const hero = index.find((r) => r.selector === '.hero');
    expect(hero && homeCss.slice(hero.range.start, hero.range.end)).toBe(
      '.hero {\n  display: grid;\n  gap: 1rem;\n}',
    );
  });

  it('preserves selector text verbatim from source', () => {
    const css = `.hero , .x {\n  color: red;\n}\n`;
    const [rule] = buildCssIndex([{ file: 'a.css', contents: css }]);
    expect(rule?.selector).toBe('.hero , .x');
  });
});

describe('buildCssIndex — .astro style blocks', () => {
  it('flags scoped rules and points ranges into the source file', () => {
    const index = buildCssIndex([{ file: 'src/pages/index.astro', contents: pageAstro }]);
    const scoped = index.filter((r) => r.selector === '.hero-title');

    expect(scoped).toHaveLength(2);
    expect(scoped.every((r) => r.scoped)).toBe(true);
    expect(scoped.map((r) => r.line)).toEqual([6, 17]);
    for (const rule of scoped) {
      const text = pageAstro.slice(rule.range.start, rule.range.end);
      expect(text.startsWith('.hero-title')).toBe(true);
      expect(text.endsWith('}')).toBe(true);
    }
  });

  it('carries the module-graph style-block index and skips is:global scoping', () => {
    const index = buildCssIndex([{ file: 'index.astro', contents: pageAstro }]);

    const [lead] = index.filter((r) => r.selector === '.hero-lead');
    expect(lead?.scoped).toBe(false);
    expect(lead?.styleBlockIndex).toBe(1);

    const titleRules = index.filter((r) => r.selector === '.hero-title');
    expect(titleRules.map((r) => r.styleBlockIndex)).toEqual([0, 2]);
  });

  it('sees is:inline style blocks — edit-truth lives in the sources', () => {
    const index = buildCssIndex([{ file: 'index.astro', contents: pageAstro }]);

    const [cta] = index.filter((r) => r.selector === '.hero-cta');
    expect(cta).toBeDefined();
    expect(cta?.scoped).toBe(false);
    expect(cta?.styleBlockIndex).toBeNull();
    expect(cta && pageAstro.slice(cta.range.start, cta.range.end)).toBe(
      '.hero-cta { color: #0f172a; }',
    );
  });
});

describe('buildCssIndex — input contract', () => {
  it('ignores files that are neither .css nor .astro', () => {
    const sources: SourceFile[] = [
      {
        file: 'src/content/homepage/index.md',
        contents: '# hi\n\n<style>.x { color: red; }</style>',
      },
    ];
    expect(buildCssIndex(sources)).toEqual([]);
  });

  it('indexes multiple files in input order', () => {
    const index = buildCssIndex([
      { file: 'b.css', contents: '.b { top: 0; }' },
      { file: 'a.astro', contents: '<style>.a { top: 0; }</style>' },
    ]);
    expect(index.map((r) => r.file)).toEqual(['b.css', 'a.astro']);
  });
});
