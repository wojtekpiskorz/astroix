import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { extractStylesSync } from '@astrojs/compiler-binding';
import postcss from 'postcss';

const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

export async function buildStaticIndex(projectRoot) {
  const files = await collectFiles(join(projectRoot, 'src'));
  const records = [];
  for (const file of files) {
    const contents = await readFile(file, 'utf8');
    const projectFile = relative(projectRoot, file).split(sep).join('/');
    const indexed = file.endsWith('.css')
      ? indexStylesheet(projectFile, contents, {
          baseOffset: 0,
          scoped: false,
          styleBlockIndex: null,
        })
      : indexAstroSource(projectFile, contents);
    for (const record of indexed) {
      records.push({ ...record, line: lineAt(contents, record.range.start) });
    }
  }
  return records;
}

export function joinEffectiveSelectors(records, cssEntries, options = {}) {
  const requiredScopedFiles = new Set(options.requiredScopedFiles ?? []);
  const payload = records.map((record) => ({ ...record, effectiveSelector: null }));
  const blocks = new Map();
  payload.forEach((record, position) => {
    if (!record.scoped || record.styleBlockIndex === null) return;
    const key = `${record.file}\0${record.styleBlockIndex}`;
    const block = blocks.get(key) ?? { positions: [], record };
    block.positions.push(position);
    blocks.set(key, block);
  });

  for (const block of blocks.values()) {
    const token = `${block.record.file}?astro&type=style&index=${block.record.styleBlockIndex}`;
    const entry = cssEntries.find((candidate) => normalizedId(candidate.id).includes(token));
    if (!entry) {
      if (requiredScopedFiles.has(block.record.file)) {
        throw new Error(
          `AstroProjectAdapter private seam rejection: active route CSS module is absent for ${block.record.file} style block ${block.record.styleBlockIndex}`,
        );
      }
      continue;
    }
    const selectors = selectorsOf(entry.content);
    if (selectors.length !== block.positions.length) {
      throw new Error(
        `AstroProjectAdapter private seam rejection: compiled CSS rule count ${selectors.length} does not match static scoped rule count ${block.positions.length} for ${block.record.file} style block ${block.record.styleBlockIndex}`,
      );
    }
    block.positions.forEach((position, index) => {
      const effectiveSelector = selectors[index];
      const record = payload[position];
      if (sourceSelectorOf(effectiveSelector) !== normalizedSelector(record.selector)) {
        throw new Error(
          `AstroProjectAdapter private seam rejection: compiled selector ${effectiveSelector} does not preserve source selector ${record.selector} at rule ${index} for ${record.file} style block ${record.styleBlockIndex}`,
        );
      }
      record.effectiveSelector = effectiveSelector;
    });
  }
  return payload;
}

export function indexAstroSource(file, source, processed = extractStylesSync(source)) {
  if (!Array.isArray(processed)) {
    throw new Error(
      `AstroProjectAdapter private seam rejection: compiler style extraction is not an array for ${file}`,
    );
  }
  const records = [];
  let next = 0;
  let rawBlockIndex = 0;
  for (const match of source.matchAll(STYLE_TAG)) {
    const content = match[1];
    if (content === undefined) continue;
    const openTag = match[0].slice(0, match[0].indexOf('>') + 1);
    const contentStart = match.index + openTag.length;
    if (compilerSkips(openTag)) {
      records.push(
        ...indexStylesheet(file, content, {
          baseOffset: contentStart,
          scoped: false,
          styleBlockIndex: null,
        }),
      );
      rawBlockIndex += 1;
      continue;
    }

    const compilerBlock = processed[next];
    assertCompilerBlock(compilerBlock, { file, next, rawBlockIndex });
    if (compilerBlock.content !== content) {
      throw new Error(
        `AstroProjectAdapter private seam rejection: compiler style block ${next} does not match raw style block ${rawBlockIndex} in ${file}`,
      );
    }
    records.push(
      ...indexStylesheet(file, content, {
        baseOffset: contentStart,
        scoped: compilerBlock.attrs['is:global'] === undefined,
        styleBlockIndex: compilerBlock.index,
      }),
    );
    next += 1;
    rawBlockIndex += 1;
  }
  if (next !== processed.length) {
    const remaining = processed.length - next;
    throw new Error(
      `AstroProjectAdapter private seam rejection: ${remaining} compiler style ${remaining === 1 ? 'block remained' : 'blocks remained'} uncorrelated in ${file}`,
    );
  }
  return records;
}

function compilerSkips(openTag) {
  return /\bis:inline(?:\s|=|\/?>)/.test(openTag) || openTag.includes('{');
}

function assertCompilerBlock(block, context) {
  if (!block || typeof block !== 'object') {
    throw new Error(
      `AstroProjectAdapter private seam rejection: compiler style block ${context.next} is absent for raw style block ${context.rawBlockIndex} in ${context.file}`,
    );
  }
  if (
    typeof block.content !== 'string' ||
    !Number.isSafeInteger(block.index) ||
    block.index < 0 ||
    block.index !== context.next ||
    !block.attrs ||
    typeof block.attrs !== 'object' ||
    Array.isArray(block.attrs)
  ) {
    throw new Error(
      `AstroProjectAdapter private seam rejection: compiler style block ${context.next} has an unsupported shape in ${context.file}`,
    );
  }
}

function indexStylesheet(file, css, meta) {
  const records = [];
  postcss.parse(css).walkRules((rule) => {
    const start = rule.source?.start;
    const end = rule.source?.end;
    if (!start || !end) return;
    records.push({
      file,
      line: 0,
      media: nearestMedia(rule),
      range: { end: end.offset + meta.baseOffset, start: start.offset + meta.baseOffset },
      scoped: meta.scoped,
      selector: rule.selector,
      styleBlockIndex: meta.styleBlockIndex,
    });
  });
  return records;
}

function selectorsOf(css) {
  const selectors = [];
  postcss.parse(css).walkRules((rule) => selectors.push(rule.selector));
  return selectors;
}

function sourceSelectorOf(effectiveSelector) {
  return normalizedSelector(
    effectiveSelector
      .replaceAll(/:where\(\[data-astro-cid-[a-z0-9]+\]\)/g, '')
      .replaceAll(/\[data-astro-cid-[a-z0-9]+\]/g, '')
      .replaceAll(/:where\(\.astro-[a-z0-9]+\)/g, ''),
  );
}

function normalizedSelector(selector) {
  return selector.replaceAll(/\s+/g, ' ').trim();
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.name.endsWith('.astro') || entry.name.endsWith('.css')) files.push(path);
  }
  return files.sort();
}

function lineAt(contents, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < contents.length; index += 1) {
    if (contents[index] === '\n') line += 1;
  }
  return line;
}

function nearestMedia(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name === 'media') return parent.params;
  }
  return null;
}

function normalizedId(id) {
  return id.replaceAll('\\', '/').replaceAll(/\/{2,}/g, '/');
}
