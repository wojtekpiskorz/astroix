import { describe, expect, it } from 'vitest';
import type { SourceFile } from '../core/indexer';
import { buildIndexPayload, compiledSelectors, extractCssFromModuleCode } from './rest';

const pageAstro = `<h1 class="hero-title">x</h1>
<style>
  .hero-title { color: #1e293b; }
  .hero-lead { color: #475569; }
</style>
<style>
  .hero-cta { color: #0f172a; }
</style>
`;

const homeCss = '.hero { display: grid; }\n.hero-title { font-weight: 800; }\n';

const sources: SourceFile[] = [
  { file: '/proj/src/pages/home.css', contents: homeCss },
  { file: '/proj/src/pages/index.astro', contents: pageAstro },
];

describe('buildIndexPayload — the module-graph join', () => {
  it('joins effective selectors in rule order for scoped blocks', async () => {
    const payload = await buildIndexPayload(sources, (_file, blockIndex) =>
      blockIndex === 0
        ? Promise.resolve(
            '.hero-title[data-astro-cid-abc] { color: #1e293b; }\n.hero-lead[data-astro-cid-abc] { color: #475569; }',
          )
        : Promise.resolve('.hero-cta[data-astro-cid-xyz] { color: #0f172a; }'),
    );

    const scoped = payload.filter((record) => record.scoped);
    expect(scoped.map((record) => record.effectiveSelector)).toEqual([
      '.hero-title[data-astro-cid-abc]',
      '.hero-lead[data-astro-cid-abc]',
      '.hero-cta[data-astro-cid-xyz]',
    ]);
    expect(scoped.every((record) => record.file === '/proj/src/pages/index.astro')).toBe(true);
  });

  it('lists scoped records without an effective selector when the module is absent (liveness, v1)', async () => {
    const payload = await buildIndexPayload(sources, () => Promise.resolve(null));

    const scoped = payload.filter((record) => record.scoped);
    expect(scoped).toHaveLength(3);
    expect(scoped.every((record) => record.effectiveSelector === null)).toBe(true);
  });

  it('leaves global records without an effective selector', async () => {
    const payload = await buildIndexPayload(sources, () => Promise.resolve(null));
    const global = payload.filter((record) => !record.scoped);
    expect(global.map((record) => record.selector)).toEqual(['.hero', '.hero-title']);
    expect(global.every((record) => record.effectiveSelector === null)).toBe(true);
  });

  it('leaves extra records unjoined when the compiled rule count mismatches', async () => {
    const payload = await buildIndexPayload(sources, (_file, blockIndex) =>
      blockIndex === 0
        ? Promise.resolve('.hero-title[data-astro-cid-abc] { color: #1e293b; }')
        : Promise.resolve(null),
    );

    const scoped = payload.filter((record) => record.scoped);
    expect(scoped[0]?.effectiveSelector).toBe('.hero-title[data-astro-cid-abc]');
    expect(scoped[1]?.effectiveSelector).toBeNull();
  });
});

describe('compiledSelectors', () => {
  it('returns selectors in rule order across at-rules', () => {
    expect(
      compiledSelectors(
        '.a { top: 0; }\n@media (max-width: 640px) { .b { top: 1; } .c { top: 2; } }',
      ),
    ).toEqual(['.a', '.b', '.c']);
  });
});

describe('extractCssFromModuleCode', () => {
  it('pulls the css literal out of a dev-transformed css module', () => {
    const code = `const __vite__css = ".hero-title[data-astro-cid-x] {\\n  color: #1e293b;\\n}\\n"\n__vite__updateStyle(__vite__id, __vite__css)`;
    expect(extractCssFromModuleCode(code)).toBe(
      '.hero-title[data-astro-cid-x] {\n  color: #1e293b;\n}\n',
    );
  });

  it('returns null when the module code carries no css literal', () => {
    expect(extractCssFromModuleCode('export {}')).toBeNull();
  });
});
